"""Song structure from tagged lyrics, e.g.

    [Intro]

    [V1]
    first verse lines...

    [Chorus x2]
    chorus lines...

and fitting that structure onto the detected section boundaries.
"""
import re
from dataclasses import dataclass

from .analyze import Section

TAG_LINE = re.compile(r"^\s*\[(?P<tag>[^\]]+)\]\s*$")
REPEAT = re.compile(r"\s*(?:x|×|\*)\s*(\d+)\s*$", re.I)
# Chord-sheet style header: "Verse 1:" or "Intro: b | b | e |"
COLON_LINE = re.compile(r"^\s*(?P<tag>[^\s:][^:]{0,24}?)\s*:\s*(?P<rest>.*)$")
CHORD = re.compile(
    r"[A-Ga-g][#b♯♭]?(?:maj|min|m|dim|aug|sus|add|M)?\d*(?:sus\d?|add\d+|[#b]\d+)*"
    r"(?:/[A-Ga-g][#b♯♭]?)?"
)
CHORD_FILLER = {"|", "/", "-", "%", "(", ")", "x2", "x3", "x4", "n.c.", "nc"}

# Tag spelling (lowercase, no spaces/dashes) -> (type, display name)
TYPES = [
    (r"intro|อินโทร", "intro", "Intro"),
    (r"pre(chorus)?|pc|prehook|ก่อนฮุก|พรีฮุก|พรีคอรัส", "prechorus", "Pre-Chorus"),
    (r"v(erse)?|เวิร์ส", "verse", "Verse"),
    (r"c(horus)?|ch|hook|ref(rain)?|ฮุก|ฮุค|คอรัส", "chorus", "Chorus"),
    (r"b(ridge)?|br|middle8|บริดจ์|บริดจ", "bridge", "Bridge"),
    (r"solo|โซโล่|โซโล", "solo", "Solo"),
    (r"inst(rumental)?|interlude|midtro|music|ดนตรี", "inst", "Instrumental"),
    (r"break|breakdown", "break", "Break"),
    (r"outro|ending|end|coda|tag|เอาท์โทร|จบ", "outro", "Outro"),
]

# How well a tag type fits a detected label: 0 = same, higher = worse.
SIMILAR = {
    frozenset({"verse", "prechorus"}): 0.4,
    frozenset({"chorus", "prechorus"}): 0.6,
    frozenset({"inst", "solo"}): 0.2,
    frozenset({"inst", "intro"}): 0.3,
    frozenset({"inst", "outro"}): 0.3,
    frozenset({"inst", "break"}): 0.3,
    frozenset({"inst", "bridge"}): 0.5,
    frozenset({"solo", "bridge"}): 0.5,
    frozenset({"intro", "outro"}): 0.5,
}


@dataclass
class Part:
    type: str  # intro, verse, chorus... or "other"
    name: str  # display name, e.g. "Verse 1"
    lyrics: str


def classify(tag: str) -> tuple[str, str, str]:
    """'V1' -> ('verse', 'Verse', '1'); unknown tags keep their own text."""
    tag = REPEAT.sub("", tag).strip()
    m = re.match(r"^(.*?)[\s._-]*(\d+)$", tag)
    word, num = (m.group(1), m.group(2)) if m and m.group(1) else (tag, "")
    key = re.sub(r"[\s_-]", "", word.lower())
    for pattern, typ, display in TYPES:
        if re.fullmatch(pattern, key):
            return typ, display, num
    return "other", tag, ""


def is_chord_line(line: str) -> bool:
    """True for lines with only chords and bar marks, e.g. '  B      G#m' or 'E | G#m | E |'."""
    tokens = line.replace("|", " | ").split()
    if not tokens:
        return False
    chords = 0
    for tok in tokens:
        if tok.lower() in CHORD_FILLER:
            continue
        if not CHORD.fullmatch(tok):
            return False
        chords += 1
    return chords > 0 or "|" in tokens


def header(line: str) -> str | None:
    """Section name if the line starts a section, in either [Tag] or 'Tag:' style."""
    m = TAG_LINE.match(line)
    if m:
        return m.group("tag").strip()
    m = COLON_LINE.match(line)
    if m and classify(m.group("tag"))[0] != "other" and (
            not m.group("rest").strip() or is_chord_line(m.group("rest"))):
        return m.group("tag").strip()
    return None


def lyric_text(line: str) -> str:
    """Drop a short cue before the lyric, e.g. '1: ', 'P: ', 'C: '."""
    return re.sub(r"^\s*[^\s:]{1,3}:\s+", "", line).strip()


def parse(text: str) -> list[Part]:
    """Tagged lyrics or a chord sheet -> parts in song order.

    Chord-only lines are dropped and [Chorus x2] style repeats are expanded.
    """
    parts: list[Part] = []
    tag, lines, repeat = None, [], 1

    def flush():
        if tag is None and not "".join(lines).strip():
            return
        typ, display, num = classify(tag) if tag is not None else ("other", "Section", "")
        body = "\n".join(lines).strip()
        for _ in range(repeat):
            parts.append(Part(typ, f"{display} {num}".strip(), body))

    for line in text.splitlines():
        h = header(line)
        if h is not None:
            flush()
            tag = h
            r = REPEAT.search(tag)
            repeat = max(1, min(int(r.group(1)), 16)) if r else 1
            lines = []
        elif not is_chord_line(line):
            lines.append(lyric_text(line))
    flush()
    return parts


