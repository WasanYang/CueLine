"""On-disk song library for the web app.

library/<id>/
    meta.json      title, source, audio filename, created
    audio.<ext>    the song
    original.json  analysis as produced by the engine (for "reset")
    analysis.json  current analysis, including the user's edits
    lyrics.txt     tagged lyrics pasted by the user (optional)
    transcript.json  lyrics transcribed from the audio, with timings (optional)
"""
import json
import shutil
import time
import uuid
from pathlib import Path

from .analyze import Analysis
from .export import write_midi


class Library:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def new_dir(self) -> tuple[str, Path]:
        song_id = uuid.uuid4().hex[:10]
        d = self.root / song_id
        d.mkdir()
        return song_id, d

    def path(self, song_id: str) -> Path:
        d = (self.root / song_id).resolve()
        if d.parent != self.root.resolve() or not (d / "meta.json").is_file():
            raise KeyError(song_id)
        return d

    def save(self, song_id: str, title: str, source: str, audio_file: Path, an: Analysis) -> None:
        d = self.root / song_id
        audio_name = f"audio{audio_file.suffix.lower()}"
        if audio_file.resolve() != (d / audio_name).resolve():
            shutil.move(str(audio_file), d / audio_name)
        meta = {"title": title, "source": source, "audio": audio_name, "created": time.time()}
        _write(d / "meta.json", meta)
        _write(d / "original.json", an.to_dict())
        _write(d / "analysis.json", an.to_dict())

    def meta(self, song_id: str) -> dict:
        return _read(self.path(song_id) / "meta.json")

    def analysis(self, song_id: str) -> Analysis:
        return Analysis.from_dict(_read(self.path(song_id) / "analysis.json"))

    def original(self, song_id: str) -> Analysis:
        return Analysis.from_dict(_read(self.path(song_id) / "original.json"))

    def update_analysis(self, song_id: str, an: Analysis) -> None:
        _write(self.path(song_id) / "analysis.json", an.to_dict())

    def reset(self, song_id: str) -> Analysis:
        d = self.path(song_id)
        shutil.copyfile(d / "original.json", d / "analysis.json")
        return self.analysis(song_id)

    def lyrics(self, song_id: str) -> str:
        p = self.path(song_id) / "lyrics.txt"
        return p.read_text(encoding="utf-8") if p.is_file() else ""

    def save_lyrics(self, song_id: str, text: str) -> None:
        (self.path(song_id) / "lyrics.txt").write_text(text, encoding="utf-8")

    def transcript(self, song_id: str) -> dict | None:
        p = self.path(song_id) / "transcript.json"
        return _read(p) if p.is_file() else None

    def save_transcript(self, song_id: str, data: dict) -> None:
        _write(self.path(song_id) / "transcript.json", data)

    def audio_path(self, song_id: str) -> Path:
        return self.path(song_id) / self.meta(song_id)["audio"]

    def midi_path(self, song_id: str, tempo_mode: str = "beats") -> Path:
        return write_midi(self.analysis(song_id), self.path(song_id) / "sections.mid", tempo_mode)

    def delete(self, song_id: str) -> None:
        shutil.rmtree(self.path(song_id))

    def list(self) -> list[dict]:
        songs = []
        for d in self.root.iterdir():
            if not (d / "meta.json").is_file() or not (d / "analysis.json").is_file():
                continue
            meta, an = _read(d / "meta.json"), _read(d / "analysis.json")
            songs.append({
                "id": d.name, "title": meta["title"], "created": meta["created"],
                "duration": an["duration"], "tempo": an["tempo"],
                "engine": an.get("engine", "librosa"), "sections": len(an["sections"]),
            })
        return sorted(songs, key=lambda s: s["created"], reverse=True)


def _read(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def _write(p: Path, data: dict) -> None:
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)
