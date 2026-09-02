"""Boot-time GPU probe, run in a throwaway child so the serving process never
imports torch (hundreds of MB of RSS, and a CUDA context it would then hold
alongside the worker's)."""

from __future__ import annotations

import multiprocessing
import re
from multiprocessing.connection import Connection
from typing import TypedDict


class DeviceInfo(TypedDict):
    device: str  # "cuda" | "cpu"
    gpu: str | None
    arch_ok: bool  # this torch build ships a kernel the card can run (see arch_supported)


NO_GPU: DeviceInfo = {"device": "cpu", "gpu": None, "arch_ok": False}

_SM = re.compile(r"^sm_(\d)(\d)$")


def arch_supported(capability: tuple[int, int], arch_list: list[str]) -> bool:
    """Whether a torch build (`torch.cuda.get_arch_list()`) can run on a card of
    this compute capability. CUDA SASS is forward-compatible within a MAJOR
    version only: an sm_60 kernel runs on a 6.1 card (the cu126 wheels ship
    sm_60 and no sm_61 — that is how the Quadro P4000 runs them), but never
    on a 5.x or 7.x card, and an sm_61 kernel does not run on a 6.0 card."""
    major, minor = capability
    for arch in arch_list:
        m = _SM.match(arch)
        if m and int(m.group(1)) == major and int(m.group(2)) <= minor:
            return True
    return False


def _probe_in_child(conn: Connection) -> None:
    try:
        import torch

        if not torch.cuda.is_available():
            conn.send(NO_GPU)
            return
        capability = tuple(torch.cuda.get_device_capability(0))
        conn.send(
            {
                "device": "cuda",
                "gpu": torch.cuda.get_device_name(0),
                "arch_ok": arch_supported(capability, torch.cuda.get_arch_list()),
            }
        )
    except Exception:  # noqa: BLE001 — a probe failure is "no usable GPU", not a crash
        conn.send(NO_GPU)


def probe_device(timeout_sec: float = 60.0) -> DeviceInfo:
    ctx = multiprocessing.get_context("spawn")
    parent, child = ctx.Pipe()
    proc = ctx.Process(target=_probe_in_child, args=(child,), daemon=True)
    proc.start()
    child.close()
    try:
        if parent.poll(timeout_sec):
            return parent.recv()
        return NO_GPU
    except (EOFError, OSError):
        return NO_GPU
    finally:
        proc.join(5)
        if proc.is_alive():
            proc.kill()
        parent.close()
