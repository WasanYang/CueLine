"""Beat tracking and section segmentation.

Segmentation follows the Laplacian structural decomposition of McFee & Ellis (2014),
as in the librosa example gallery: a beat-synchronous recurrence graph (harmony) plus
a local-continuity graph (timbre), clustered with spectral clustering. Beats in the
same cluster share a letter (A, B, C...); section names are guessed from repetition
and loudness, so treat them as suggestions.
"""
from dataclasses import dataclass, asdict, field
from string import ascii_uppercase

import librosa
import numpy as np
import scipy.linalg
import scipy.ndimage
import scipy.sparse.csgraph
from sklearn.cluster import KMeans

SR = 22050
HOP = 512


@dataclass
class Section:
    start: float  # seconds
    end: float
    group: str  # same letter = same musical material
    name: str = ""  # guessed role, e.g. "Chorus 2"
    energy_db: float = 0.0
    lyrics: str = ""


@dataclass
class Analysis:
    duration: float
    tempo: float
    beats: list[float]
    sections: list[Section]
    downbeats: list[float] = field(default_factory=list)  # empty if unknown
    meter: int = 4  # beats per bar
    engine: str = "librosa"

    def to_dict(self) -> dict:
        return {
            "engine": self.engine,
            "duration": round(self.duration, 3),
            "tempo": round(self.tempo, 2),
            "meter": self.meter,
            "beats": [round(b, 4) for b in self.beats],
            "downbeats": [round(b, 4) for b in self.downbeats],
            "sections": [asdict(s) for s in self.sections],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Analysis":
        return cls(
            duration=d["duration"], tempo=d["tempo"], beats=d["beats"],
            sections=[Section(**s) for s in d["sections"]],
            downbeats=d.get("downbeats", []), meter=d.get("meter", 4),
            engine=d.get("engine", "librosa"),
        )


def analyze(wav_path, n_groups: int | None = None, min_beats: int = 8) -> Analysis:
    y, sr = librosa.load(wav_path, sr=SR, mono=True)
    duration = len(y) / sr

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP, trim=False)
    tempo = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)

    cqt = librosa.amplitude_to_db(
        np.abs(librosa.cqt(y=y, sr=sr, hop_length=HOP, bins_per_octave=36, n_bins=7 * 36)),
        ref=np.max,
    )
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP, n_mfcc=13)
    rms = librosa.feature.rms(y=y, hop_length=HOP)
    n_frames = min(cqt.shape[1], mfcc.shape[1], rms.shape[1])

    # Column i of the synced features covers [bounds[i], bounds[i+1]).
    bounds = librosa.util.fix_frames(beat_frames, x_min=0, x_max=n_frames)
    times = librosa.frames_to_time(bounds, sr=sr, hop_length=HOP)
    times[-1] = duration
    c_sync = librosa.util.sync(cqt[:, :n_frames], bounds, aggregate=np.median, pad=False)
    m_sync = librosa.util.sync(mfcc[:, :n_frames], bounds, pad=False)
    energy = librosa.amplitude_to_db(librosa.util.sync(rms[:, :n_frames], bounds, pad=False)[0])

    n = c_sync.shape[1]
    if n < 4 * min_beats:
        labels = np.zeros(n, dtype=int)
        embedding = np.zeros((n, 1))
    else:
        labels, embedding = _cluster_beats(c_sync, m_sync, n_groups)

    segments = _segments_from_labels(labels, embedding, min_beats)
    sections = []
    for ((a, b), _), letter in zip(segments, _letters([lab for _, lab in segments])):
        sections.append(Section(
            start=float(times[a]), end=float(times[b]), group=letter,
            energy_db=round(float(np.mean(energy[a:b])), 2),
        ))
    _guess_names(sections)
    return Analysis(duration, tempo, beat_times.tolist(), sections)


