"""Local web app: python -m songsections.web [--port 8765] [--library library]"""
import argparse
import queue
import shutil
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analyze_allin1 as allin1
from . import lyrics, transcribe
from .analyze import Section
from .audio import is_url, safe_filename
from .export import beat_grid
from .library import Library
from .pipeline import fetch, run_analysis

STATIC = Path(__file__).parent / "static"
CUES = Path(__file__).parent.parent / "cues"  # user-supplied samples, git-ignored
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aif", ".aiff"}


@dataclass
class Job:
    id: str
    label: str
    engine: str
    kind: str = "analyze"  # analyze | transcribe
    status: str = "queued"  # queued | running | done | error
    stage: str = "Waiting..."
    song_id: str | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None


class SectionIn(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    name: str = Field(min_length=1, max_length=60)
    group: str = Field(min_length=1, max_length=3)
    lyrics: str = Field(default="", max_length=10_000)


class LyricsIn(BaseModel):
    text: str = Field(max_length=50_000)


def create_app(library_dir: Path, cues_dir: Path = CUES) -> FastAPI:
    lib = Library(library_dir)
    jobs: dict[str, Job] = {}
    work: "queue.Queue[tuple[Job, str, Path | None]]" = queue.Queue()

    def run_analyze(job: Job, source: str, upload: Path | None, progress):
        song_id, d = lib.new_dir()
        try:
            if upload:
                song = d / f"audio{upload.suffix.lower()}"
                shutil.move(str(upload), song)
                title = Path(job.label).stem
            else:
                song = fetch(source, d, progress=progress)
                title = song.stem
            an = run_analysis(song, job.engine, progress=progress)
            lib.save(song_id, title, source, song, an)
            job.song_id = song_id
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise

    def run_transcribe(job: Job, progress):
        result = transcribe.transcribe(lib.audio_path(job.song_id),
                                       lib.path(job.song_id) / "stems", progress=progress)
        lib.save_transcript(job.song_id, result)

    def worker():
        # One job at a time: the models need the whole GPU.
        while True:
            job, source, upload = work.get()
            job.status, job.started = "running", time.time()

            def progress(msg: str):
                job.stage = msg

            try:
                if job.kind == "transcribe":
                    run_transcribe(job, progress)
                else:
                    run_analyze(job, source, upload, progress)
                job.status, job.stage = "done", "Done"
            except Exception as e:  # report any failure to the UI
                traceback.print_exc()
                job.status, job.error, job.stage = "error", str(e) or type(e).__name__, "Failed"
            finally:
                job.finished = time.time()
                if upload:
                    upload.unlink(missing_ok=True)

    threading.Thread(target=worker, daemon=True).start()
    app = FastAPI(title="SongSections")

    def get_song(song_id: str):
        try:
            return lib.path(song_id)
        except KeyError:
            raise HTTPException(404, "song not found")

    @app.get("/api/status")
    def status():
        return {"allin1": allin1.available(), "transcribe": transcribe.available()}

    @app.post("/api/songs/{song_id}/transcribe")
    def start_transcribe(song_id: str):
        get_song(song_id)
        if not transcribe.available():
            raise HTTPException(422, "transcription needs all-in-one-infer and faster-whisper")
        busy = [j for j in jobs.values() if j.kind == "transcribe" and j.song_id == song_id
                and j.status in ("queued", "running")]
        if busy:
            return asdict(busy[0])
        job = Job(id=uuid.uuid4().hex[:10], label=lib.meta(song_id)["title"], engine="whisper",
                  kind="transcribe", song_id=song_id)
        jobs[job.id] = job
        work.put((job, "", None))
        return asdict(job)

    @app.get("/api/songs/{song_id}/transcript")
    def get_transcript(song_id: str):
        get_song(song_id)
        t = lib.transcript(song_id)
        if t is None:
            raise HTTPException(404, "no transcript yet")
        return t

    @app.get("/api/songs")
    def songs():
        return lib.list()

    @app.get("/api/songs/{song_id}")
    def song(song_id: str):
        get_song(song_id)
        an = lib.analysis(song_id)
        # The quarter-note grid the MIDI export uses, so the UI shows Logic's bar numbers.
        grid = beat_grid(an).tolist()
        return {"id": song_id, **lib.meta(song_id), "analysis": an.to_dict(),
                "grid": [round(t, 4) for t in grid]}

    @app.get("/api/songs/{song_id}/audio")
    def song_audio(song_id: str):
        get_song(song_id)
        return FileResponse(lib.audio_path(song_id))

    @app.put("/api/songs/{song_id}/sections")
    def save_sections(song_id: str, sections: list[SectionIn]):
        get_song(song_id)
        an = lib.analysis(song_id)
        if not sections:
            raise HTTPException(422, "at least one section is required")
        cleaned = []
        for s in sorted(sections, key=lambda s: s.start):
            start, end = min(s.start, an.duration), min(s.end, an.duration)
            if end - start < 0.05:
                raise HTTPException(422, f"section '{s.name}' is empty")
            cleaned.append(Section(start=start, end=end, name=s.name.strip(), group=s.group,
                                   lyrics=s.lyrics))
        an.sections = cleaned
        lib.update_analysis(song_id, an)
        return an.to_dict()

    @app.get("/api/songs/{song_id}/lyrics")
    def get_lyrics(song_id: str):
        get_song(song_id)
        return {"text": lib.lyrics(song_id)}

    @app.post("/api/songs/{song_id}/fit-lyrics")
    def fit_lyrics(song_id: str, body: LyricsIn):
        """Save the tagged lyrics and propose sections from them (not saved until the user saves)."""
        get_song(song_id)
        lib.save_lyrics(song_id, body.text)
        an = lib.analysis(song_id)
        detected = lib.original(song_id).sections
        bars = beat_grid(an)[::an.meter].tolist()
        try:
            sections = lyrics.fit(lyrics.parse(body.text), detected, bars)
        except ValueError as e:
            raise HTTPException(422, str(e))
        return [asdict(s) for s in sections]

    @app.post("/api/songs/{song_id}/reset")
    def reset(song_id: str):
        get_song(song_id)
        return lib.reset(song_id).to_dict()

    @app.get("/api/songs/{song_id}/midi")
    def midi(song_id: str, tempo_mode: str = "beats"):
        get_song(song_id)
        if tempo_mode not in ("beats", "constant"):
            raise HTTPException(422, "tempo_mode must be beats or constant")
        title = safe_filename(lib.meta(song_id)["title"])
        return FileResponse(lib.midi_path(song_id, tempo_mode), media_type="audio/midi",
                            filename=f"{title}.mid")

    @app.get("/api/songs/{song_id}/download-audio")
    def download_audio(song_id: str):
        get_song(song_id)
        path = lib.audio_path(song_id)
        title = safe_filename(lib.meta(song_id)["title"])
        return FileResponse(path, filename=f"{title}{path.suffix}")

    @app.delete("/api/songs/{song_id}")
    def delete(song_id: str):
        get_song(song_id)
        lib.delete(song_id)
        return {"ok": True}

    @app.post("/api/jobs")
    async def create_job(url: str = Form(""), engine: str = Form("auto"),
                         file: UploadFile | None = File(None)):
        if engine not in ("auto", "allin1", "librosa"):
            raise HTTPException(422, "unknown engine")
        upload = None
        if file and file.filename:
            if Path(file.filename).suffix.lower() not in AUDIO_EXT:
                raise HTTPException(422, "unsupported audio file type")
            tmp_dir = lib.root / ".uploads"
            tmp_dir.mkdir(exist_ok=True)
            upload = tmp_dir / f"{uuid.uuid4().hex}{Path(file.filename).suffix.lower()}"
            with upload.open("wb") as f:
                shutil.copyfileobj(file.file, f)
            label, source = file.filename, file.filename
        elif is_url(url.strip()):
            label = source = url.strip()
        else:
            raise HTTPException(422, "give a YouTube URL or an audio file")
        job = Job(id=uuid.uuid4().hex[:10], label=label, engine=engine)
        jobs[job.id] = job
        work.put((job, source, upload))
        return asdict(job)

    @app.get("/api/jobs")
    def list_jobs():
        return sorted((asdict(j) for j in jobs.values()), key=lambda j: j["created"], reverse=True)

    @app.get("/api/cues")
    def cues():
        """Cue/click samples the user put in the cues folder (not shipped with the app)."""
        if not cues_dir.is_dir():
            return []
        return sorted(p.stem for p in cues_dir.iterdir() if p.suffix.lower() in (".wav", ".mp3"))

    if cues_dir.is_dir():
        app.mount("/cues", StaticFiles(directory=cues_dir), name="cues")
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app


def main():
    p = argparse.ArgumentParser(prog="songsections.web")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--library", default=str(Path(__file__).parent.parent / "library"),
                   help="folder for analyzed songs (default: library next to the package)")
    args = p.parse_args()

    import uvicorn
    print(f"SongSections running at http://127.0.0.1:{args.port}")
    uvicorn.run(create_app(Path(args.library)), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
