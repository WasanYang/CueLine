// Live mode: section pads, click track and spoken section cues.
//
// The song and the click run on one AudioContext clock. Song position is tracked
// as a list of anchors {ctx, pos}: "at context time ctx the song is at pos". A jump
// adds an anchor at the exact context time of the next bar line (or section end),
// starts a new buffer source there and fades the old one out, so jumps and loops
// land on the beat. Clicks are scheduled a little ahead from the beat grid.

const $ = (s) => document.querySelector(s);
const LOOKAHEAD = 0.2; // seconds of audio scheduled ahead
const TICK_MS = 25;
const FADE = 0.004;
const css = getComputedStyle(document.documentElement);
const groupColor = (g, a = 1) => {
  const hex = css.getPropertyValue(`--g${(g.charCodeAt(0) - 65) % 10}`).trim();
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const fmt = (t) => {
  t = Math.max(0, t);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
};

let ctx = null, songGain, clickGain, guideGain;
// Samples from the local cues/ folder (git-ignored; see README). name -> AudioBuffer
const cues = { buf: {}, click: {} };

// Section base name (lowercase, no spaces/dashes) -> cue sample name.
const CUE_MAP = {
  intro: "intro", verse: "verse", v: "verse", prechorus: "prechorus", pre: "prechorus",
  chorus: "chorus", c: "chorus", hook: "chorus", "ฮุก": "chorus", "ฮุค": "chorus",
  bridge: "bridge", b: "bridge", solo: "solo",
  instrumental: "instrumental", inst: "instrumental", interlude: "instrumental",
  midtro: "turn", turn: "turn", turnaround: "turn",
  break: "break", breakdown: "break", outro: "outro", end: "end", ending: "end",
  tag: "tag", keychange: "keychange", acapella: "acapella", band: "band", riff: "riff",
};
const song = { id: null, data: null, buffer: null, sections: [], grid: [], bars: [], meter: 4, duration: 0 };
const play = {
  playing: false,
  pausedPos: 0,
  anchors: [], // {ctx, pos}
  sources: [], // {src, gain, start, end}
  clicks: [], // {node, t}
  cueNodes: [], // {node, t}
  cueKey: "", // boundary the guide cues were scheduled for
  schedCtx: 0,
  pending: null, // {ctx, idx, src, prev, loop}
  countInUntil: 0,
  timer: null,
  spoken: "",
};

function audio() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    songGain = ctx.createGain();
    clickGain = ctx.createGain();
    guideGain = ctx.createGain();
    songGain.connect(ctx.destination);
    clickGain.connect(ctx.destination);
    guideGain.connect(ctx.destination);
    applyMix();
  }
  return ctx;
}

// ---------- position helpers ----------
const lowerBound = (arr, x) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
};
function anchorAt(t) {
  let a = play.anchors[0];
  for (const x of play.anchors) if (x.ctx <= t + 1e-9) a = x;
  return a;
}
function posAt(t) {
  const a = anchorAt(t);
  return a ? a.pos + (t - a.ctx) : play.pausedPos;
}
const now = () => (play.playing ? posAt(ctx.currentTime) : play.pausedPos);
/** Context time at which the current (latest) anchor reaches song position p. */
function ctxOf(p) {
  const a = play.anchors[play.anchors.length - 1];
  return a.ctx + (p - a.pos);
}
function sectionAt(p) {
  const s = song.sections;
  for (let i = s.length - 1; i >= 0; i--) if (p >= s[i].start - 1e-3) return i;
  return 0;
}
function barAt(p) { return Math.max(0, lowerBound(song.bars, p + 1e-3) - 1); }
function beatLen(p) {
  const i = Math.min(Math.max(lowerBound(song.grid, p), 1), song.grid.length - 1);
  return song.grid[i] - song.grid[i - 1];
}

// ---------- sound ----------
function makeSource(pos, when) {
  const src = ctx.createBufferSource();
  src.buffer = song.buffer;
  const gain = ctx.createGain();
  src.connect(gain).connect(songGain);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(1, when + FADE);
  src.start(when, Math.max(0, pos));
  const s = { src, gain, start: when, end: null };
  play.sources.push(s);
  return s;
}

