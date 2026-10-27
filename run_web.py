"""Start the SongSections web app from any working directory."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from songsections.web import main  # noqa: E402

main()
