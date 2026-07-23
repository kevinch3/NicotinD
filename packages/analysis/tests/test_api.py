"""HTTP-contract tests with a fake registry — no Essentia/TensorFlow needed."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.models import AnalysisResult

VERSIONS = {"embedding": "discogs-effnet-bs64-1", "danceability": "danceability-discogs-effnet-1"}


class FakeRegistry:
    def __init__(self) -> None:
        self.analyzed: list[str] = []

    def device(self) -> str:
        return "cpu"

    def versions(self) -> dict[str, str]:
        return dict(VERSIONS)

    def analyze(self, path: str) -> AnalysisResult:
        self.analyzed.append(path)
        return AnalysisResult(
            embedding=[0.1, 0.2, 0.3],
            embedding_model="discogs-effnet-bs64-1",
            embedding_dim=3,
            features={
                "danceability": 0.8,
                "valence": 0.4,
                "acousticness": 0.1,
                "instrumental": 0.9,
                "mood": "relaxed",
            },
            model_versions=dict(VERSIONS),
        )


def make_client(tmp_path: Path, registry: FakeRegistry | None) -> TestClient:
    return TestClient(create_app(registry=registry, music_dir=str(tmp_path)))


def test_health_reports_ok_with_versions(tmp_path: Path) -> None:
    client = make_client(tmp_path, FakeRegistry())
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["device"] == "cpu"
    assert body["modelVersions"] == VERSIONS


def test_health_reports_unavailable_without_models(tmp_path: Path) -> None:
    client = make_client(tmp_path, None)
    body = client.get("/health").json()
    assert body["status"] == "unavailable"
    assert body["modelVersions"] == {}


def test_analyze_contract(tmp_path: Path) -> None:
    (tmp_path / "Artist").mkdir()
    (tmp_path / "Artist" / "song.opus").write_bytes(b"fake-audio")
    registry = FakeRegistry()
    client = make_client(tmp_path, registry)

    res = client.post("/analyze", json={"relPath": "Artist/song.opus"})
    assert res.status_code == 200
    body = res.json()
    assert body["embedding"] == {
        "model": "discogs-effnet-bs64-1",
        "dim": 3,
        "values": [0.1, 0.2, 0.3],
    }
    assert body["features"]["mood"] == "relaxed"
    assert 0.0 <= body["features"]["danceability"] <= 1.0
    assert body["modelVersions"] == VERSIONS
    # The registry received the resolved absolute path inside the music dir.
    assert registry.analyzed == [str(tmp_path / "Artist" / "song.opus")]


def test_analyze_404_for_missing_file(tmp_path: Path) -> None:
    client = make_client(tmp_path, FakeRegistry())
    assert client.post("/analyze", json={"relPath": "nope.opus"}).status_code == 404


def test_analyze_503_without_models(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")
    client = make_client(tmp_path, None)
    assert client.post("/analyze", json={"relPath": "song.opus"}).status_code == 503


def test_analyze_rejects_path_traversal(tmp_path: Path) -> None:
    outside = tmp_path.parent / "secret.opus"
    outside.write_bytes(b"secret")
    client = make_client(tmp_path, FakeRegistry())
    assert client.post("/analyze", json={"relPath": "../secret.opus"}).status_code == 400


def test_analyze_422_when_inference_fails(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")

    class ExplodingRegistry(FakeRegistry):
        def analyze(self, path: str) -> AnalysisResult:
            raise RuntimeError("decode blew up")

    client = make_client(tmp_path, ExplodingRegistry())
    assert client.post("/analyze", json={"relPath": "song.opus"}).status_code == 422


def test_analyze_includes_genre_when_present(tmp_path: Path) -> None:
    (tmp_path / "song.opus").write_bytes(b"fake-audio")

    class GenreRegistry(FakeRegistry):
        def analyze(self, path: str) -> AnalysisResult:
            result = super().analyze(path)
            result.genre = {"genre": "Rock", "style": "Alternative Rock", "confidence": 0.87}
            return result

    client = make_client(tmp_path, GenreRegistry())
    body = client.post("/analyze", json={"relPath": "song.opus"}).json()
    assert body["genre"] == {"genre": "Rock", "style": "Alternative Rock", "confidence": 0.87}


def test_analyze_genre_null_when_registry_has_none(tmp_path: Path) -> None:
    # An older sidecar build predating the genre head — no genre-parsing bug
    # should ever mask real feature data (see AnalysisResult.genre).
    (tmp_path / "song.opus").write_bytes(b"fake-audio")
    client = make_client(tmp_path, FakeRegistry())
    body = client.post("/analyze", json={"relPath": "song.opus"}).json()
    assert body["genre"] is None
    assert 0.0 <= body["features"]["danceability"] <= 1.0
