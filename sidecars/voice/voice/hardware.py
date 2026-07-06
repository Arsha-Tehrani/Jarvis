"""Compute-path detection. NO GPU assumptions — the decision matrix is a
pure function (unit-tested) over probed facts:

- NVIDIA GPU present -> CUDA + float16 (CTranslate2's native fast path).
- AMD GPU (e.g. RX 6700 XT) -> **no clean native faster-whisper GPU path**:
  CTranslate2 is CUDA-only; ROCm support only exists via experimental
  Linux-only community builds. We say so in the startup log and fall back
  to CPU int8 rather than pretending.
- Apple Silicon (M-series) -> CTranslate2 runs on CPU with Accelerate/NEON
  (int8). There is no Metal GPU path in the runtime; whisper.cpp is the
  alternative if GPU offload matters more than this integration.
- Anything else -> CPU int8, the reliable default.

Env overrides (WHISPER_DEVICE / WHISPER_COMPUTE) always win.
"""

import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass

from . import config


@dataclass
class ComputeChoice:
    device: str  # "cuda" | "cpu"
    compute_type: str  # e.g. "float16", "int8"
    reason: str  # human-readable startup log line


def has_nvidia_gpu() -> bool:
    # ctranslate2 knows definitively; nvidia-smi is the fallback probe.
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return True
    except Exception:
        pass
    if shutil.which("nvidia-smi"):
        try:
            return (
                subprocess.run(
                    ["nvidia-smi", "-L"], capture_output=True, timeout=10
                ).returncode
                == 0
            )
        except Exception:
            return False
    return False


def has_amd_gpu() -> bool:
    try:
        if sys.platform == "win32":
            out = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_VideoController).Name",
                ],
                capture_output=True,
                text=True,
                timeout=20,
            ).stdout
        elif sys.platform.startswith("linux"):
            out = subprocess.run(
                ["lspci"], capture_output=True, text=True, timeout=10
            ).stdout
        else:
            return False
    except Exception:
        return False
    lowered = out.lower()
    return "amd" in lowered or "radeon" in lowered


def is_apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def choose_compute(
    nvidia: bool,
    amd: bool,
    apple: bool,
    env_device: str = "auto",
    env_compute: str = "auto",
) -> ComputeChoice:
    """Pure decision matrix — probed facts in, device choice out."""
    if env_device != "auto":
        compute = env_compute if env_compute != "auto" else (
            "float16" if env_device == "cuda" else "int8"
        )
        return ComputeChoice(env_device, compute, f"WHISPER_DEVICE={env_device} (env override)")

    if nvidia:
        compute = env_compute if env_compute != "auto" else "float16"
        return ComputeChoice("cuda", compute, "NVIDIA GPU detected -> CUDA")

    compute = env_compute if env_compute != "auto" else "int8"
    if amd:
        reason = (
            "AMD GPU detected, but faster-whisper/CTranslate2 has NO clean "
            "native AMD GPU path (CUDA-only; ROCm exists only as experimental "
            "Linux community builds) -> CPU int8 fallback"
        )
    elif apple:
        reason = (
            "Apple Silicon -> CTranslate2 CPU path with Accelerate/NEON (int8); "
            "the runtime has no Metal GPU offload"
        )
    else:
        reason = "No supported GPU detected -> CPU int8 (reliable default)"
    return ComputeChoice("cpu", compute, reason)


def detect() -> ComputeChoice:
    return choose_compute(
        nvidia=has_nvidia_gpu(),
        amd=has_amd_gpu(),
        apple=is_apple_silicon(),
        env_device=config.WHISPER_DEVICE,
        env_compute=config.WHISPER_COMPUTE,
    )
