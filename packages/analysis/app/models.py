"""Model registry: the injectable boundary between the HTTP app and Essentia.

`ModelRegistry` is the protocol the app consumes; `EssentiaRegistry` is the real
implementation (imports essentia lazily so the package is importable — and the
contract tests runnable — without the `models` extra installed). Tests inject a
fake registry instead.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .features import derive_features

EMBEDDING_MODEL = "discogs-effnet-bs64-1"
EMBEDDING_DIM = 1280

# Head model files (stems double as version identifiers reported by /health).
HEAD_FILES: dict[str, str] = {
    "danceability": "danceability-discogs-effnet-1",
    "mood_happy": "mood_happy-discogs-effnet-1",
    "mood_sad": "mood_sad-discogs-effnet-1",
    "mood_aggressive": "mood_aggressive-discogs-effnet-1",
    "mood_relaxed": "mood_relaxed-discogs-effnet-1",
    "mood_party": "mood_party-discogs-effnet-1",
    "mood_acoustic": "mood_acoustic-discogs-effnet-1",
    "voice_instrumental": "voice_instrumental-discogs-effnet-1",
}
# Valence comes from a regression head on the (secondary) MusiCNN embedding —
# the emomusic head is published for msd-musicnn, not effnet.
MUSICNN_MODEL = "msd-musicnn-1"
EMOMUSIC_MODEL = "emomusic-msd-musicnn-2"


@dataclass
class AnalysisResult:
    embedding: list[float]
    embedding_model: str
    embedding_dim: int
    features: dict[str, float | str]
    model_versions: dict[str, str]


class ModelRegistry(Protocol):
    def device(self) -> str: ...

    def versions(self) -> dict[str, str]: ...

    def analyze(self, path: str) -> AnalysisResult: ...


class EssentiaRegistry:
    """Warm-loaded Essentia-TensorFlow models.

    All graphs are loaded once at construction (multi-second TF load — this is
    why the sidecar exists instead of a per-track CLI) and reused for every
    /analyze call. Inference is serialized with a lock: throughput comes from
    the bun side batching, not intra-process parallelism.
    """

    def __init__(self, models_dir: str) -> None:
        # Deferred import: only the real registry needs essentia installed.
        from essentia.standard import (  # type: ignore[import-not-found]
            MonoLoader,
            TensorflowPredict2D,
            TensorflowPredictEffnetDiscogs,
            TensorflowPredictMusiCNN,
        )

        base = Path(models_dir)
        missing = [
            f"{stem}.pb"
            for stem in [EMBEDDING_MODEL, MUSICNN_MODEL, EMOMUSIC_MODEL, *HEAD_FILES.values()]
            if not (base / f"{stem}.pb").exists()
        ]
        if missing:
            raise FileNotFoundError(f"missing model files in {models_dir}: {', '.join(missing)}")

        self._loader_cls = MonoLoader
        self._lock = threading.Lock()
        self._effnet = TensorflowPredictEffnetDiscogs(
            graphFilename=str(base / f"{EMBEDDING_MODEL}.pb"), output="PartitionedCall:1"
        )
        self._musicnn = TensorflowPredictMusiCNN(
            graphFilename=str(base / f"{MUSICNN_MODEL}.pb"), output="model/dense/BiasAdd"
        )
        self._heads = {
            head: TensorflowPredict2D(
                graphFilename=str(base / f"{stem}.pb"),
                input="model/Placeholder",
                output="model/Softmax",
            )
            for head, stem in HEAD_FILES.items()
        }
        self._emomusic = TensorflowPredict2D(
            graphFilename=str(base / f"{EMOMUSIC_MODEL}.pb"),
            input="model/Placeholder",
            output="model/Identity",
        )

    def device(self) -> str:
        try:
            import tensorflow as tf  # type: ignore[import-not-found]

            return "gpu" if tf.config.list_physical_devices("GPU") else "cpu"
        except Exception:
            return "cpu"

    def versions(self) -> dict[str, str]:
        return {
            "embedding": EMBEDDING_MODEL,
            "musicnn": MUSICNN_MODEL,
            "valence": EMOMUSIC_MODEL,
            **{head: stem for head, stem in HEAD_FILES.items()},
        }

    def analyze(self, path: str) -> AnalysisResult:
        with self._lock:
            # Both embedding models expect 16 kHz mono.
            audio = self._loader_cls(filename=path, sampleRate=16000, resampleQuality=4)()

            effnet_frames = self._effnet(audio)  # frames x 1280
            embedding = effnet_frames.mean(axis=0)

            heads = {
                head: model(effnet_frames).mean(axis=0).tolist()
                for head, model in self._heads.items()
            }

            musicnn_frames = self._musicnn(audio)  # frames x 200
            valence_arousal = self._emomusic(musicnn_frames).mean(axis=0)  # (valence, arousal), 1..9

        return AnalysisResult(
            embedding=[float(x) for x in embedding],
            embedding_model=EMBEDDING_MODEL,
            embedding_dim=int(embedding.shape[0]),
            features=derive_features(heads, float(valence_arousal[0])),
            model_versions=self.versions(),
        )