function scheduleClick(t, down) {
  const kind = $("#click-sound").value;
  const sample = cues.click[kind]?.[down ? "down" : "up"];
  if (sample) {
    const src = ctx.createBufferSource();
    src.buffer = sample;
    src.connect(clickGain);
    src.start(t);
    play.clicks.push({ node: src, t });
    return;
  }
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  if (kind === "wood") {
    osc.type = "triangle";
    osc.frequency.setValueAtTime(down ? 1250 : 900, t);
    osc.frequency.exponentialRampToValueAtTime(down ? 700 : 500, t + 0.03);
  } else {
    osc.type = "sine";
    osc.frequency.setValueAtTime(down ? 1760 : 1175, t);
  }
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(down ? 1 : 0.6, t + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "wood" ? 0.045 : 0.06));
  osc.connect(env).connect(clickGain);
  osc.start(t);
  osc.stop(t + 0.08);
  play.clicks.push({ node: osc, t });
}

function playCue(buf, t, until = null) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(guideGain);
  src.start(t);
  if (until !== null && until < t + buf.duration) src.stop(until);
  play.cueNodes.push({ node: src, t });
}

function cancelCuesFrom(t) {
  play.cueNodes = play.cueNodes.filter((c) => {
    if (c.t >= t - 1e-4) { try { c.node.stop(); } catch {} return false; }
    return true;
  });
}

/** What to say in the bar before a section: [{buf, beat}] (beat 0 = first beat), or tts text. */
function cuePlan(name) {
  const m = name.trim().match(/^(.*?)\s*(\d+)?$/);
  const base = m[1].toLowerCase().replace(/[\s_-]/g, "");
  const key = CUE_MAP[base];
  const plan = { items: [], tts: null };
  if (key && cues.buf[key]) plan.items.push({ buf: cues.buf[key], beat: 0, word: true });
  else plan.tts = name;
  if (song.meter >= 4) {
    // "Verse 2": the number follows the word; other sections are called without one.
    if (key === "verse" && m[2] && cues.buf[m[2]]) plan.items.push({ buf: cues.buf[m[2]], beat: 1 });
    // Count the last two beats into the new section ("3, 4").
    for (const k of [song.meter - 1, song.meter]) {
      if (cues.buf[String(k)]) plan.items.push({ buf: cues.buf[String(k)], beat: k - 1 });
    }
  }
  return plan;
}

/** Schedule the spoken cues for the next section change, once it is within a bar. */
function scheduleGuide(t, horizon) {
  const up = upcoming();
  const key = up && !up.loop && up.ctx !== null ? `${up.idx}@${up.ctx.toFixed(3)}` : "";
  if (play.cueKey && play.cueKey !== key) {
    // The target changed (jump queued or cancelled, loop switched on): drop cues not yet heard.
    cancelCuesFrom(t + 0.005);
    play.cueKey = "";
  }
  if (!key || play.cueKey === key) return;
  // Beats of the bar before the change, taken from the beat grid when the change is
  // on a beat (it is, except for "jump now"); otherwise from the local beat length.
  const a = anchorAt(up.ctx - 1e-3);
  const boundaryPos = a.pos + (up.ctx - a.ctx);
  const gi = lowerBound(song.grid, boundaryPos - 0.02);
  const onGrid = gi >= song.meter && Math.abs(song.grid[gi] - boundaryPos) < 0.02;
  const bl = beatLen(boundaryPos - 0.01);
  const beatAt = (b) => onGrid
    ? a.ctx + song.grid[gi - song.meter + b] - a.pos
    : up.ctx - (song.meter - b) * bl;
  const barStart = beatAt(0);
  if (barStart - 0.5 > horizon) return;
  play.cueKey = key;
  const plan = cuePlan(song.sections[up.idx].name);
  const soon = t + 0.01;

  // 1) The count ("3, 4") is rhythmic: always exactly on its beat, cut at the next beat.
  const counts = plan.items.filter((it) => !it.word && it.beat >= song.meter - 2);
  for (const it of counts) {
    const at = beatAt(it.beat);
    if (at >= soon) playCue(it.buf, at, beatAt(it.beat + 1));
  }
  // 2) The section name (and verse number) must finish before the count starts.
  const limit = (counts.length ? beatAt(counts[0].beat) : up.ctx) - 0.03;
  const word = plan.items.find((it) => it.word);
  const num = plan.items.find((it) => !it.word && it.beat < song.meter - 2);
  if (word) {
    // On beat 1 if it fits; at fast tempos start a little earlier so "Verse 2" ends before the count.
    const needed = word.buf.duration + (num ? 0.02 + num.buf.duration : 0);
    const at = Math.max(soon, Math.min(beatAt(0), limit - needed));
    if (at + word.buf.duration <= limit + 0.05) {
      playCue(word.buf, at);
      if (num) {
        // On beat 2 when there is room, otherwise right after the word.
        const nAt = Math.max(at + word.buf.duration + 0.02, Math.min(beatAt(num.beat), limit - num.buf.duration));
        if (nAt + num.buf.duration <= limit + 0.02) playCue(num.buf, nAt);
      }
    }
  }
  if (plan.tts) {
    const wait = Math.max(0, barStart - t);
    setTimeout(() => { if (play.playing && play.cueKey === key) speak(plan.tts); }, wait * 1000);
  }
}