def _cluster_beats(c_sync, m_sync, n_groups):
    # Long-range repetition (harmony), filtered along time lag to favour diagonals.
    rec = librosa.segment.recurrence_matrix(c_sync, width=3, mode="affinity", sym=True)
    rec = librosa.segment.timelag_filter(scipy.ndimage.median_filter)(rec, size=(1, 7))

    # Short-range continuity (timbre) between neighbouring beats.
    path_dist = np.sum(np.diff(m_sync, axis=1) ** 2, axis=0)
    path_sim = np.exp(-path_dist / np.median(path_dist))
    r_path = np.diag(path_sim, k=1) + np.diag(path_sim, k=-1)

    deg_path, deg_rec = r_path.sum(axis=1), rec.sum(axis=1)
    mu = deg_path.dot(deg_path + deg_rec) / np.sum((deg_path + deg_rec) ** 2)
    graph = mu * rec + (1 - mu) * r_path

    lap = scipy.sparse.csgraph.laplacian(graph, normed=True)
    evals, evecs = scipy.linalg.eigh(lap)
    evecs = scipy.ndimage.median_filter(evecs, size=(9, 1))

    if n_groups is None:
        # Eigengap heuristic over a plausible range of distinct section types.
        candidates = range(3, min(9, len(evals) - 1))
        n_groups = max(candidates, key=lambda k: evals[k] - evals[k - 1])

    norm = np.cumsum(evecs ** 2, axis=1) ** 0.5
    x = evecs[:, :n_groups] / norm[:, n_groups - 1:n_groups]
    labels = KMeans(n_clusters=n_groups, n_init=10, random_state=0).fit_predict(x)
    return labels, x


def _segments_from_labels(labels, embedding, min_beats):
    """Runs of equal labels -> [((start_beat, end_beat), label)], with short runs merged away."""
    change = np.flatnonzero(labels[1:] != labels[:-1]) + 1
    starts = [0, *change.tolist()]
    ends = [*change.tolist(), len(labels)]
    segs = [[a, b, int(labels[a])] for a, b in zip(starts, ends)]

    def centroid(seg):
        return embedding[seg[0]:seg[1]].mean(axis=0)

    while len(segs) > 1:
        lengths = [b - a for a, b, _ in segs]
        i = int(np.argmin(lengths))
        if lengths[i] >= min_beats:
            break
        # Merge into the neighbour that sounds most alike.
        neighbours = [j for j in (i - 1, i + 1) if 0 <= j < len(segs)]
        j = min(neighbours, key=lambda j: np.linalg.norm(centroid(segs[i]) - centroid(segs[j])))
        lo, hi = sorted((i, j))
        segs[lo] = [segs[lo][0], segs[hi][1], segs[j][2]]
        del segs[hi]
        # Neighbours may now share a label.
        merged = [segs[0]]
        for s in segs[1:]:
            if s[2] == merged[-1][2]:
                merged[-1][1] = s[1]
            else:
                merged.append(s)
        segs = merged
    return [((a, b), lab) for a, b, lab in segs]


def _letters(labels):
    """Relabel clusters A, B, C... in order of first appearance."""
    order = {}
    for lab in labels:
        order.setdefault(lab, ascii_uppercase[len(order) % 26])
    return [order[lab] for lab in labels]


def _guess_names(sections: list[Section]) -> None:
    groups: dict[str, list[int]] = {}
    for i, s in enumerate(sections):
        groups.setdefault(s.group, []).append(i)

    def loudness(g):
        idx = groups[g]
        w = [sections[i].end - sections[i].start for i in idx]
        return np.average([sections[i].energy_db for i in idx], weights=w)

    last = len(sections) - 1
    # Material heard only at the very start and end (e.g. intro reprised as outro).
    edges = {g for g, idx in groups.items() if len(idx) >= 2 and set(idx) <= {0, last}}
    repeated = [g for g, idx in groups.items() if len(idx) >= 2 and g not in edges]
    role: dict[str, str] = {}
    if repeated:
        chorus = max(repeated, key=lambda g: (loudness(g), len(groups[g])))
        role[chorus] = "Chorus"
        before_chorus = {i + 1 for i in groups[chorus]}
        for g in repeated:
            if g in role:
                continue
            # A part that mostly leads straight into the chorus.
            hits = sum(1 for i in groups[g] if i + 1 in before_chorus)
            if hits >= max(2, len(groups[g]) / 2) and "Pre-Chorus" not in role.values():
                role[g] = "Pre-Chorus"
        rest = [g for g in repeated if g not in role]
        if rest:
            role[min(rest, key=lambda g: groups[g][0])] = "Verse"

    names = []
    for i, s in enumerate(sections):
        unique = len(groups[s.group]) == 1 or s.group in edges
        if s.group in role:
            names.append(role[s.group])
        elif unique and i == 0 and len(sections) > 1:
            names.append("Intro")
        elif unique and i == last and len(sections) > 1:
            names.append("Outro")
        elif len(groups[s.group]) == 1:
            names.append("Bridge")
        else:
            names.append(f"Part {s.group}")

    totals = {n: names.count(n) for n in names}
    seen: dict[str, int] = {}
    for s, n in zip(sections, names):
        seen[n] = seen.get(n, 0) + 1
        s.name = f"{n} {seen[n]}" if totals[n] > 1 else n
