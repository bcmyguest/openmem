"""Make indexer/index_config.py importable, as it is in the image via PYTHONPATH=/opt/indexer."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
