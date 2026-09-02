"""The anvuew checkpoint's config.yaml, and the subset of it upstream
`bs_roformer==0.4.1` understands.

The checkpoint was trained with ZFTurbo's fork of bs_roformer, whose config
carries keys the upstream constructor does not accept. All four are falsy or
default for this checkpoint, so after dropping them the upstream 0.4.1 module
loads it with 0 missing / 0 unexpected tensors (verified in the spike). The
filter is by *signature*, not by this list, so a pin bump that adds or removes
a constructor argument fails loudly at load time instead of silently.

`!!python/tuple` is the only non-standard tag in the file (`freqs_per_bands`,
`multi_stft_resolutions_window_sizes`). One constructor on `SafeLoader` covers
it; `UnsafeLoader` would let a checkpoint config construct arbitrary objects.
"""

from __future__ import annotations

import inspect
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import yaml

FORK_ONLY_KEYS = (
    "linear_transformer_depth",
    "mlp_expansion_factor",
    "use_torch_checkpoint",
    "skip_connection",
)


class _ConfigLoader(yaml.SafeLoader):
    pass


def _tuple_constructor(loader: yaml.SafeLoader, node: yaml.Node) -> tuple[Any, ...]:
    return tuple(loader.construct_sequence(node))


_ConfigLoader.add_constructor("tag:yaml.org,2002:python/tuple", _tuple_constructor)


def load_config(path: str | Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return yaml.load(f, Loader=_ConfigLoader)


def accepted_init_params(cls: type) -> set[str]:
    """Names the class constructor accepts (no `self`, no `*args`/`**kwargs`)."""
    params = inspect.signature(cls.__init__).parameters
    return {
        name
        for name, p in params.items()
        if name != "self" and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
    }


def model_kwargs(model_cfg: Mapping[str, Any], accepted: Iterable[str]) -> dict[str, Any]:
    keep = set(accepted)
    return {key: value for key, value in model_cfg.items() if key in keep}
