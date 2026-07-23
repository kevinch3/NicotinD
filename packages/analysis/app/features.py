"""Pure mapping from raw model-head outputs to the feature contract.

No Essentia/TensorFlow imports here — everything is plain-Python and fully
unit-testable without models. The class ORDER of each Essentia MTG head is
inconsistent across heads (some positive-first, some negative-first), so the
positive-class index is encoded per head, verified against the published
model-metadata JSONs (see the model table in the Dockerfile).
"""

from __future__ import annotations

# Index of the "positive" class in each head's 2-prob softmax output.
POSITIVE_CLASS_INDEX: dict[str, int] = {
    "danceability": 0,  # ['danceable', 'not_danceable']
    "mood_happy": 0,  # ['happy', 'non_happy']
    "mood_sad": 1,  # ['non_sad', 'sad']
    "mood_aggressive": 0,  # ['aggressive', 'not_aggressive']
    "mood_relaxed": 1,  # ['non_relaxed', 'relaxed']
    "mood_party": 1,  # ['non_party', 'party']
    "mood_acoustic": 0,  # ['acoustic', 'non_acoustic']
    "voice_instrumental": 0,  # ['instrumental', 'voice']
}

# Mood label -> head name; the served `mood` is the argmax over these.
MOOD_HEADS: dict[str, str] = {
    "happy": "mood_happy",
    "sad": "mood_sad",
    "aggressive": "mood_aggressive",
    "relaxed": "mood_relaxed",
    "party": "mood_party",
}

MOOD_VOCAB = tuple(MOOD_HEADS.keys())


def clamp01(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


def head_probability(head: str, probs: list[float]) -> float:
    """Positive-class probability for one head's (frame-averaged) softmax pair."""
    idx = POSITIVE_CLASS_INDEX[head]
    if len(probs) <= idx:
        raise ValueError(f"head {head!r} produced {len(probs)} probs, need > {idx}")
    return clamp01(probs[idx])


def normalize_valence(raw: float) -> float:
    """Map the emomusic regression output (1..9 scale) to 0..1."""
    return clamp01((float(raw) - 1.0) / 8.0)


def derive_features(heads: dict[str, list[float]], valence_raw: float) -> dict[str, float | str]:
    """Combine head outputs into the served feature dict (all scores 0..1)."""
    mood_scores = {label: head_probability(head, heads[head]) for label, head in MOOD_HEADS.items()}
    mood = max(mood_scores, key=lambda label: mood_scores[label])
    return {
        "danceability": head_probability("danceability", heads["danceability"]),
        "valence": normalize_valence(valence_raw),
        "acousticness": head_probability("mood_acoustic", heads["mood_acoustic"]),
        "instrumental": head_probability("voice_instrumental", heads["voice_instrumental"]),
        "mood": mood,
    }


def derive_genre(probs: list[float], labels: list[str]) -> dict[str, object]:
    """Top-1 label from the genre_discogs400 multi-label sigmoid head
    (issue #187 task A2 — an audio-inferred fallback, below tag/MusicBrainz
    genres). Discogs' vocabulary encodes each class as "Genre---Style" (e.g.
    "Rock---Alternative Rock"); splitting gives a coarse parent genre plus
    the specific style. A label with no separator is a bare genre.
    """
    if not probs or len(probs) != len(labels):
        raise ValueError(f"expected {len(labels)} probs, got {len(probs)}")
    idx = max(range(len(probs)), key=lambda i: probs[i])
    genre, _, style = labels[idx].partition("---")
    return {"genre": genre, "style": style or None, "confidence": clamp01(probs[idx])}
