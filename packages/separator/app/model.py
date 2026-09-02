"""BS-RoFormer loading and the whole-file separation pass. Everything that
imports torch runs INSIDE the worker process (`separate_file` is the entry
point the parent submits); the pure helpers above it are unit-tested without
torch.

Model: `anvuew/BS-RoFormer`, `bs_roformer_ft1_anvuew_sdr_12.55.ckpt`
(GPL-3.0), 51 M params, `num_stems: 1` — it predicts the VOCALS; the
instrumental is mix − vocals. Chosen and measured in
docs/vocal-isolation-spike.md; RTF 0.261 / ~3.0 GB VRAM on the Quadro P4000.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .audio import SAMPLE_RATE, decode_stereo_f32, probe_duration_sec, write_flac
from .chunking import OVERLAP_SAMPLES, chunk_windows, fit_length, overlap_add, pad_to_multiple
from .model_config import accepted_init_params, load_config, model_kwargs
from .timeouts import MIN_TRACK_SEC

MODEL_ID = "bs_roformer_ft1_anvuew_sdr_12.55"
MODEL_SOURCE = "anvuew/BS-RoFormer"
CHECKPOINT_FILE = "bs_roformer_ft1_anvuew_sdr_12.55.ckpt"
CONFIG_FILE = "config.yaml"


class ModelLoadError(RuntimeError):
    """The checkpoint/config could not be turned into a model. Deterministic —
    the files are baked into the image — so the app reports it as a sticky
    `load-failed` rather than retrying every call."""


def model_files(models_dir: str | Path) -> tuple[Path, Path]:
    base = Path(models_dir)
    return base / CHECKPOINT_FILE, base / CONFIG_FILE


def sdp_backends_for(
    backends: Any, *, enable_flash: bool, enable_math: bool, enable_mem_efficient: bool
) -> list[Any]:
    chosen = []
    if enable_flash:
        chosen.append(backends.FLASH_ATTENTION)
    if enable_math:
        chosen.append(backends.MATH)
    if enable_mem_efficient:
        chosen.append(backends.EFFICIENT_ATTENTION)
    return chosen


def ensure_sdp_kernel_shim(torch_module: Any) -> bool:
    """bs-roformer 0.4.1 wraps attention in `torch.backends.cuda.sdp_kernel(
    enable_flash=…, enable_math=…, enable_mem_efficient=…)`, deprecated since
    torch 2.2 for `torch.nn.attention.sdpa_kernel([backends])`. Install the
    mapping only when the old name is gone, so the configuration the RTF was
    measured with (mem-efficient + math on a Pascal card) survives a torch
    that finally removed it. Returns whether the shim was installed."""
    cuda_backends = torch_module.backends.cuda
    if hasattr(cuda_backends, "sdp_kernel"):
        return False
    attention = torch_module.nn.attention

    def sdp_kernel(
        enable_flash: bool = True, enable_math: bool = True, enable_mem_efficient: bool = True
    ) -> Any:
        return attention.sdpa_kernel(
            sdp_backends_for(
                attention.SDPBackend,
                enable_flash=enable_flash,
                enable_math=enable_math,
                enable_mem_efficient=enable_mem_efficient,
            )
        )

    cuda_backends.sdp_kernel = sdp_kernel
    return True


def load_model(models_dir: str | Path, device: str) -> tuple[Any, dict[str, Any]]:
    import torch

    try:
        from bs_roformer import BSRoformer
    except ImportError as err:
        raise ModelLoadError(f"bs_roformer is not installed: {err}") from err

    ensure_sdp_kernel_shim(torch)
    ckpt_path, config_path = model_files(models_dir)
    if not ckpt_path.is_file() or not config_path.is_file():
        raise ModelLoadError(f"checkpoint or config missing under {models_dir}")
    config = load_config(config_path)
    kwargs = model_kwargs(config["model"], accepted_init_params(BSRoformer))
    try:
        model = BSRoformer(**kwargs)
        state = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        # strict: the spike verified 0 missing / 0 unexpected on 0.4.1; a pin
        # drift must fail here, not produce garbage audio.
        model.load_state_dict(state, strict=True)
    except (RuntimeError, TypeError, KeyError) as err:
        raise ModelLoadError(f"{CHECKPOINT_FILE} does not load: {err}") from err
    return model.to(device).eval(), config


_CACHE: dict[str, Any] = {}


def _get_model(models_dir: str | Path, device: str) -> tuple[Any, dict[str, Any]]:
    key = f"{models_dir}|{device}"
    if key not in _CACHE:
        _CACHE[key] = load_model(models_dir, device)
    return _CACHE[key]


def separate_file(
    src: str, out: str, models_dir: str, device: str, max_sec: float
) -> dict[str, float]:
    """Worker entry point: decode → chunked vocals → instrumental FLAC at `out`.

    Raises ValueError for a per-file verdict (undecodable, out of the length
    bounds) — the app maps that to 422; ModelLoadError is 503 + sticky."""
    duration = probe_duration_sec(src)
    if duration is None:
        raise ValueError("undecodable source")
    if duration < MIN_TRACK_SEC or duration > max_sec:
        raise ValueError(f"track length {duration:.1f}s outside [{MIN_TRACK_SEC}, {max_sec}]")

    mix = decode_stereo_f32(src)
    model, config = _get_model(models_dir, device)
    chunk = int(config["audio"]["chunk_size"])
    hop = int(config["model"].get("stft_hop_length", 512))
    n = mix.shape[1]
    windows = chunk_windows(n, chunk, OVERLAP_SAMPLES)

    import torch

    pieces: list[np.ndarray] = []
    with torch.inference_mode():
        for start, end in windows:
            # The model hands back floor(n / hop) * hop samples: pad the window
            # up to a hop multiple going in, fit it back to the window coming out.
            padded = pad_to_multiple(np.ascontiguousarray(mix[:, start:end]), hop)
            x = torch.from_numpy(padded).unsqueeze(0).to(device)
            y = model(x)
            # (batch, 2, time) for stereo/num_stems=1; (batch, stems, 2, time) otherwise.
            vocals = y[0, 0] if y.ndim == 4 else y[0]
            pieces.append(fit_length(vocals.float().cpu().numpy(), end - start))

    vocals_full = overlap_add(pieces, windows, n, OVERLAP_SAMPLES)
    instrumental = np.clip(mix - vocals_full, -1.0, 1.0)
    write_flac(out, instrumental, SAMPLE_RATE)
    return {"duration_sec": float(duration), "sample_rate": float(SAMPLE_RATE)}
