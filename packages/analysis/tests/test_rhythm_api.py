"""HTTP-contract tests for POST /rhythm with a fake analyzer — no Essentia needed."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.rhythm import RhythmResult


class FakeRhythmAnalyzer:
    def __init__(self) -> None:
        self.analyzed: list[str] = []

    def analyze(self, path: str) -> RhythmResult:
        self.analyzed.append(path)
        return RhythmResult(bpm=141.9, confidence=2.92, method="multifeature")


def make_client(tmp_path: Path, rhythm: FakeRhythmAnalyzer | None) -> TestClient:
    return TestClient(create_app(registry=None, music_dir=str(tmp_path), rhythm=rhythm))


def test_rhythm_contract(tmp_path: Path) -> None:
    (tmp_path / "Artist").mkdir()
    (tmp_path / "Artist" / "song.opus").write_bytes(b"fake-audio")
    analyzer = FakeRhythmAnalyzer()
    client = make_client(tmp_path, analyzer)

    res = client.post("/rhythm", json={"relPath": "Artist/song.opus"})
    assert res.status_code == 200
    body = res.json()
    assert body == {"bpm": 141.9, "confidence": 2.92, "method": "multifeature"}
    # The analyzer received the resolved absolute path inside the music dir.
    assert analyzer.analyzed == [str(tmp_path / "Artist" / "song.opus")]


def test_rhythm_404_for_missing_file(tmp_path: Path) -> None:
    client = make_client(tmp_path, FakeRhythmAnalyzer())
    assert client.post("/rhythm", json={"relPath": "nope.opus"}).status_code == 404


def test_rhythm_503_without_analyzer(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")
    client = make_client(tmp_path, None)
    assert client.post("/rhythm", json={"relPath": "song.opus"}).status_code == 503


def test_rhythm_rejects_path_traversal(tmp_path: Path) -> None:
    outside = tmp_path.parent / "secret.opus"
    outside.write_bytes(b"secret")
    client = make_client(tmp_path, FakeRhythmAnalyzer())
    assert client.post("/rhythm", json={"relPath": "../secret.opus"}).status_code == 400


def test_rhythm_422_when_analysis_fails(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")

    class ExplodingAnalyzer(FakeRhythmAnalyzer):
        def analyze(self, path: str) -> RhythmResult:
            raise RuntimeError("decode blew up")

    client = make_client(tmp_path, ExplodingAnalyzer())
    assert client.post("/rhythm", json={"relPath": "song.opus"}).status_code == 422


def test_health_reports_rhythm_availability(tmp_path: Path) -> None:
    with_rhythm = make_client(tmp_path, FakeRhythmAnalyzer())
    assert with_rhythm.get("/health").json()["rhythm"] is True
    without = make_client(tmp_path, None)
    assert without.get("/health").json()["rhythm"] is False
