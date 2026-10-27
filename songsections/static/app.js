import WaveSurfer from "https://unpkg.com/wavesurfer.js@7.8.6/dist/wavesurfer.esm.js";
import RegionsPlugin from "https://unpkg.com/wavesurfer.js@7.8.6/dist/plugins/regions.esm.js";
import TimelinePlugin from "https://unpkg.com/wavesurfer.js@7.8.6/dist/plugins/timeline.esm.js";

const $ = (s) => document.querySelector(s);
const MIN_LEN = 0.5; // seconds; shortest section an edit may leave
const GROUP_VARS = Array.from({ length: 10 }, (_, i) => `--g${i}`);
const css = getComputedStyle(document.documentElement);
const groupColor = (g, alpha = 1) => {
  const hex = css.getPropertyValue(GROUP_VARS[(g.charCodeAt(0) - 65) % 10]).trim();
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const state = {
  song: null,      // {id, title, analysis, grid}
  sections: [],    // working copy being edited
  dirty: false,
  bars: [],        // Logic bar start times
  ws: null,
  regions: null,
  jobs: [],
};

// ---------- helpers ----------
const fmt = (t) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
};
const fmtLong = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/** Index of the Logic bar containing t (bar 1 = index 0). */
function barIndex(t) {
  const b = state.bars;
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (b[mid] <= t + 1e-3) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function barLabel(t) {
  const i = barIndex(t);
  const b = state.bars;
  const len = (b[i + 1] ?? b[i] + 2) - b[i];
  const beat = Math.floor(((t - b[i]) / len) * state.song.analysis.meter) + 1;
  return beat > 1 ? `บาร์ ${i + 1}.${beat}` : `บาร์ ${i + 1}`;
}

function snap(t) {
  const mode = $("#snap").value;
  const pts = mode === "bar" ? state.bars : mode === "beat" ? state.song.grid : null;
  if (!pts || !pts.length) return t;
  let best = pts[0];
  for (const p of pts) if (Math.abs(p - t) < Math.abs(best - t)) best = p;
  return best;
}

/** Merged sections keep both lyrics, unless the second just repeats the first. */
const joinLyrics = (a = "", b = "") =>
  !b.trim() || a.trim() === b.trim() ? a : !a.trim() ? b : `${a}\n\n${b}`;

const baseName = (n) => n.replace(/\s+\d+$/, "").trim() || "Section";

/** Number repeated names (Chorus 1, Chorus 2) and give each base name one group letter. */
function renumber() {
  const totals = {}, seen = {}, letters = {};
  for (const s of state.sections) totals[baseName(s.name)] = (totals[baseName(s.name)] || 0) + 1;
  for (const s of state.sections) {
    const b = baseName(s.name);
    letters[b] ??= String.fromCharCode(65 + (Object.keys(letters).length % 26));
    seen[b] = (seen[b] || 0) + 1;
    s.name = totals[b] > 1 ? `${b} ${seen[b]}` : b;
    s.group = letters[b];
  }
}

function setDirty(d) {
  state.dirty = d;
  $("#btn-save").disabled = !d;
  $("#btn-save").textContent = d ? "บันทึก •" : "บันทึกแล้ว";
}

function edited() {
  renumber();
  setDirty(true);
  renderRegions();
  renderRows();
}

// ---------- library ----------
async function loadSongs() {
  const songs = await api("/api/songs");
  const ul = $("#songs");
  ul.innerHTML = "";
  $("#songs-empty").hidden = songs.length > 0;
  for (const s of songs) {
    const li = document.createElement("li");
    li.classList.toggle("active", state.song?.id === s.id);
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="t"></span><span class="m"></span>`;
    btn.querySelector(".t").textContent = s.title;
    btn.querySelector(".m").textContent =
      `${fmtLong(s.duration)} · ${Math.round(s.tempo)} BPM · ${s.sections} ท่อน · ${s.engine}`;
    btn.title = s.title;
    btn.onclick = () => openSong(s.id);
    li.append(btn);
    ul.append(li);
  }
  return songs;
}

async function openSong(id) {
  if (state.dirty && !confirm("มีการแก้ไขที่ยังไม่ได้บันทึก จะทิ้งไหม?")) return;
  const song = await api(`/api/songs/${id}`);
  state.song = song;
  state.sections = song.analysis.sections.map((s) => ({ ...s }));
  const meter = song.analysis.meter;
  state.bars = song.grid.filter((_, i) => i % meter === 0);
  setDirty(false);
  history.replaceState(null, "", `#${id}`);

  $("#empty").hidden = true;
  $("#song").hidden = false;
  $("#title").textContent = song.title;
  const a = song.analysis;
  $("#meta").innerHTML = "";
  for (const txt of [
    fmtLong(a.duration), `${a.tempo.toFixed(1)} BPM`, `${meter}/4`,
    a.engine === "allin1" ? "allin1 (AI)" : "librosa",
    a.downbeats.length ? "บาร์ตรงกับเพลง" : "บาร์อาจไม่ตรงห้องเพลง",
  ]) {
    const span = document.createElement("span");
    span.textContent = txt;
    $("#meta").append(span);
  }
  $("#btn-audio").href = `/api/songs/${id}/download-audio`;
  $("#btn-live").href = `live.html#${id}`;
  $("#now-lyrics").hidden = true;
  api(`/api/songs/${id}/lyrics`).then(({ text }) => {
    $("#lyrics").value = text;
    $("#lyrics-panel").open = !text && !state.sections.some((s) => s.lyrics);
  });
  for (const li of $("#songs").children) li.classList.remove("active");
  loadSongs();
  loadWave(id);
  renderRows();
}

// ---------- waveform ----------
function loadWave(id) {
  state.ws?.destroy();
  $("#loading-wave").hidden = false;
  const regions = RegionsPlugin.create();
  const ws = WaveSurfer.create({
    container: "#waveform",
    height: 140,
    waveColor: css.getPropertyValue("--wave").trim(),
    progressColor: css.getPropertyValue("--wave-done").trim(),
    cursorColor: css.getPropertyValue("--accent").trim(),
    cursorWidth: 2,
    barWidth: 2, barGap: 1, barRadius: 1,
    normalize: true,
    url: `/api/songs/${id}/audio`,
    plugins: [regions, TimelinePlugin.create({ height: 18, style: { color: "#8d939c", fontSize: "11px" } })],
  });
  state.ws = ws;
  state.regions = regions;

  ws.on("ready", () => {
    $("#loading-wave").hidden = true;
    applyZoom();
    renderRegions();
  });
  ws.on("error", (e) => toast(`โหลดเสียงไม่ได้: ${e}`, true));
  ws.on("timeupdate", onTime);
  ws.on("play", () => document.body.classList.add("playing"));
  ws.on("pause", () => document.body.classList.remove("playing"));

  // Clicks on a region fall through to the waveform, which seeks to the click point.
  regions.on("region-updated", (r) => onRegionResized(Number(r.id), r));
}

function renderRegions() {
  if (!state.regions || !state.ws?.getDuration()) return;
  state.regions.clearRegions();
  state.sections.forEach((s, i) => {
    const content = document.createElement("div");
    content.textContent = s.name;
    state.regions.addRegion({
      id: String(i),
      start: s.start,
      end: s.end,
      color: groupColor(s.group, 0.32),
      content,
      drag: false,
      resize: true,
    });
  });
  // Solid label background in the group colour.
  for (const r of state.regions.getRegions()) {
    const s = state.sections[Number(r.id)];
    r.content.style.background = groupColor(s.group, 0.95);
  }
}

function onRegionResized(i, r) {
  const secs = state.sections;
  const s = secs[i];
  if (Math.abs(r.start - s.start) > 1e-3 && i > 0) {
    // Moved the left edge: it is also the previous section's end.
    const t = Math.min(Math.max(snap(r.start), secs[i - 1].start + MIN_LEN), s.end - MIN_LEN);
    s.start = secs[i - 1].end = t;
  }
  if (Math.abs(r.end - s.end) > 1e-3 && i < secs.length - 1) {
    const t = Math.max(Math.min(snap(r.end), secs[i + 1].end - MIN_LEN), s.start + MIN_LEN);
    s.end = secs[i + 1].start = t;
  }
  edited();
}

function currentIndex(t) {
  const i = state.sections.findIndex((s) => t >= s.start && t < s.end);
  return i === -1 ? state.sections.length - 1 : i;
}

function onTime(t) {
  $("#clock-time").textContent = fmt(t);
  $("#clock-bar").textContent = barLabel(t);
  const i = currentIndex(t);
  const s = state.sections[i];
  const now = $("#now-section");
  if (s && now.dataset.i !== String(i) + s.name) {
    now.dataset.i = String(i) + s.name;
    now.innerHTML = `<i></i><span></span>`;
    now.querySelector("i").style.background = groupColor(s.group);
    now.querySelector("span").textContent = s.name;
    document.querySelectorAll("#rows tr").forEach((tr, j) => tr.classList.toggle("current", j === i));
    const ly = $("#now-lyrics");
    ly.textContent = s.lyrics || "";
    ly.hidden = !s.lyrics;
  }
}

function applyZoom() {
  state.ws?.zoom(Number($("#zoom").value));
}

// ---------- table ----------
function renderRows() {
  const tbody = $("#rows");
  tbody.innerHTML = "";
  const cur = state.ws ? currentIndex(state.ws.getCurrentTime()) : -1;
  state.sections.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("current", i === cur);
    const bars = barIndex(s.end) - barIndex(s.start);
    tr.innerHTML = `
      <td class="sw"><i></i></td>
      <td class="name"><input type="text" list="names" maxlength="60" aria-label="ชื่อท่อน"><span class="ly"></span></td>
      <td class="time"><span class="b"></span><span class="s"></span></td>
      <td class="time muted"></td>
      <td class="act">
        <button class="icon-btn play" title="ฟังจากท่อนนี้" aria-label="ฟังจากท่อนนี้">▶</button>
        <button class="icon-btn del" title="ลบจุดเปลี่ยนนี้ (รวมกับท่อนก่อนหน้า)" aria-label="รวมกับท่อนก่อนหน้า">⨯</button>
      </td>`;
    tr.querySelector(".sw i").style.background = groupColor(s.group);
    const input = tr.querySelector("input");
    input.value = s.name;
    input.addEventListener("change", () => {
      s.name = input.value.trim() || s.name;
      edited();
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    const ly = tr.querySelector(".ly");
    const firstLine = (s.lyrics || "").split("\n").find((l) => l.trim()) || "";
    ly.textContent = firstLine;
    ly.title = s.lyrics || "";
    if (!firstLine) ly.remove();
    tr.querySelector(".b").textContent = barLabel(s.start);
    tr.querySelector(".s").textContent = fmt(s.start);
    tr.children[3].textContent = bars > 0 ? `${bars} บาร์` : fmt(s.end - s.start);
    tr.querySelector(".play").onclick = () => { state.ws.setTime(s.start); state.ws.play(); };
    const del = tr.querySelector(".del");
    del.disabled = i === 0;
    del.onclick = () => {
      const prev = state.sections[i - 1];
      prev.end = s.end;
      prev.lyrics = joinLyrics(prev.lyrics, s.lyrics);
      state.sections.splice(i, 1);
      edited();
    };
    tbody.append(tr);
  });
}

// ---------- edit actions ----------
function splitAtPlayhead() {
  if (!state.ws) return;
  const t = snap(state.ws.getCurrentTime());
  const i = currentIndex(t);
  const s = state.sections[i];
  if (t - s.start < MIN_LEN || s.end - t < MIN_LEN) {
    toast("ตำแหน่งนี้ชิดขอบท่อนเกินไป");
    return;
  }
  state.sections.splice(i + 1, 0, { ...s, start: t, lyrics: "" });
  s.end = t;
  edited();
}

function mergeRepeats() {
  const out = [];
  for (const s of state.sections) {
    const prev = out[out.length - 1];
    if (prev && baseName(prev.name) === baseName(s.name)) {
      prev.end = s.end;
      prev.lyrics = joinLyrics(prev.lyrics, s.lyrics);
    } else out.push({ ...s });
  }
  if (out.length === state.sections.length) { toast("ไม่มีท่อนซ้ำติดกันให้รวม"); return; }
  const removed = state.sections.length - out.length;
  state.sections = out;
  edited();
  toast(`รวมแล้ว ${removed} จุด`);
}

async function save() {
  const a = await api(`/api/songs/${state.song.id}/sections`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.sections.map(({ start, end, name, group, lyrics }) =>
      ({ start, end, name, group, lyrics: lyrics || "" }))),
  });
  state.song.analysis = a;
  setDirty(false);
  loadSongs();
}

