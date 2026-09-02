"""Pure-function tests for rank_bpm_candidates — the octave-alternatives list.

Exists because 152 vs 76 on a dembow track is a metrical-level ambiguity, not a
detector error: RhythmExtractor2013 is deterministic, so re-running it can never
offer the curator a second reading. The candidate list is what makes the choice
available. See issue #876.
"""

from app.rhythm import (
    CANDIDATE_TOLERANCE_BPM,
    MAX_CANDIDATES,
    MAX_PLAUSIBLE_BPM,
    MIN_PLAUSIBLE_BPM,
    rank_bpm_candidates,
)


def test_primary_is_always_first() -> None:
    assert rank_bpm_candidates(152.0, [])[0] == 152.0


def test_half_and_double_are_offered_for_the_reported_case() -> None:
    # Bad Bunny "Un coco": stored 152, actually felt around 76.
    out = rank_bpm_candidates(152.0, [])
    assert out[:2] == [152.0, 76.0]
    # 304 is beyond any plausible tempo, so double is dropped rather than shown.
    assert 304.0 not in out


def test_double_is_offered_when_it_lands_in_range() -> None:
    out = rank_bpm_candidates(73.0, [])
    assert 146.0 in out


def test_octave_alternatives_outrank_estimates() -> None:
    # The octave fix is the reason this list exists, so it comes before the
    # extractor's own per-window readings.
    out = rank_bpm_candidates(120.0, [95.0])
    assert out.index(60.0) < out.index(95.0)


def test_estimates_within_tolerance_of_an_existing_candidate_are_dropped() -> None:
    # RhythmExtractor2013's estimates cluster tightly around the winner; those
    # are the same tempo, not a second opinion.
    near = 152.0 + CANDIDATE_TOLERANCE_BPM / 2
    assert rank_bpm_candidates(152.0, [near]) == [152.0, 76.0]


def test_estimates_beyond_tolerance_are_kept_as_distinct_readings() -> None:
    out = rank_bpm_candidates(152.0, [98.0])
    assert 98.0 in out


def test_implausible_values_are_clamped_out() -> None:
    out = rank_bpm_candidates(152.0, [MIN_PLAUSIBLE_BPM - 1, MAX_PLAUSIBLE_BPM + 1])
    assert all(MIN_PLAUSIBLE_BPM <= c <= MAX_PLAUSIBLE_BPM for c in out)


def test_an_implausible_primary_still_leads_the_list() -> None:
    # Never hide the detector's actual answer: the curator needs to see what is
    # stored in order to recognise it as wrong.
    out = rank_bpm_candidates(12.0, [])
    assert out[0] == 12.0


def test_the_list_is_bounded() -> None:
    estimates = [60.0 + 7 * i for i in range(30)]
    assert len(rank_bpm_candidates(152.0, estimates)) <= MAX_CANDIDATES


def test_non_finite_and_non_positive_inputs_are_ignored() -> None:
    out = rank_bpm_candidates(152.0, [float("nan"), float("inf"), 0.0, -90.0])
    assert out == [152.0, 76.0]


def test_values_are_rounded_to_one_decimal() -> None:
    out = rank_bpm_candidates(151.99999, [])
    assert out[0] == 152.0


def test_a_result_always_offers_at_least_its_own_bpm() -> None:
    # The HTTP contract promises a non-empty list; enforcing it on the
    # dataclass covers every construction site, fakes included.
    from app.rhythm import RhythmResult

    assert RhythmResult(bpm=141.9, confidence=2.92, method="multifeature").candidates == [141.9]
