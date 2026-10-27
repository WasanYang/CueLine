"""Lyrics transcription: isolate vocals with HTDemucs (bundled with all-in-one-infer),
then transcribe them with Whisper via faster-whisper.

Whisper is trained mostly on speech; sung lyrics (long notes, harmonies, crowd noise)
come out with errors, so the result is a draft to correct by hand.
"""
import gc
import shutil
from pathlib import Path
from typing import Callable

from .analyze import Section

MODEL = "large-v3-turbo"  # ~0.8B params; fits a 4 GB GPU in int8_float16


def available() -> bool:
    try:
        import allin1_infer  # noqa: F401
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe(audio_path: Path, work_dir: Path, language: str = "th", model_size: str = MODEL,
               progress: Callable[[str], None] = print) -> dict:
    # torch first: on Windows it puts the CUDA DLLs that ctranslate2 also needs on the path.
    import torch
    from allin1_infer.stems import get_stems

    progress("Separating vocals...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        stems = get_stems([Path(audio_path)], work_dir, device=device)
        vocals = stems[0] / "vocals.wav"
        if not vocals.is_file():
            raise RuntimeError("vocal separation failed")

        progress("Transcribing lyrics...")
        torch.cuda.empty_cache()
        try:
            segments, used = _whisper(vocals, language, model_size, "cuda" if device == "cuda" else "cpu")
        except RuntimeError as e:
            if device != "cuda":
                raise
            # Not enough GPU memory (or CUDA libs missing): CPU is slower but works.
            print(f"GPU transcription failed ({e}); retrying on CPU")
            progress("Transcribing lyrics (CPU)...")
            segments, used = _whisper(vocals, language, model_size, "cpu")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
    return {"model": model_size, "device": used, "language": language, "segments": segments}


def _whisper(vocals: Path, language: str, model_size: str, device: str):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device=device,
                         compute_type="int8_float16" if device == "cuda" else "int8")
    try:
        segs, _ = model.transcribe(
            str(vocals), language=language, beam_size=5, vad_filter=True,
            # Each line on its own: avoids Whisper looping on repeated choruses.
            condition_on_previous_text=False,
        )
        out = [{"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
               for s in segs if s.text.strip()]
    finally:
        del model
        gc.collect()
    return out, device


def lyrics_by_section(segments: list[dict], sections: list[Section]) -> list[str]:
    """Put each transcribed line into the section where it is sung (by its midpoint)."""
    texts: list[list[str]] = [[] for _ in sections]
    for seg in segments:
        mid = (seg["start"] + seg["end"]) / 2
        i = next((k for k, s in enumerate(sections) if s.start <= mid < s.end), len(sections) - 1)
        texts[i].append(seg["text"])
    return ["\n".join(t) for t in texts]
