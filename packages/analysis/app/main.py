"""FastAPI app for the analysis sidecar.

Contract (consumed by @nicotind/api's AudioFeaturesClient):

  GET  /health            -> { status, device, modelVersions, rhythm }
  POST /analyze {relPath} -> { embedding: {model, dim, values},
                               features: {danceability, valence, acousticness,
                                          instrumental, mood},
                               genre: {genre, style, confidence} | null,
                               modelVersions }
  POST /rhythm  {relPath} -> { bpm, confidence, method }

`genre` is a sibling of `features` (issue #187 task A2, an audio-inferred
genre fallback) — null only for a sidecar build older than the genre head;
once loaded, every /analyze response carries it, the same as every other
model.

`relPath` is resolved against MUSIC_DIR (the same volume the API mounts), so
the two containers never need matching absolute mount points. 404 for a file
that doesn't exist, 503 while models are unavailable.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .models import ModelRegistry
from .rhythm import RhythmAnalyzer

log = logging.getLogger("analysis")


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


def create_app(
    registry: ModelRegistry | None = None,
    music_dir: str | None = None,
    rhythm: RhythmAnalyzer | None = None,
) -> FastAPI:
    """Build the app. Tests inject a fake registry/rhythm analyzer; production
    passes None and the real Essentia implementations are loaded at startup
    (warm, kept for the process lifetime)."""
    state: dict[str, ModelRegistry | None] = {"registry": registry}
    rhythm_state: dict[str, RhythmAnalyzer | None] = {"analyzer": rhythm}
    resolved_music_dir = Path(music_dir or os.environ.get("MUSIC_DIR", "/data/music")).resolve()
    injected = registry is not None or rhythm is not None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if not injected:  # pragma: no cover - real models load in the container only
            state["registry"] = _load_real_registry()
            rhythm_state["analyzer"] = _load_real_rhythm()
        yield

    app = FastAPI(title="nicotind-analysis", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, object]:
        reg = state["registry"]
        rhythm_ok = rhythm_state["analyzer"] is not None
        if reg is None:
            return {"status": "unavailable", "device": None, "modelVersions": {}, "rhythm": rhythm_ok}
        return {
            "status": "ok",
            "device": reg.device(),
            "modelVersions": reg.versions(),
            "rhythm": rhythm_ok,
        }

    @app.post("/analyze")
    def analyze(body: AnalyzeRequest) -> dict[str, object]:
        reg = state["registry"]
        if reg is None:
            raise HTTPException(status_code=503, detail="models not loaded")

        candidate = (resolved_music_dir / body.relPath).resolve()
        if not candidate.is_relative_to(resolved_music_dir):
            raise HTTPException(status_code=400, detail="path escapes music dir")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="file not found")

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

        candidate = (resolved_music_dir / body.relPath).resolve()
        if not candidate.is_relative_to(resolved_music_dir):
            raise HTTPException(status_code=400, detail="path escapes music dir")
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="file not found")

        try:
            result = analyzer.analyze(str(candidate))
        except Exception as err:  # decode failure on one file
            log.warning("rhythm analysis failed for %s: %s", body.relPath, err)
            raise HTTPException(status_code=422, detail="rhythm analysis failed") from err

        return {"bpm": result.bpm, "confidence": result.confidence, "method": result.method}

    return app


app = create_app()
