"""Section analysis with the All-In-One model (Kim & Nam, 2023) via all-in-one-infer.

The model labels sections directly (intro, verse, chorus, bridge, inst, solo, break,
outro) and also gives downbeats, so Logic bars can line up with the song.
"""
from collections import Counter
from string import ascii_uppercase

import librosa
import numpy as np

from .analyze import Analysis, Section

# "start"/"end" mark leading/trailing silence, not musical sections.
SKIP = {"start", "end"}
SNAP_SEC = 0.15
NAMES = {"inst": "Instrumental"}


def available() -> bool:
    try:
        import allin1_infer  # noqa: F401
        return True
    except ImportError:
        return False


def analyze_allin1(audio_path) -> Analysis:
    import allin1_infer

    r = allin1_infer.analyze(str(audio_path))
    duration = float(librosa.get_duration(path=str(audio_path)))
    segs = [s for s in r.segments if s.label not in SKIP]

    downbeats = np.asarray([float(d) for d in r.downbeats])

    def snap(t: float) -> float:
        # Boundaries come from frame-level activations; pull them onto the bar line.
        if len(downbeats):
            d = downbeats[np.argmin(np.abs(downbeats - t))]
            if abs(d - t) <= SNAP_SEC:
                return float(d)
        return float(t)

    letters: dict[str, str] = {}
    names = [NAMES.get(s.label, s.label.capitalize()) for s in segs]
    totals = Counter(names)
    seen: Counter = Counter()
    sections = []
    for s, name in zip(segs, names):
        letters.setdefault(s.label, ascii_uppercase[len(letters) % 26])
        seen[name] += 1
        sections.append(Section(
            start=snap(s.start), end=snap(s.end), group=letters[s.label],
            name=f"{name} {seen[name]}" if totals[name] > 1 else name,
        ))

    positions = list(getattr(r, "beat_positions", []) or [])
    return Analysis(
        duration=duration,
        tempo=float(r.bpm),
        beats=[float(b) for b in r.beats],
        sections=sections,
        downbeats=downbeats.tolist(),
        meter=int(max(positions)) if positions else 4,
        engine="allin1",
    )