function cancelClicksFrom(t) {
  play.clicks = play.clicks.filter((c) => {
    if (c.t >= t - 1e-4) { try { c.node.stop(); } catch {} return false; }
    return true;
  });
}

// ---------- transport ----------
async function start(pos = play.pausedPos) {
  audio();
  await ctx.resume();
  if (!song.buffer) return;
  pos = Math.min(Math.max(0, pos), song.duration - 0.05);
  const t0 = ctx.currentTime + 0.06;
  let begin = t0;
  if ($("#opt-countin").checked) {
    const bl = beatLen(pos);
    for (let k = 0; k < song.meter; k++) {
      scheduleClick(t0 + k * bl, k === 0);
      // Spoken count-in "1, 2, 3, 4" when the number samples are available.
      if (cues.buf[String(k + 1)]) playCue(cues.buf[String(k + 1)], t0 + k * bl, t0 + (k + 1) * bl);
    }
    begin = t0 + song.meter * bl;
  }
  play.countInUntil = begin;
  play.anchors = [{ ctx: begin, pos }];
  play.sources = [];
  makeSource(pos, begin);
  play.schedCtx = begin;
  play.playing = true;
  play.spoken = "";
  document.body.classList.add("playing");
  clearInterval(play.timer);
  play.timer = setInterval(tick, TICK_MS);
  tick();
}

function stop() {
  if (!play.playing) return;
  const p = now();
  for (const s of play.sources) { try { s.src.stop(); } catch {} s.gain.disconnect(); }
  cancelClicksFrom(0);
  cancelCuesFrom(0);
  clearInterval(play.timer);
  Object.assign(play, { playing: false, sources: [], anchors: [], pending: null, cueKey: "" });
  play.pausedPos = Math.max(0, Math.min(p, song.duration));
  speechSynthesis.cancel();
  document.body.classList.remove("playing");
  render();
}

/** Switch the song to `toPos` at context time `when` (sample-accurate). */
function scheduleJump(toPos, when, idx, loop = false) {
  if (play.pending) cancelPending();
  const prev = play.sources[play.sources.length - 1];
  prev.gain.gain.setValueAtTime(1, Math.max(ctx.currentTime, when - FADE));
  prev.gain.gain.linearRampToValueAtTime(0, when);
  prev.end = when;
  const next = makeSource(toPos, when);
  play.anchors.push({ ctx: when, pos: toPos });
  cancelClicksFrom(when);
  play.schedCtx = Math.min(play.schedCtx, when);
  play.pending = { ctx: when, idx, src: next, prev, loop };
}

function cancelPending() {
  const p = play.pending;
  if (!p || p.ctx <= ctx.currentTime + 0.01) return;
  try { p.src.src.stop(); } catch {}
  p.src.gain.disconnect();
  play.sources = play.sources.filter((s) => s !== p.src);
  play.anchors = play.anchors.filter((a) => a.ctx !== p.ctx);
  p.prev.gain.gain.cancelScheduledValues(ctx.currentTime);
  p.prev.gain.gain.setValueAtTime(1, ctx.currentTime);
  p.prev.end = null;
  cancelClicksFrom(p.ctx);
  play.schedCtx = Math.min(play.schedCtx, p.ctx);
  play.pending = null;
}

