"""Discogs genre/style vocabulary for the genre_discogs400 classification
head (issue #187 task A2) — the 400 "Genre---Style" class labels, in the
exact order the model's sigmoid output is indexed, as published in Essentia's
model metadata JSON. Bundled as a committed data file rather than
hand-transcribed, since it's data, not code; paired with the `.pb` weights
pinned in the Dockerfile.
"""

from __future__ import annotations

import json
from pathlib import Path

_LABELS_PATH = Path(__file__).parent / "data" / "genre_discogs400_labels.json"
GENRE_LABELS: tuple[str, ...] = tuple(json.loads(_LABELS_PATH.read_text()))
