"""bs-roformer 0.4.1 calls `torch.backends.cuda.sdp_kernel(...)`, deprecated
since torch 2.2 in favour of `torch.nn.attention.sdpa_kernel(backends)`. The
shim only installs when the old name is gone, so the measured flash config
(mem-efficient + math on Pascal) survives a newer torch."""

from types import SimpleNamespace

from app.model import ensure_sdp_kernel_shim, sdp_backends_for


def test_backends_map_the_three_legacy_flags() -> None:
    backends = SimpleNamespace(FLASH_ATTENTION="F", MATH="M", EFFICIENT_ATTENTION="E")
    assert sdp_backends_for(
        backends, enable_flash=False, enable_math=True, enable_mem_efficient=True
    ) == ["M", "E"]
    assert sdp_backends_for(
        backends, enable_flash=True, enable_math=False, enable_mem_efficient=False
    ) == ["F"]


def test_shim_installs_only_when_sdp_kernel_is_missing() -> None:
    calls: list[list[str]] = []
    backends = SimpleNamespace(FLASH_ATTENTION="F", MATH="M", EFFICIENT_ATTENTION="E")
    attention = SimpleNamespace(SDPBackend=backends, sdpa_kernel=lambda b: calls.append(b) or "ctx")
    torch_like = SimpleNamespace(
        backends=SimpleNamespace(cuda=SimpleNamespace()), nn=SimpleNamespace(attention=attention)
    )

    assert ensure_sdp_kernel_shim(torch_like) is True
    assert (
        torch_like.backends.cuda.sdp_kernel(
            enable_flash=False, enable_math=True, enable_mem_efficient=True
        )
        == "ctx"
    )
    assert calls == [["M", "E"]]
    # Already present (either the shim or the real one): left alone.
    assert ensure_sdp_kernel_shim(torch_like) is False