function jumpTo(idx, mode = $("#opt-jump").value) {
  const target = song.sections[idx]?.start;
  if (target === undefined) return;
  if (!play.playing) {
    play.pausedPos = target;
    render();
    return;
  }
  if (play.pending && play.pending.idx === idx && !play.pending.loop) { cancelPending(); render(); return; }
  if (play.pending) cancelPending();
  const p = posAt(Math.max(ctx.currentTime, play.countInUntil));
  let when;
  if (mode === "now" || ctx.currentTime < play.countInUntil) {
    when = Math.max(ctx.currentTime + 0.03, play.countInUntil);
  } else if (mode === "section") {
    when = ctxOf(song.sections[sectionAt(p)].end);
  } else {
    const nextBar = song.bars[lowerBound(song.bars, p + 0.03)] ?? song.duration;
    when = ctxOf(nextBar);
  }
  scheduleJump(target, when, idx);
  render();
}

function tick() {
  if (!play.playing) return;
  const t = ctx.currentTime;
  const horizon = t + LOOKAHEAD;

  // A scheduled jump has happened.
  if (play.pending && t >= play.pending.ctx) play.pending = null;

  // Loop: when the current section's end comes into view, jump back to its start.
  if ($("#opt-loop").checked && !play.pending && t >= play.countInUntil) {
    const i = sectionAt(now());
    const s = song.sections[i];
    const endCtx = ctxOf(s.end);
    if (endCtx - t < LOOKAHEAD + 0.05) scheduleJump(s.start, endCtx, i, true);
  }

  // Clicks for every grid beat inside [schedCtx, horizon), segment by segment.
  while (play.schedCtx < horizon - 1e-6) {
    const a = anchorAt(play.schedCtx);
    const nextA = play.anchors.find((x) => x.ctx > play.schedCtx + 1e-9);
    const end = Math.min(horizon, nextA ? nextA.ctx : Infinity);
    const from = a.pos + (play.schedCtx - a.ctx);
    const to = a.pos + (end - a.ctx);
    for (let k = lowerBound(song.grid, from - 1e-6); k < song.grid.length && song.grid[k] < to - 1e-6; k++) {
      if (song.grid[k] <= song.duration) scheduleClick(a.ctx + song.grid[k] - a.pos, k % song.meter === 0);
    }
    play.schedCtx = end;
  }

  scheduleGuide(t, horizon);

  // Housekeeping: drop finished sources/clicks and old anchors.
  play.clicks = play.clicks.filter((c) => c.t > t - 0.2);
  play.cueNodes = play.cueNodes.filter((c) => c.t > t - 2);
  play.sources = play.sources.filter((s) => {
    if (s.end !== null && s.end < t - 0.1) { try { s.src.stop(); } catch {} s.gain.disconnect(); return false; }
    return true;
  });
  while (play.anchors.length > 1 && play.anchors[1].ctx <= t) play.anchors.shift();

  if (!play.pending && now() >= song.duration - 0.02) {
    stop();
    play.pausedPos = 0;
    render();
  }
}

// ---------- guide cues ----------
function speak(text) {
  if (!$("#mute-guide").classList.contains("on") || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\s+\d+$/, "").trim() || text);
  u.lang = /[฀-๿]/.test(text) ? "th-TH" : "en-US";
  u.volume = Number($("#vol-guide").value);
  u.rate = 1.1;
  speechSynthesis.speak(u);
}

function upcoming() {
  // The next boundary: a queued jump, a loop, or simply the next section.
  if (play.pending) return { idx: play.pending.idx, ctx: play.pending.ctx, loop: play.pending.loop };
  const p = now();
  const i = sectionAt(p);
  if ($("#opt-loop").checked) return { idx: i, ctx: play.playing ? ctxOf(song.sections[i].end) : null, loop: true };
  if (i + 1 >= song.sections.length) return null;
  return { idx: i + 1, ctx: play.playing ? ctxOf(song.sections[i + 1].start) : null };
}