// ---------- jobs ----------
async function pollJobs() {
  try {
    const jobs = await api("/api/jobs");
    const before = new Map(state.jobs.map((j) => [j.id, j.status]));
    state.jobs = jobs;
    renderJobs();
    for (const j of jobs) {
      const was = before.get(j.id);
      if (was && was !== "done" && j.status === "done" && j.kind === "transcribe") {
        if (state.song?.id === j.song_id) await applyTranscript();
        else toast("แกะเนื้อเสร็จแล้ว เปิดเพลงนั้นเพื่อดูผล");
      } else if (was && was !== "done" && j.status === "done") {
        toast("วิเคราะห์เสร็จแล้ว");
        await loadSongs();
        if (!state.dirty) openSong(j.song_id);
      }
      if (was && was !== "error" && j.status === "error") toast(`วิเคราะห์ไม่สำเร็จ: ${j.error}`, true);
    }
  } catch {}
  const active = state.jobs.some((j) => j.status === "queued" || j.status === "running");
  setTimeout(pollJobs, active ? 1500 : 5000);
}

function renderJobs() {
  const now = Date.now() / 1000;
  const recent = state.jobs.filter((j) => j.status !== "done" && (j.status !== "error" || now - j.finished < 600));
  $("#jobs-panel").hidden = recent.length === 0;
  const ul = $("#jobs");
  ul.innerHTML = "";
  for (const j of recent) {
    const li = document.createElement("li");
    li.className = j.status;
    li.innerHTML = `<div class="t"></div><div class="s"><span class="stage"></span><span class="el mono"></span></div><div class="bar"></div>`;
    li.querySelector(".t").textContent = j.kind === "transcribe" ? `แกะเนื้อ: ${j.label}` : j.label;
    li.querySelector(".t").title = j.label;
    const stage = { queued: "รอคิว", error: j.error }[j.status] ?? stageText(j.stage);
    li.querySelector(".stage").textContent = stage;
    if (j.started) li.querySelector(".el").textContent = fmtLong((j.finished ?? now) - j.started);
    if (j.status === "error") li.querySelector(".bar").remove();
    ul.append(li);
  }
}

