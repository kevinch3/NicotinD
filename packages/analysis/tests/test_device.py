"""runtime_device()/cuda_device_count(): the honest gpu/cpu report.

"gpu" requires BOTH the image-build marker (ANALYSIS_GPU_BUILD=1, set by the
Dockerfile when the GPU libtensorflow swap happened) AND a loadable NVIDIA
driver reporting >=1 device. Everything else — CPU image, GPU image started
without --gpus, broken driver — must say "cpu", matching TF's own dlopen-based
silent fallback.
"""

import ctypes

from app.models import cuda_device_count, runtime_device


class FakeCuda:
    """Stands in for the ctypes handle of libcuda.so.1."""

    def __init__(self, init_rc: int = 0, count_rc: int = 0, count: int = 1) -> None:
        self._init_rc = init_rc
        self._count_rc = count_rc
        self._count = count

    def cuInit(self, _flags: int) -> int:
        return self._init_rc

    def cuDeviceGetCount(self, count_ref) -> int:
        count_ref._obj.value = self._count
        return self._count_rc


def loader_with(fake: FakeCuda):
    def load(name: str) -> ctypes.CDLL:
        assert name == "libcuda.so.1"
        return fake  # type: ignore[return-value]

    return load


def failing_loader(name: str) -> ctypes.CDLL:
    raise OSError(f"{name}: cannot open shared object file")


def test_no_driver_means_zero_devices() -> None:
    assert cuda_device_count(failing_loader) == 0


def test_driver_init_failure_means_zero_devices() -> None:
    assert cuda_device_count(loader_with(FakeCuda(init_rc=100))) == 0
    assert cuda_device_count(loader_with(FakeCuda(count_rc=1))) == 0


def test_driver_reports_devices() -> None:
    assert cuda_device_count(loader_with(FakeCuda(count=2))) == 2


def test_cpu_image_reports_cpu_even_with_a_gpu_present() -> None:
    assert runtime_device(env={}, loader=loader_with(FakeCuda())) == "cpu"
    assert runtime_device(env={"ANALYSIS_GPU_BUILD": "0"}, loader=loader_with(FakeCuda())) == "cpu"


def test_gpu_image_without_driver_falls_back_to_cpu() -> None:
    assert runtime_device(env={"ANALYSIS_GPU_BUILD": "1"}, loader=failing_loader) == "cpu"


def test_gpu_image_with_driver_reports_gpu() -> None:
    assert runtime_device(env={"ANALYSIS_GPU_BUILD": "1"}, loader=loader_with(FakeCuda())) == "gpu"
