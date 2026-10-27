"""CLI: python -m songsections <youtube-url | audio-file> [options]"""
import argparse
import sys
from pathlib import Path

from .export import write_json, write_midi
from .pipeline import fetch, run_analysis


def fmt_time(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:05.2f}"


def main(argv=None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(prog="songsections", description=__doc__)
    p.add_argument("source", help="YouTube URL or path to an audio file")
    p.add_argument("-o", "--out", default="output", help="output folder (default: output)")
    p.add_argument("--format", choices=["mp3", "wav"], default="mp3",
                   help="audio format when downloading from YouTube (default: mp3)")
    p.add_argument("--engine", choices=["auto", "allin1", "librosa"], default="auto",
                   help="allin1 (AI model, if installed) or librosa (default: auto)")
    p.add_argument("--groups", type=int, default=None,
                   help="librosa engine: number of distinct section types (default: auto)")
    p.add_argument("--min-bars", type=int, default=2,
                   help="shortest allowed section in 4/4 bars (default: 2)")
    p.add_argument("--tempo-mode", choices=["beats", "constant"], default="beats",
                   help="MIDI tempo map: follow every beat, or one fixed BPM (default: beats)")
    args = p.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        song = fetch(args.source, out_dir, args.format)
        an = run_analysis(song, args.engine, args.groups, args.min_bars)
    except (FileNotFoundError, RuntimeError) as e:
        p.error(str(e))

    mid = write_midi(an, out_dir / f"{song.stem}.mid", args.tempo_mode)
    js = write_json(an, out_dir / f"{song.stem}.json")

    print(f"\nTempo ~{an.tempo:.1f} BPM, {len(an.sections)} sections\n")
    print(f"{'Start':>9}  {'End':>9}  Grp  Name")
    for s in an.sections:
        print(f"{fmt_time(s.start):>9}  {fmt_time(s.end):>9}  {s.group:^3}  {s.name}")
    print(f"\nMIDI: {mid}\nJSON: {js}")
    print("In Logic Pro: File > Open the .mid (not Import), then drag the audio to bar 1.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
