"""HTTP contract with a fake separator — no torch, no GPU."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

CUDA = {"device": "cuda", "gpu": "Quadro P4000", "arch_ok": True}
CPU = {"device": "cpu", "gpu": None, "arch_ok": False}


class FakeSeparator:
    def __init__(self, *, fail: Exception | None = None) -> None:
        self.calls: list[tuple[str, float]] = []
        self.loaded = False
        self.fail = fail

    def separate(self, src: Path, out: Path, *, timeout_sec: float) -> dict[str, float]:
        self.calls.append((str(src), timeout_sec))
        if self.fail:
            raise self.fail
        self.loaded = True
        out.write_bytes(b"fLaC" + b"\0" * 64)
        return {"duration_sec": 30.0}

    def is_loaded(self) -> bool:
        return self.loaded

    def stop(self) -> None:
        self.loaded = False


def make(tmp_path: Path, separator=None, device=CUDA, **kw) -> TestClient:
    (tmp_path / "music").mkdir(exist_ok=True)
    return TestClient(
        create_app(
            separator=separator if separator is not None else FakeSeparator(),
            music_dir=str(tmp_path / "music"),
            device_probe=lambda: device,
            duration_probe=kw.pop("duration_probe", lambda _p: 30.0),
            **kw,
        )
    )


def test_health_is_ok_and_cold_before_the_first_call(tmp_path: Path) -> None:
    body = make(tmp_path).get("/health").json()
    assert body["status"] == "ok"
    assert body["device"] == "cuda"
    assert body["gpu"] == "Quadro P4000"
    assert body["loaded"] is False
    assert body["reason"] is None
    assert body["model"] == "bs_roformer_ft1_anvuew_sdr_12.55"


def test_health_is_unavailable_without_cuda(tmp_path: Path) -> None:
    body = make(tmp_path, device=CPU).get("/health").json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "no-cuda"


def test_cpu_can_be_allowed_explicitly(tmp_path: Path) -> None:
    body = make(tmp_path, device=CPU, allow_cpu=True).get("/health").json()
    assert body["status"] == "ok"
    assert body["device"] == "cpu"


def test_separate_returns_the_flac_and_marks_loaded(tmp_path: Path) -> None:
    sep = FakeSeparator()
    client = make(tmp_path, separator=sep)
    (tmp_path / "music" / "song.mp3").write_bytes(b"x")
    res = client.post("/separate", json={"relPath": "song.mp3"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("audio/flac")
    assert res.content.startswith(b"fLaC")
    assert res.headers["x-source-duration-sec"] == "30.0"
    assert sep.calls[0][1] == 120  # timeout floor for a 30 s track
    assert client.get("/health").json()["loaded"] is True


def test_separate_refuses_to_run_without_cuda(tmp_path: Path) -> None:
    client = make(tmp_path, device=CPU)
    (tmp_path / "music" / "song.mp3").write_bytes(b"x")
    assert client.post("/separate", json={"relPath": "song.mp3"}).status_code == 503


def test_separate_rejects_path_escape_and_missing_file(tmp_path: Path) -> None:
    client = make(tmp_path)
    assert client.post("/separate", json={"relPath": "../etc/passwd"}).status_code == 400
    assert client.post("/separate", json={"relPath": "nope.mp3"}).status_code == 404


@pytest.mark.parametrize("duration", [0.5, 901.0, None])
def test_separate_422s_on_undecodable_too_short_or_too_long(tmp_path: Path, duration) -> None:
    client = make(tmp_path, duration_probe=lambda _p: duration)
    (tmp_path / "music" / "song.mp3").write_bytes(b"x")
    res = client.post("/separate", json={"relPath": "song.mp3"})
    assert res.status_code == 422


def test_worker_faults_are_503_not_422(tmp_path: Path) -> None:
    from app.worker import SeparationTimeout, WorkerDied

    for err in (WorkerDied("gone"), SeparationTimeout("slow")):
        client = make(tmp_path, separator=FakeSeparator(fail=err))
        (tmp_path / "music" / "song.mp3").write_bytes(b"x")
        assert client.post("/separate", json={"relPath": "song.mp3"}).status_code == 503


def test_a_per_file_failure_inside_the_worker_is_422(tmp_path: Path) -> None:
    client = make(tmp_path, separator=FakeSeparator(fail=ValueError("undecodable")))
    (tmp_path / "music" / "song.mp3").write_bytes(b"x")
    assert client.post("/separate", json={"relPath": "song.mp3"}).status_code == 422


def test_a_model_load_failure_is_sticky_in_health(tmp_path: Path) -> None:
    from app.model import ModelLoadError

    client = make(tmp_path, separator=FakeSeparator(fail=ModelLoadError("ckpt mismatch")))
    (tmp_path / "music" / "song.mp3").write_bytes(b"x")
    assert client.post("/separate", json={"relPath": "song.mp3"}).status_code == 503
    body = client.get("/health").json()
    assert body["status"] == "unavailable"
    assert body["reason"] == "load-failed"


def test_idle_release_stops_the_worker_but_health_stays_ok(tmp_path: Path) -> None:
    clock = {"t": 0.0}
    sep = FakeSeparator()
    client = make(tmp_path, separator=sep, idle_release_sec=100, now=lambda: clock["t"])
    (tmp_path / "music" / "song.mp3").write_bytes(b"x")
    client.post("/separate", json={"relPath": "song.mp3"})
    assert client.get("/health").json()["loaded"] is True
    clock["t"] += 101
    assert client.app.state.release_if_idle() is True
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["loaded"] is False