const stageText = (s) =>
  s.startsWith("Downloading") ? "กำลังดาวน์โหลด…" :
  s.startsWith("Separating vocals") ? "กำลังแยกเสียงร้อง…" :
  s.startsWith("Transcribing lyrics (CPU)") ? "กำลังถอดเนื้อร้องด้วย CPU (ช้า)…" :
  s.startsWith("Transcribing") ? "กำลังถอดเนื้อร้อง…" :
  s.startsWith("Analyzing (allin1)") ? "กำลังวิเคราะห์ด้วย AI (หลายนาที)…" :
  s.startsWith("Analyzing") ? "กำลังวิเคราะห์…" : s;

// ---------- wiring ----------
$("#file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  $("#file-label").textContent = f ? f.name : "หรือเลือกไฟล์";
  if (f) $("#url").value = "";
});

$("#job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData();
  const file = $("#file").files[0];
  const url = $("#url").value.trim();
  if (!file && !url) { toast("วางลิงก์ YouTube หรือเลือกไฟล์ก่อน", true); return; }
  if (file) fd.append("file", file); else fd.append("url", url);
  fd.append("engine", $("#engine").value);
  try {
    const job = await api("/api/jobs", { method: "POST", body: fd });
    state.jobs.unshift(job);
    renderJobs();
    $("#url").value = "";
    $("#file").value = "";
    $("#file-label").textContent = "หรือเลือกไฟล์";
    toast("เริ่มวิเคราะห์แล้ว");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btn-fit").onclick = async () => {
  const text = $("#lyrics").value;
  if (!text.trim()) {
    toast("วางโครงเพลงหรือเนื้อร้องก่อน", true);
    return;
  }
  if (state.dirty && !confirm("จะจัดท่อนใหม่ตามโครงนี้ แทนการแก้ไขที่ยังไม่ได้บันทึก?")) return;
  try {
    const sections = await api(`/api/songs/${state.song.id}/fit-lyrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    state.sections = sections;
    edited();
    $("#now-section").dataset.i = "";
    onTime(state.ws?.getCurrentTime() ?? 0);
    toast(`จัดแล้ว ${sections.length} ท่อน ตรวจขอบท่อนแล้วกดบันทึก`);
  } catch (e) {
    toast(e.message, true);
  }
};
/** Put transcribed lines into the current sections by time, and show them as tagged text. */
async function applyTranscript() {
  const t = await api(`/api/songs/${state.song.id}/transcript`);
  const texts = state.sections.map(() => []);
  for (const seg of t.segments) {
    const mid = (seg.start + seg.end) / 2;
    texts[Math.max(0, currentIndex(mid))].push(seg.text);
  }
  state.sections.forEach((s, i) => { s.lyrics = texts[i].join("\n"); });
  $("#lyrics").value = state.sections
    .map((s) => `[${s.name}]` + (s.lyrics ? `\n${s.lyrics}` : ""))
    .join("\n\n") + "\n";
  $("#lyrics-panel").open = true;
  edited();
  $("#now-section").dataset.i = "";
  onTime(state.ws?.getCurrentTime() ?? 0);
  toast(`แกะเนื้อได้ ${t.segments.length} บรรทัด ตรวจแก้แล้วกดบันทึก`);
}

$("#btn-transcribe").onclick = async () => {
  if ($("#lyrics").value.trim() && !confirm("ผลที่แกะได้จะแทนที่ข้อความในช่องนี้ ทำต่อไหม?")) return;
  try {
    const job = await api(`/api/songs/${state.song.id}/transcribe`, { method: "POST" });
    if (!state.jobs.some((j) => j.id === job.id)) state.jobs.unshift(job);
    renderJobs();
    toast("เริ่มแกะเนื้อแล้ว อาจใช้เวลาหลายนาที");
  } catch (e) {
    toast(e.message, true);
  }
};
$("#btn-play").onclick = () => state.ws?.playPause();
$("#btn-split").onclick = splitAtPlayhead;
$("#btn-merge").onclick = mergeRepeats;
$("#zoom").oninput = applyZoom;
$("#btn-save").onclick = () => save().then(() => toast("บันทึกแล้ว")).catch((e) => toast(e.message, true));
$("#btn-reset").onclick = async () => {
  if (!confirm("กลับไปใช้ผลวิเคราะห์ตั้งต้น? การแก้ไขทั้งหมดจะหายไป")) return;
  const a = await api(`/api/songs/${state.song.id}/reset`, { method: "POST" });
  state.song.analysis = a;
  state.sections = a.sections.map((s) => ({ ...s }));
  setDirty(false);
  renderRegions();
  renderRows();
  loadSongs();
};
$("#btn-export").onclick = async () => {
  try {
    if (state.dirty) await save();
    location.href = `/api/songs/${state.song.id}/midi?tempo_mode=${$("#tempo-mode").value}`;
  } catch (e) { toast(e.message, true); }
};
$("#btn-delete").onclick = async () => {
  if (!confirm(`ลบ "${state.song.title}" ออกจากเครื่อง? (ลบไฟล์เพลงและผลวิเคราะห์)`)) return;
  await api(`/api/songs/${state.song.id}`, { method: "DELETE" });
  state.ws?.destroy();
  state.ws = state.song = null;
  setDirty(false);
  $("#song").hidden = true;
  $("#empty").hidden = false;
  history.replaceState(null, "", "#");
  loadSongs();
};
document.addEventListener("click", (e) => {
  const more = $(".more");
  if (more?.open && !more.contains(e.target)) more.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, select, textarea") || !state.ws) return;
  if (e.code === "Space") { e.preventDefault(); state.ws.playPause(); }
  if (e.key === "s" || e.key === "S") splitAtPlayhead();
});
window.addEventListener("beforeunload", (e) => { if (state.dirty) e.preventDefault(); });

window.songSections = state; // for debugging from the browser console

const songs = await loadSongs();
const wanted = location.hash.slice(1);
if (wanted && songs.some((s) => s.id === wanted)) openSong(wanted);
pollJobs();
