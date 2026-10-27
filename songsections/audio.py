"""Getting audio: YouTube download and ffmpeg conversion."""
import re
import shutil
import subprocess
from pathlib import Path


def ffmpeg_exe() -> str:
    """System ffmpeg if installed, otherwise the copy bundled with imageio-ffmpeg."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def is_url(source: str) -> bool:
    return re.match(r"^https?://", source) is not None


def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name[:150] or "song"


def convert(src: Path, dst: Path, mono_sr: int | None = None) -> Path:
    """Convert any audio file with ffmpeg. mono_sr gives a mono WAV for analysis."""
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src), "-vn"]
    if mono_sr:
        cmd += ["-ac", "1", "-ar", str(mono_sr)]
    elif dst.suffix.lower() == ".mp3":
        cmd += ["-codec:a", "libmp3lame", "-q:a", "0"]
    cmd.append(str(dst))
    subprocess.run(cmd, check=True)
    return dst


def download(url: str, out_dir: Path, audio_format: str = "mp3") -> Path:
    """Download the audio of a YouTube video and convert it to mp3/wav in out_dir."""
    import yt_dlp

    tmp_dir = out_dir / ".download"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(tmp_dir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        raw = Path(ydl.prepare_filename(info))

    dst = out_dir / f"{safe_filename(info.get('title') or info['id'])}.{audio_format}"
    convert(raw, dst)
    raw.unlink(missing_ok=True)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return dst