def to_tagged(text: str, original_names: bool = True) -> str:
    """Rewrite a chord sheet as [Tag] lyrics: chords and line cues removed."""
    out, tag, lines = [], None, []

    def flush():
        if tag is None and not any(l.strip() for l in lines):
            return
        name = tag if original_names and tag else (classify(tag)[1] if tag else "Section")
        body = "\n".join(lines).strip()
        out.append(f"[{name}]" + (f"\n{body}" if body else ""))

    for line in text.splitlines():
        h = header(line)
        if h is not None:
            flush()
            tag, lines = h, []
        elif not is_chord_line(line):
            lines.append(lyric_text(line))
    flush()
    return "\n\n".join(out) + "\n"


def _main() -> None:
    import argparse
    import sys
    from pathlib import Path

    p = argparse.ArgumentParser(
        prog="python -m songsections.lyrics",
        description="Convert a chord sheet to [Tag] lyrics (chord lines and cues like '1:' removed).")
    p.add_argument("input", help="text file with the chord sheet")
    p.add_argument("-o", "--output", help="write here instead of <input>-tagged.txt")
    args = p.parse_args()

    src = Path(args.input)
    dst = Path(args.output) if args.output else src.with_name(f"{src.stem}-tagged.txt")
    dst.write_text(to_tagged(src.read_text(encoding="utf-8-sig")), encoding="utf-8")
    parts = parse(dst.read_text(encoding="utf-8"))
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"Saved: {dst}")
    print("Sections: " + " -> ".join(p.name for p in parts))


def _label_type(section: Section) -> str:
    base = re.sub(r"\s+\d+$", "", section.name).strip()
    return classify(base)[0]


def _mismatch(tag_type: str, label_type: str) -> float:
    if tag_type == label_type:
        return 0.0
    if "other" in (tag_type, label_type):
        return 0.5
    return SIMILAR.get(frozenset({tag_type, label_type}), 1.0)


def _subdivide(segs: list[Section], bars: list[float], needed: int) -> list[Section]:
    """Split the longest segments at a bar line until there are `needed` segments."""
    segs = [Section(**vars(s)) for s in segs]
    while len(segs) < needed:
        i = max(range(len(segs)), key=lambda k: segs[k].end - segs[k].start)
        s = segs[i]
        mid = (s.start + s.end) / 2
        inside = [b for b in bars if s.start + 0.5 < b < s.end - 0.5]
        cut = min(inside, key=lambda b: abs(b - mid)) if inside else mid
        if cut - s.start < 0.2:  # nothing left to split
            break
        segs[i:i + 1] = [Section(**{**vars(s), "end": cut}), Section(**{**vars(s), "start": cut})]
    return segs


def fit(parts: list[Part], detected: list[Section], bars: list[float]) -> list[Section]:
    """Assign each part a run of consecutive detected segments.

    Dynamic programming over (part, segment) minimising the duration-weighted
    mismatch between the part's type and the detected labels, so every part
    gets at least one segment and the song is covered from start to end.
    """
    if not parts:
        raise ValueError("no sections found in the lyrics")
    segs = _subdivide(detected, bars, len(parts))
    n, m = len(parts), len(segs)
    if n > m:
        raise ValueError(f"song is too short to hold {n} sections")

    durs = [s.end - s.start for s in segs]
    types = [_label_type(s) for s in segs]
    # cost[p][k] = cost of segment k under part p
    cost = [[durs[k] * _mismatch(p.type, types[k]) for k in range(m)] for p in parts]
    prefix = [[0.0] * (m + 1) for _ in range(n)]
    for p in range(n):
        for k in range(m):
            prefix[p][k + 1] = prefix[p][k] + cost[p][k]

    inf = float("inf")
    # best[p][j]: parts 0..p cover segments 0..j-1, with part p ending at j-1
    best = [[inf] * (m + 1) for _ in range(n)]
    back = [[0] * (m + 1) for _ in range(n)]
    for j in range(1, m - n + 2):
        best[0][j] = prefix[0][j]
    for p in range(1, n):
        for j in range(p + 1, m - (n - p - 1) + 1):
            for i in range(p, j):
                c = best[p - 1][i] + prefix[p][j] - prefix[p][i]
                if c < best[p][j]:
                    best[p][j], back[p][j] = c, i

    cuts, j = [m], m
    for p in range(n - 1, 0, -1):
        j = back[p][j]
        cuts.append(j)
    cuts.append(0)
    cuts.reverse()

    out = []
    for p, part in enumerate(parts):
        a, b = cuts[p], cuts[p + 1]
        out.append(Section(start=segs[a].start, end=segs[b - 1].end, group="",
                           name=part.name, lyrics=part.lyrics))
    return out


if __name__ == "__main__":
    _main()