// ---------- UI ----------
function buildStage() {
  const a = song.data.analysis;
  $("#title").textContent = song.data.title;
  $("#meta").innerHTML = "";
  for (const txt of [`${a.meter}/4`, fmt(a.duration), a.engine === "allin1" ? "allin1 (AI)" : "librosa", `${song.sections.length} ท่อน`]) {
    const span = document.createElement("span");
    span.textContent = txt;
    $("#meta").append(span);
  }
  $("#ro-bpm").textContent = Math.round(a.tempo);
  $("#to-editor").href = `index.html#${song.id}`;

  const lights = $("#beat-lights");
  lights.innerHTML = "";
  for (let i = 0; i < song.meter; i++) {
    const el = document.createElement("i");
    if (i === 0) el.classList.add("down");
    lights.append(el);
  }

  const blocks = $("#strip-blocks");
  blocks.innerHTML = "";
  song.sections.forEach((s) => {
    const d = document.createElement("div");
    d.style.left = `${(s.start / song.duration) * 100}%`;
    d.style.width = `${((s.end - s.start) / song.duration) * 100}%`;
    d.style.background = groupColor(s.group);
    d.textContent = s.name;
    d.title = s.name;
    blocks.append(d);
  });

  const pads = $("#pads");
  pads.innerHTML = "";
  song.sections.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "pad";
    b.style.setProperty("--pad-color", groupColor(s.group));
    const bars = barAt(s.end - 0.01) - barAt(s.start) + 1;
    b.innerHTML = `<span class="sw"></span><span class="fill"></span><span class="num"></span><span class="nm"></span><span class="len"></span>`;
    b.querySelector(".sw").style.background = groupColor(s.group);
    b.querySelector(".fill").style.background = groupColor(s.group);
    b.querySelector(".num").textContent = i < 9 ? `${i + 1}` : "";
    b.querySelector(".nm").textContent = s.name;
    b.querySelector(".len").textContent = `บาร์ ${barAt(s.start) + 1} · ${bars} บาร์`;
    b.onclick = () => jumpTo(i);
    pads.append(b);
  });
}

function render() {
  if (!song.buffer) return;
  const t = ctx?.currentTime ?? 0;
  const inCountIn = play.playing && t < play.countInUntil;
  const p = now();
  const i = sectionAt(p);

  // Readouts
  if (inCountIn) {
    const bl = beatLen(play.pausedPos);
    const k = Math.min(song.meter, Math.floor((t - (play.countInUntil - song.meter * bl)) / bl) + 1);
    $("#ro-bar").textContent = "–";
    $("#ro-beat").textContent = Math.max(1, k);
    lightBeat(Math.max(0, k - 1));
  } else {
    const bar = barAt(p);
    const beatIdx = Math.max(0, lowerBound(song.grid, p + 1e-3) - 1);
    const beat = (beatIdx % song.meter) + 1;
    $("#ro-bar").textContent = bar + 1;
    $("#ro-beat").textContent = beat;
    lightBeat(play.playing ? beat - 1 : -1);
  }
  $("#ro-time").textContent = fmt(p);
  $("#strip-head").style.left = `${(Math.max(0, p) / song.duration) * 100}%`;

  // Strip + pads
  [...$("#strip-blocks").children].forEach((d, j) => d.classList.toggle("current", j === i));
  const up = upcoming();
  [...$("#pads").children].forEach((b, j) => {
    const s = song.sections[j];
    b.classList.toggle("current", j === i);
    b.classList.toggle("queued", !!play.pending && !play.pending.loop && play.pending.idx === j);
    b.classList.toggle("looping", $("#opt-loop").checked && j === i);
    const prog = j === i ? Math.min(1, Math.max(0, (p - s.start) / (s.end - s.start))) : 0;
    b.querySelector(".fill").style.width = `${prog * 100}%`;
  });

  // Cues
  $("#cue-now").textContent = song.sections[i]?.name ?? "–";
  const next = $("#cue-next");
  if (!up) {
    next.textContent = "จบเพลง";
  } else {
    const name = song.sections[up.idx].name;
    let when = "";
    if (up.ctx !== null && play.playing && !inCountIn) {
      const barsLeft = Math.ceil((up.ctx - t) / (beatLen(p) * song.meter) - 1e-3);
      when = barsLeft <= 1 ? " · ห้องนี้" : ` · อีก ${barsLeft} ห้อง`;
    }
    next.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = up.loop ? `⟳ ${name}` : name;
    next.append(b, when);
  }
}

