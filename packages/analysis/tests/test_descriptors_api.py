"""HTTP-contract tests for POST /descriptors with a fake analyzer — no Essentia."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.descriptors import DescriptorResult
from app.main import create_app

FEATURES = {"mfcc_0": -700.0, "spectral_centroid": 1138.3, "swing_ratio": None, "bpm": 150.0}


class FakeDescriptorAnalyzer:
    def __init__(self) -> None:
        self.analyzed: list[str] = []

    def analyze(self, path: str) -> DescriptorResult:
        self.analyzed.append(path)
        return DescriptorResult(version=1, features=dict(FEATURES))


def make_client(tmp_path: Path, descriptors: FakeDescriptorAnalyzer | None) -> TestClient:
    return TestClient(
        create_app(registry=None, music_dir=str(tmp_path), descriptors=descriptors),
    )


def test_descriptors_contract(tmp_path: Path) -> None:
    (tmp_path / "Artist").mkdir()
    (tmp_path / "Artist" / "song.opus").write_bytes(b"fake-audio")
    analyzer = FakeDescriptorAnalyzer()
    client = make_client(tmp_path, analyzer)

    res = client.post("/descriptors", json={"relPath": "Artist/song.opus"})
    assert res.status_code == 200
    assert res.json() == {"version": 1, "features": FEATURES}
    assert analyzer.analyzed == [str(tmp_path / "Artist" / "song.opus")]


def test_descriptors_404_for_missing_file(tmp_path: Path) -> None:
    client = make_client(tmp_path, FakeDescriptorAnalyzer())
    assert client.post("/descriptors", json={"relPath": "nope.opus"}).status_code == 404


def test_descriptors_503_without_analyzer(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")
    client = make_client(tmp_path, None)
    assert client.post("/descriptors", json={"relPath": "song.opus"}).status_code == 503


def test_descriptors_rejects_path_traversal(tmp_path: Path) -> None:
    outside = tmp_path.parent / "secret.opus"
    outside.write_bytes(b"secret")
    client = make_client(tmp_path, FakeDescriptorAnalyzer())
    assert client.post("/descriptors", json={"relPath": "../secret.opus"}).status_code == 400


def test_descriptors_422_when_analysis_fails(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")

    class ExplodingAnalyzer(FakeDescriptorAnalyzer):
        def analyze(self, path: str) -> DescriptorResult:
            raise RuntimeError("decode blew up")

    client = make_client(tmp_path, ExplodingAnalyzer())
    assert client.post("/descriptors", json={"relPath": "song.opus"}).status_code == 422


def test_health_reports_descriptors_availability(tmp_path: Path) -> None:
    # Independent of the TF registry: /descriptors needs no model files, so a
    # models-less build (registry=None → status "unavailable") still serves it.
    with_it = make_client(tmp_path, FakeDescriptorAnalyzer())
    body = with_it.get("/health").json()
    assert body["descriptors"] is True
    assert body["status"] == "unavailable"
    without = make_client(tmp_path, None)
    assert without.get("/health").json()["descriptors"] is False
