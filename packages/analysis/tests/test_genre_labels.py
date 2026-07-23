"""Integrity check for the bundled genre_discogs400 label asset — guards
against a truncated/corrupted data file (see app/genre_labels.py)."""

from app.genre_labels import GENRE_LABELS


def test_genre_labels_has_400_entries() -> None:
    assert len(GENRE_LABELS) == 400


def test_genre_labels_are_unique_non_empty_strings() -> None:
    assert len(set(GENRE_LABELS)) == 400
    assert all(isinstance(label, str) and label for label in GENRE_LABELS)
