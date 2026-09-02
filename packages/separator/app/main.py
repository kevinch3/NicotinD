"""NicotinD vocal-separation sidecar.

Contract (mirrors packages/analysis; docs/vocal-separation.md):

  GET  /health  → {status: 'ok'|'unavailable', device: 'cuda'|'cpu', gpu,
                   loaded, model, modelVersion, reason}
                 `ok` includes the idle-released (cold) state — the next
                 /separate reloads. `unavailable` is structural: no CUDA
                 (unless SEPARATOR_ALLOW_CPU=1), checkpoint missing, or the
                 checkpoint failed to load once (sticky: the files are baked
                 into the image, so it will fail the same way every time).
  POST /separate {relPath} → 200 audio/flac (the INSTRUMENTAL, 44.1 kHz
                 stereo 16-bit) with X-Source-Duration-Sec / X-Separator-Model
                 400 path escapes MUSIC_DIR · 404 missing file
                 422 undecodable / shorter than 1 s / longer than
                     SEPARATOR_MAX_TRACK_SEC — a verdict on the file
                 503 no CUDA / model not loadable / worker died / timeout —
                     environmental, the caller should retry later

GPU-only by contract: CPU inference measured at RTF 4.1x (~14 min per song),
so a CPU box must report `unavailable` rather than quietly take that path.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Protocol

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .audio import probe_duration_sec
from .device import DeviceInfo, probe_device
from .idle_release import IdleReleaseGuard
from .model import MODEL_ID, MODEL_SOURCE, ModelLoadError, model_files, separate_file
from .timeouts import DEFAULT_MAX_TRACK_SEC, MIN_TRACK_SEC, separate_timeout_sec
from .worker import SeparationTimeout, SeparationWorker, WorkerDied

log = logging.getLogger("separator")

_IDLE_CHECK_INTERVAL_SEC = 30.0


class SeparateRequest(BaseModel):
    relPath: str


class Separator(Protocol):
    def separate(self, src: Path, out: Path, *, timeout_sec: float) -> dict[str, float]: ...

    def is_loaded(self) -> bool: ...

    def stop(self) -> None: ...


class WorkerSeparator:
    """The real thing: one spawned worker owning the model (see worker.py)."""

    def __init__(self, models_dir: str, device: str, max_track_sec: float) -> None:
        self._worker = SeparationWorker()
        self._models_dir = models_dir
        self._device = device
        self._max_track_sec = max_track_sec

    def separate(self, src: Path, out: Path, *, timeout_sec: float) -> dict[str, float]:
        return self._worker.run(
            separate_file,
            str(src),
            str(out),
            self._models_dir,
            self._device,
            self._max_track_sec,
            timeout_sec=timeout_sec,
        )

    def is_loaded(self) -> bool:
        return self._worker.is_alive()

    def stop(self) -> None:
        self._worker.stop()


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def create_app(
    separator: Separator | None = None,
    music_dir: str | None = None,
    models_dir: str | None = None,
    idle_release_sec: float | None = None,
    device_probe: Callable[[], DeviceInfo] | None = None,
    duration_probe: Callable[[Path], float | None] | None = None,
    allow_cpu: bool | None = None,
    max_track_sec: float | None = None,
    now: Callable[[], float] = time.monotonic,
) -> FastAPI:
    """Build the app. Tests inject a fake separator + device probe; production
    passes None and gets the spawned-worker separator over the real probe."""
    resolved_music_dir = Path(music_dir or os.environ.get("MUSIC_DIR", "/data/music")).resolve()
    resolved_models_dir = models_dir or os.environ.get("SEPARATOR_MODELS_DIR", "/models")
    resolved_idle = (
        idle_release_sec
        if idle_release_sec is not None
        else _env_float("SEPARATOR_IDLE_RELEASE_SEC", 900.0)
    )
    resolved_allow_cpu = allow_cpu if allow_cpu is not None else _env_flag("SEPARATOR_ALLOW_CPU")
    resolved_max_sec = (
        max_track_sec
        if max_track_sec is not None
        else _env_float("SEPARATOR_MAX_TRACK_SEC", DEFAULT_MAX_TRACK_SEC)
    )
    resolved_duration_probe = duration_probe or probe_duration_sec
    injected = separator is not None

    device = (device_probe or probe_device)()
    state: dict[str, str | None | bool] = {"reason": None, "load_failed": False}
    if device["device"] != "cuda" and not resolved_allow_cpu:
        state["reason"] = "no-cuda"
    elif not injected:
        ckpt, cfg = model_files(resolved_models_dir)
        if not ckpt.is_file() or not cfg.is_file():
            state["reason"] = "checkpoint-missing"

    if separator is None and state["reason"] is None:
        separator = WorkerSeparator(resolved_models_dir, device["device"], resolved_max_sec)

    guard = IdleReleaseGuard(resolved_idle, now=now)
    call_lock = threading.Lock()

    def release_if_idle() -> bool:
        if separator is None or not separator.is_loaded() or not guard.is_idle():
            return False
        separator.stop()
        log.info("idle for %.0fs — separation worker stopped, VRAM released", resolved_idle)
        return True

    async def idle_watch_loop() -> None:
        while True:
            await asyncio.sleep(_IDLE_CHECK_INTERVAL_SEC)
            release_if_idle()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        watcher = asyncio.create_task(idle_watch_loop())
        try:
            yield
        finally:
            watcher.cancel()
            if separator is not None:
                separator.stop()

    app = FastAPI(title="nicotind-separator", lifespan=lifespan)
    # Test seam: fire the idle sweep without waiting on the background task.
    app.state.release_if_idle = release_if_idle

    def current_reason() -> str | None:
        if state["load_failed"]:
            return "load-failed"
        return state["reason"]  # type: ignore[return-value]

    def resolve_track(rel_path: str) -> Path:
        candidate = (resolved_music_dir / rel_path).resolve()
        if not candidate.is_relative_to(resolved_music_dir):
            raise HTTPException(status_code=400, detail="path escapes music dir")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="file not found")
        return candidate

    @app.get("/health")
    def health() -> dict[str, object]:
        reason = current_reason()
        return {
            "status": "unavailable" if reason else "ok",
            "device": device["device"],
            "gpu": device["gpu"],
            "loaded": separator.is_loaded() if separator is not None else False,
            "model": MODEL_ID,
            "modelVersion": MODEL_SOURCE,
            "reason": reason,
        }

    @app.post("/separate")
    def separate(body: SeparateRequest) -> FileResponse:
        reason = current_reason()
        if reason or separator is None:
            raise HTTPException(status_code=503, detail=f"separator unavailable: {reason}")
        candidate = resolve_track(body.relPath)

        duration = resolved_duration_probe(candidate)
        if duration is None:
            raise HTTPException(status_code=422, detail="undecodable source")
        if duration < MIN_TRACK_SEC or duration > resolved_max_sec:
            raise HTTPException(
                status_code=422,
                detail=f"track length {duration:.1f}s outside [{MIN_TRACK_SEC}, {resolved_max_sec}]",
            )
        timeout_sec = separate_timeout_sec(duration)

        fd, tmp = tempfile.mkstemp(prefix="stem-", suffix=".flac")
        os.close(fd)
        try:
            with call_lock:
                guard.touch()
                separator.separate(candidate, Path(tmp), timeout_sec=timeout_sec)
        except ModelLoadError as err:
            _unlink(tmp)
            state["load_failed"] = True
            log.error("model failed to load — separator marked unavailable: %s", err)
            raise HTTPException(status_code=503, detail="model failed to load") from err
        except (WorkerDied, SeparationTimeout) as err:
            _unlink(tmp)
            log.error("separation worker fault for %s: %s", body.relPath, err)
            raise HTTPException(status_code=503, detail=str(err)) from err
        except Exception as err:  # per-file verdict raised inside the worker
            _unlink(tmp)
            log.warning("separation failed for %s: %s", body.relPath, err)
            raise HTTPException(status_code=422, detail="separation failed") from err

        return FileResponse(
            tmp,
            media_type="audio/flac",
            headers={"X-Source-Duration-Sec": str(duration), "X-Separator-Model": MODEL_ID},
            background=BackgroundTask(_unlink, tmp),
        )

    return app


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


app = create_app()