function lightBeat(k) {
  [...$("#beat-lights").children].forEach((el, j) => el.classList.toggle("on", j === k));
}

function loop() {
  render();
  requestAnimationFrame(loop);
}

function applyMix() {
  if (!ctx) return;
  const on = (id) => $(id).classList.contains("on");
  clickGain.gain.value = on("#mute-click") ? Number($("#vol-click").value) : 0;
  guideGain.gain.value = on("#mute-guide") ? Number($("#vol-guide").value) : 0;
  songGain.gain.value = on("#mute-song") ? Number($("#vol-song").value) : 0;
}

function toggleMute(btn) {
  btn.classList.toggle("on");
  const isOn = btn.classList.contains("on");
  btn.setAttribute("aria-pressed", String(isOn));
  btn.textContent = isOn ? "เปิด" : "ปิด";
  applyMix();
  savePrefs();
}

// ---------- prefs (per browser) ----------
const PREF_IDS = ["#vol-click", "#vol-guide", "#vol-song", "#click-sound", "#opt-jump", "#opt-countin"];
function savePrefs() {
  try {
    const prefs = {};
    for (const id of PREF_IDS) { const el = $(id); prefs[id] = el.type === "checkbox" ? el.checked : el.value; }
    for (const id of ["#mute-click", "#mute-guide", "#mute-song"]) prefs[id] = $(id).classList.contains("on");
    localStorage.setItem("songsections.live", JSON.stringify(prefs));
  } catch {}
}
function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem("songsections.live") || "{}");
    for (const id of PREF_IDS) if (id in prefs) { const el = $(id); if (el.type === "checkbox") el.checked = prefs[id]; else el.value = prefs[id]; }
    for (const id of ["#mute-click", "#mute-guide", "#mute-song"]) {
      if (id in prefs && prefs[id] !== $(id).classList.contains("on")) {
        $(id).classList.toggle("on");
        $(id).textContent = prefs[id] ? "เปิด" : "ปิด";
        $(id).setAttribute("aria-pressed", String(prefs[id]));
      }
    }
  } catch {}
}

// ---------- loading ----------
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 2500);
}

async function loadSongs() {
  const songs = await (await fetch("/api/songs")).json();
  const ul = $("#songs");
  ul.innerHTML = "";
  for (const s of songs) {
    const li = document.createElement("li");
    li.classList.toggle("active", s.id === song.id);
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="t"></span><span class="m"></span>`;
    btn.querySelector(".t").textContent = s.title;
    btn.querySelector(".m").textContent = `${Math.round(s.tempo)} BPM · ${s.sections} ท่อน`;
    btn.title = s.title;
    btn.onclick = () => openSong(s.id);
    li.append(btn);
    ul.append(li);
  }
  return songs;
}

async function openSong(id) {
  stop();
  $("#loading").hidden = false;
  try {
    const data = await (await fetch(`/api/songs/${id}`)).json();
    const bytes = await (await fetch(`/api/songs/${id}/audio`)).arrayBuffer();
    const buffer = await audio().decodeAudioData(bytes);
    const a = data.analysis;
    Object.assign(song, {
      id, data, buffer,
      sections: a.sections,
      grid: data.grid,
      meter: a.meter,
      duration: Math.min(a.duration, buffer.duration),
    });
    song.bars = song.grid.filter((_, i) => i % song.meter === 0);
    play.pausedPos = 0;
    history.replaceState(null, "", `#${id}`);
    $("#empty").hidden = true;
    $("#stage").hidden = false;
    buildStage();
    loadSongs();
    render();
  } catch (e) {
    toast(`โหลดเพลงไม่ได้: ${e.message}`, true);
  } finally {
    $("#loading").hidden = true;
  }
}

