"""Convert a chord sheet to [Tag] lyrics, from any working directory.

Usage: python convert_lyrics.py sheet.txt [-o out.txt]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from songsections.lyrics import _main  # noqa: E402

_main()
