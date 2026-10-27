"""Source (URL or file) -> audio file + Analysis. Shared by the CLI and the web app."""
import tempfile
from pathlib import Path
from typing import Callable

from . import analyze_allin1 as allin1
from . import audio
from .analyze import SR, Analysis, analyze

Progress = Callable[[str], None]


def resolve_engine(engine: str) -> str:
    if engine == "auto":
        return "allin1" if allin1.available() else "librosa"
    if engine == "allin1" and not allin1.available():
        raise RuntimeError("allin1 engine not installed (see README)")
    return engine


def fetch(source: str, out_dir: Path, audio_format: str = "mp3",
          progress: Progress = print) -> Path:
    """Download a URL into out_dir, or return the local file path."""
    if audio.is_url(source):
        progress("Downloading audio...")
        return audio.download(source, out_dir, audio_format)
    song = Path(source)
    if not song.is_file():
        raise FileNotFoundError(f"file not found: {song}")
    return song


def run_analysis(song: Path, engine: str = "auto", n_groups: int | None = None,
                 min_bars: int = 2, progress: Progress = print) -> Analysis:
    engine = resolve_engine(engine)
    progress(f"Analyzing ({engine})...")
    with tempfile.TemporaryDirectory() as tmp:
        if engine == "allin1":
            # Full-quality stereo WAV: the model separates stems itself.
            wav = audio.convert(song, Path(tmp) / "analysis.wav")
            return allin1.analyze_allin1(wav)
        wav = audio.convert(song, Path(tmp) / "analysis.wav", mono_sr=SR)
        return analyze(wav, n_groups=n_groups, min_beats=4 * min_bars)