// ---------- wiring ----------
$("#btn-play").onclick = () => (play.playing ? stop() : start());
$("#btn-restart").onclick = () => jumpTo(sectionAt(now()), "now");
$("#strip").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const p = ((e.clientX - r.left) / r.width) * song.duration;
  const bar = song.bars[barAt(p)] ?? 0;
  if (!play.playing) { play.pausedPos = bar; render(); return; }
  if (play.pending) cancelPending();
  scheduleJump(bar, Math.max(ctx.currentTime + 0.03, play.countInUntil), sectionAt(bar));
};
for (const id of ["#mute-click", "#mute-guide", "#mute-song"]) $(id).onclick = (e) => toggleMute(e.currentTarget);
for (const id of ["#vol-click", "#vol-song", "#vol-guide"]) $(id).oninput = () => { applyMix(); savePrefs(); };
for (const id of ["#click-sound", "#opt-jump", "#opt-countin"]) $(id).onchange = savePrefs;
$("#opt-loop").onchange = () => {
  if (!$("#opt-loop").checked && play.pending?.loop) cancelPending();
  render();
};

document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input[type=text], textarea, select") || !song.buffer) return;
  if (e.code === "Space") { e.preventDefault(); play.playing ? stop() : start(); }
  else if (/^[1-9]$/.test(e.key)) jumpTo(Number(e.key) - 1);
  else if (e.key === "l" || e.key === "L") { $("#opt-loop").checked = !$("#opt-loop").checked; $("#opt-loop").onchange(); }
  else if (e.key === "c" || e.key === "C") toggleMute($("#mute-click"));
  else if (e.key === "ArrowRight") { e.preventDefault(); jumpTo(Math.min(sectionAt(now()) + 1, song.sections.length - 1)); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); jumpTo(Math.max(sectionAt(now()) - 1, 0)); }
});

/** Load samples from the local cues/ folder; without them the app falls back to synth/TTS. */
async function loadCues() {
  let names = [];
  try { names = await (await fetch("/api/cues")).json(); } catch {}
  const decode = async (name) => audio().decodeAudioData(await (await fetch(`/cues/${encodeURIComponent(name)}.wav`)).arrayBuffer());
  await Promise.all(names.filter((n) => !n.startsWith("click-")).map(async (n) => {
    try { cues.buf[n] = await decode(n); } catch {}
  }));
  // One-bar click loops (4 quarter notes): slice out the accented first beat and a normal beat.
  for (const kind of ["hard", "soft"]) {
    if (!names.includes(`click-${kind}`)) continue;
    try {
      const bar = await decode(`click-${kind}`);
      const beat = bar.duration / 4;
      const slice = (from) => {
        const len = Math.floor(Math.min(beat, 0.15) * bar.sampleRate);
        const out = ctx.createBuffer(bar.numberOfChannels, len, bar.sampleRate);
        const off = Math.floor(from * bar.sampleRate);
        for (let ch = 0; ch < bar.numberOfChannels; ch++) {
          out.copyToChannel(bar.getChannelData(ch).subarray(off, off + len), ch);
        }
        return out;
      };
      cues.click[`wt-${kind}`] = { down: slice(0), up: slice(beat) };
      const opt = document.createElement("option");
      opt.value = `wt-${kind}`;
      opt.textContent = kind === "hard" ? "WT Hard" : "WT Soft (เบา)";
      $("#click-sound").append(opt);
    } catch {}
  }
  const words = Object.keys(cues.buf).filter((n) => !/^\d$/.test(n)).length;
  $("#guide-info").textContent = words
    ? `เสียงคิวจากโฟลเดอร์ cues (${words} คำ) · นับ 3, 4 ก่อนเข้าท่อน`
    : "ไม่มีไฟล์ในโฟลเดอร์ cues: ใช้เสียงอ่านของ browser";
}

window.cueLine = { play, song, cues }; // for debugging from the browser console

await loadCues();
loadPrefs();
const songs = await loadSongs();
const wanted = location.hash.slice(1);
if (wanted && songs.some((s) => s.id === wanted)) openSong(wanted);
requestAnimationFrame(loop);
