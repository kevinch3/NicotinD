"""FastAPI app for the analysis sidecar.

Contract (consumed by @nicotind/api's AudioFeaturesClient):

  GET  /health            -> { status, device, modelVersions, rhythm, descriptors }
  POST /analyze {relPath} -> { embedding: {model, dim, values},
                               features: {danceability, valence, acousticness,
                                          instrumental, mood},
                               genre: {genre, style, confidence} | null,
                               modelVersions }
  POST /rhythm  {relPath} -> { bpm, confidence, method }
  POST /descriptors {relPath} -> { version, features: {<DESCRIPTOR_NAMES>: float|null} }

`/rhythm` and `/descriptors` need no model files and are independent of the TF
registry — a models-less build still serves both (status "unavailable" refers
to /analyze only; read the per-endpoint booleans).

`genre` is a sibling of `features` (issue #187 task A2, an audio-inferred
genre fallback) — null only for a sidecar build older than the genre head;
once loaded, every /analyze response carries it, the same as every other
model.

`relPath` is resolved against MUSIC_DIR (the same volume the API mounts), so
the two containers never need matching absolute mount points. 404 for a file
that doesn't exist, 503 while models are unavailable.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .descriptors import DescriptorAnalyzer
from .idle_release import IdleReleaseGuard, RegistryHolder
from .models import ModelRegistry
from .rhythm import RhythmAnalyzer

log = logging.getLogger("analysis")

# How often the background watcher checks for idleness — a small fraction of
# the release window is plenty of resolution without busy-polling.
_IDLE_CHECK_INTERVAL_SEC = 30.0


class AnalyzeRequest(BaseModel):
    relPath: str


def _load_real_registry() -> ModelRegistry | None:
    models_dir = os.environ.get("ANALYSIS_MODELS_DIR", "/models")
    try:
        from .models import EssentiaRegistry

        registry = EssentiaRegistry(models_dir)
        log.info("models loaded from %s (device=%s)", models_dir, registry.device())
        return registry
    except Exception:
        log.exception("failed to load models from %s — /analyze will 503", models_dir)
        return None


def _load_real_rhythm() -> RhythmAnalyzer | None:
    try:
        from .rhythm import EssentiaRhythmAnalyzer

        return EssentiaRhythmAnalyzer()
    except Exception:
        log.exception("essentia unavailable — /rhythm will 503")
        return None


def _load_real_descriptors() -> DescriptorAnalyzer | None:
    try:
        from .descriptors import EssentiaDescriptorAnalyzer

        return EssentiaDescriptorAnalyzer()
    except Exception:
        log.exception("essentia unavailable — /descriptors will 503")
        return None


async def _idle_watch_loop(holder: RegistryHolder[ModelRegistry]) -> None:
    """Background task (issue #224): periodically release the registry once
    idle. Cancelled at shutdown by the lifespan context manager."""
    while True:
        await asyncio.sleep(_IDLE_CHECK_INTERVAL_SEC)
        if holder.release_if_idle():
            log.info("registry idle-released — next /analyze call reloads it")


def create_app(
    registry: ModelRegistry | None = None,
    music_dir: str | None = None,
    rhythm: RhythmAnalyzer | None = None,
    descriptors: DescriptorAnalyzer | None = None,
    registry_factory: Callable[[], ModelRegistry | None] | None = None,
    idle_release_sec: float | None = None,
    now: Callable[[], float] = time.monotonic,
) -> FastAPI:
    """Build the app. Tests inject a fake registry/rhythm analyzer; production
    passes None and the real Essentia implementations are loaded at startup
    (warm, kept for the process lifetime).

    `registry_factory` is how a released registry gets reloaded (issue #224) —
    defaults to `_load_real_registry` unless a registry was injected (test
    mode), in which case it defaults to a no-op (`lambda: None`) so existing
    tests that inject a fake registry are unaffected unless they explicitly
    pass their own factory to exercise the reload path. `idle_release_sec`
    defaults to `ANALYSIS_IDLE_RELEASE_SEC` (900s / 15min); `<= 0` disables
    release entirely. `now` is the injectable clock the idle guard reads —
    tests pass a fake to drive the idle window without real sleeps.
    """
    rhythm_state: dict[str, RhythmAnalyzer | None] = {"analyzer": rhythm}
    descriptors_state: dict[str, DescriptorAnalyzer | None] = {"analyzer": descriptors}
    resolved_music_dir = Path(music_dir or os.environ.get("MUSIC_DIR", "/data/music")).resolve()
    injected = registry is not None or rhythm is not None or descriptors is not None

    def resolve_track(rel_path: str) -> Path:
        """Resolve a request's relPath inside MUSIC_DIR, or raise the 400/404
        every analysis endpoint shares."""
        candidate = (resolved_music_dir / rel_path).resolve()
        if not candidate.is_relative_to(resolved_music_dir):
            raise HTTPException(status_code=400, detail="path escapes music dir")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="file not found")
        return candidate

    resolved_idle_release_sec = (
        idle_release_sec
        if idle_release_sec is not None
        else float(os.environ.get("ANALYSIS_IDLE_RELEASE_SEC", "900"))
    )
    resolved_factory = registry_factory or (
        (lambda: None) if injected else _load_real_registry
    )
    guard = IdleReleaseGuard(resolved_idle_release_sec, now=now)
    holder: RegistryHolder[ModelRegistry] = RegistryHolder(registry, resolved_factory, guard)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if not injected:  # pragma: no cover - real models load in the container only
            holder.set(_load_real_registry())
            rhythm_state["analyzer"] = _load_real_rhythm()
            descriptors_state["analyzer"] = _load_real_descriptors()
        watcher = asyncio.create_task(_idle_watch_loop(holder))
        try:
            yield
        finally:
            watcher.cancel()

    app = FastAPI(title="nicotind-analysis", lifespan=lifespan)
    # Exposed for tests: simulate the idle sweep firing without waiting on the
    # real background task (`app.state.registry_holder.release_if_idle()`).
    app.state.registry_holder = holder

    @app.get("/health")
    def health() -> dict[str, object]:
        rhythm_ok = rhythm_state["analyzer"] is not None
        descriptors_ok = descriptors_state["analyzer"] is not None
        # can_serve(), not is_loaded(): an idle-released registry reloads on
        # the next /analyze, so it must report "ok" (cold, loaded=false) —
        # "unavailable" is reserved for a boot-time load failure, which never
        # recovers. Reporting the idle state as unavailable livelocked prod:
        # the API's health gate skipped every task, so the reloading /analyze
        # call never came (issue #539).
        if not holder.can_serve():
            return {
                "status": "unavailable",
                "device": None,
                "modelVersions": {},
                "rhythm": rhythm_ok,
                "descriptors": descriptors_ok,
                "loaded": False,
            }
        # peek(), not get(): a health check must not count as activity, or the
        # frequent Docker healthcheck poll (every 30s) keeps the registry "in
        # use" forever and idle-release never fires (issue #224 follow-up).
        reg = holder.peek()
        if reg is None:
            # Idle-released: healthy, one /analyze away from a warm registry.
            return {
                "status": "ok",
                "device": None,
                "modelVersions": {},
                "rhythm": rhythm_ok,
                "descriptors": descriptors_ok,
                "loaded": False,
            }
        return {
            "status": "ok",
            "device": reg.device(),
            "modelVersions": reg.versions(),
            "rhythm": rhythm_ok,
            "descriptors": descriptors_ok,
            "loaded": True,
        }

    @app.post("/analyze")
    def analyze(body: AnalyzeRequest) -> dict[str, object]:
        reg = holder.get()
        if reg is None:
            raise HTTPException(status_code=503, detail="models not loaded")

        candidate = resolve_track(body.relPath)
        try:
            result = reg.analyze(str(candidate))
        except Exception as err:  # decode/inference failure on one file
            log.warning("analysis failed for %s: %s", body.relPath, err)
            raise HTTPException(status_code=422, detail="analysis failed") from err

        return {
            "embedding": {
                "model": result.embedding_model,
                "dim": result.embedding_dim,
                "values": result.embedding,
            },
            "features": result.features,
            "genre": result.genre,
            "modelVersions": result.model_versions,
        }

    @app.post("/rhythm")
    def rhythm_endpoint(body: AnalyzeRequest) -> dict[str, object]:
        analyzer = rhythm_state["analyzer"]
        if analyzer is None:
            raise HTTPException(status_code=503, detail="rhythm analysis unavailable")

        candidate = resolve_track(body.relPath)
        try:
            result = analyzer.analyze(str(candidate))
        except Exception as err:  # decode failure on one file
            log.warning("rhythm analysis failed for %s: %s", body.relPath, err)
            raise HTTPException(status_code=422, detail="rhythm analysis failed") from err

        return {"bpm": result.bpm, "confidence": result.confidence, "method": result.method}

    @app.post("/descriptors")
    def descriptors_endpoint(body: AnalyzeRequest) -> dict[str, object]:
        analyzer = descriptors_state["analyzer"]
        if analyzer is None:
            raise HTTPException(status_code=503, detail="descriptor analysis unavailable")

        candidate = resolve_track(body.relPath)
        try:
            result = analyzer.analyze(str(candidate))
        except Exception as err:  # decode/extraction failure on one file
            log.warning("descriptor analysis failed for %s: %s", body.relPath, err)
            raise HTTPException(status_code=422, detail="descriptor analysis failed") from err

        return {"version": result.version, "features": result.features}

    return app


app = create_app()
