"""Write sections as a Standard MIDI File with markers and a tempo map for Logic Pro.

Open the file with File > Open in Logic (not File > Import): import drops tempo and
other global data, open keeps markers and tempo.
"""
import json
from pathlib import Path

import mido
import numpy as np

from .analyze import Analysis

TPB = 480  # ticks per quarter note
MAX_BPM = 900  # Logic's tempo range tops out just under 1000 BPM


def beat_grid(an: Analysis, mode: str = "beats") -> np.ndarray:
    """Times (s) of every quarter note from 0 to past the end of the song.

    "beats": one quarter per detected beat, so bars follow the song (beat mapping).
    "constant": one fixed tempo (the estimated BPM) from time 0.
    """
    beats = np.asarray(an.beats, dtype=float)
    if mode == "constant" or len(beats) < 2:
        period = 60.0 / an.tempo
        return np.arange(0.0, an.duration + 2 * period, period)

    period = float(np.median(np.diff(beats)))
    # Split the lead-in before the first beat into whole quarters.
    n_pre = max(1, round(beats[0] / period)) if beats[0] > 0.05 else 0
    if an.downbeats and n_pre:
        # Pad the lead-in so the first downbeat falls on a bar line.
        first_down = int(np.argmin(np.abs(beats - an.downbeats[0])))
        extra = -(n_pre + first_down) % an.meter
        if beats[0] / (n_pre + extra) >= 60.0 / MAX_BPM:
            n_pre += extra
    pre = np.linspace(0.0, beats[0], n_pre + 1)[:-1] if n_pre else np.array([0.0])
    if not n_pre:
        beats = beats[1:]
    post_count = int(np.ceil(max(0.0, an.duration - beats[-1]) / period)) + 1
    post = beats[-1] + period * np.arange(1, post_count + 1)
    return np.concatenate([pre, beats, post])


def seconds_to_tick(t: float, grid: np.ndarray) -> int:
    i = int(np.clip(np.searchsorted(grid, t, side="right") - 1, 0, len(grid) - 2))
    frac = (t - grid[i]) / (grid[i + 1] - grid[i])
    return int(round((i + frac) * TPB))


def write_midi(an: Analysis, path: Path, tempo_mode: str = "beats") -> Path:
    grid = beat_grid(an, tempo_mode)
    events: list[tuple[int, int, mido.MetaMessage]] = [
        (0, 0, mido.MetaMessage("track_name", name="Song Sections")),
        (0, 0, mido.MetaMessage("time_signature", numerator=an.meter, denominator=4)),
    ]
    if tempo_mode == "constant":
        events.append((0, 1, mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(an.tempo))))
    else:
        last = None
        for i in range(len(grid) - 1):
            us = int(round((grid[i + 1] - grid[i]) * 1e6))
            if us != last:
                events.append((i * TPB, 1, mido.MetaMessage("set_tempo", tempo=us)))
                last = us
    for s in an.sections:
        events.append((seconds_to_tick(s.start, grid), 2,
                       mido.MetaMessage("marker", text=f"{s.name} [{s.group}]")))
    end_tick = seconds_to_tick(an.duration, grid)

    track = mido.MidiTrack()
    now = 0
    for tick, _, msg in sorted(events, key=lambda e: (e[0], e[1])):
        track.append(msg.copy(time=tick - now))
        now = tick
    track.append(mido.MetaMessage("end_of_track", time=max(0, end_tick - now)))

    # UTF-8 so section names typed in Thai survive; plain ASCII names are unaffected.
    mid = mido.MidiFile(type=1, ticks_per_beat=TPB, charset="utf-8")
    mid.tracks.append(track)
    mid.save(path)
    return path


def write_json(an: Analysis, path: Path) -> Path:
    path.write_text(json.dumps(an.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
    return path
