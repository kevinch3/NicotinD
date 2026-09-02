"""The anvuew config.yaml was written for ZFTurbo's fork of bs_roformer; the
upstream 0.4.1 constructor accepts a subset of its keys."""

from pathlib import Path

from app.model_config import FORK_ONLY_KEYS, accepted_init_params, load_config, model_kwargs

YAML = """
audio:
  chunk_size: 960000
  sample_rate: 44100
model:
  dim: 256
  depth: 12
  stereo: true
  num_stems: 1
  freqs_per_bands: !!python/tuple
    - 2
    - 4
  linear_transformer_depth: 0
  mlp_expansion_factor: 4
  use_torch_checkpoint: True
  skip_connection: False
inference:
  num_overlap: 4
"""


def test_load_config_accepts_the_python_tuple_tag_without_unsafe_loader(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    path.write_text(YAML)
    cfg = load_config(path)
    assert cfg["model"]["freqs_per_bands"] == (2, 4)
    assert isinstance(cfg["model"]["freqs_per_bands"], tuple)
    assert cfg["audio"]["chunk_size"] == 960000


def test_model_kwargs_drops_the_fork_only_keys_and_keeps_the_rest() -> None:
    model_cfg = {
        "dim": 256,
        "depth": 12,
        "stereo": True,
        "num_stems": 1,
        "freqs_per_bands": (2, 4),
        "linear_transformer_depth": 0,
        "mlp_expansion_factor": 4,
        "use_torch_checkpoint": True,
        "skip_connection": False,
    }
    accepted = {"dim", "depth", "stereo", "num_stems", "freqs_per_bands", "flash_attn"}
    kwargs = model_kwargs(model_cfg, accepted)
    assert kwargs == {
        "dim": 256,
        "depth": 12,
        "stereo": True,
        "num_stems": 1,
        "freqs_per_bands": (2, 4),
    }
    assert not set(kwargs) & set(FORK_ONLY_KEYS)


def test_accepted_init_params_reads_the_constructor_signature() -> None:
    class Fake:
        def __init__(self, dim, depth, stereo=False, *, flash_attn=True) -> None:
            pass

    assert accepted_init_params(Fake) == {"dim", "depth", "stereo", "flash_attn"}
