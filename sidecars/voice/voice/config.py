"""Voice bridge configuration — compute device and model size are
env-configurable; 'auto' picks per detected hardware (see hardware.py)."""

import os
from pathlib import Path

# faster-whisper model. large-v3-turbo is the accuracy/speed sweet spot;
# drop to "small" or "base" on weak CPUs.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")

# faster-whisper (default) | onnx. The onnx backend adds a DirectML path so
# AMD/Intel GPUs on Windows do the heavy lifting (see onnx_transcriber.py);
# faster-whisper stays the default — it's the stronger CUDA/CPU engine.
WHISPER_BACKEND = os.environ.get("WHISPER_BACKEND", "faster-whisper")

# onnx backend only: the lighter checkpoint the CPU track loads (int8) when
# no GPU provider initializes, so the fallback respects the RAM ceiling
# instead of grinding large-v3-turbo fp32 through system memory.
# (faster-whisper ignores this — its int8 CPU path handles the big model.)
WHISPER_CPU_MODEL = os.environ.get("WHISPER_CPU_MODEL", "small")

# Where the onnx backend caches exported/quantized model graphs.
WHISPER_ONNX_CACHE = Path(
    os.environ.get("WHISPER_ONNX_CACHE", Path.home() / ".cache" / "jarvis-voice-onnx")
)

# auto | cuda | cpu
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "auto")

# auto | float16 | int8 | int8_float16 | ...
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "auto")

# Push-to-talk key (keyboard library name). Held = recording.
PTT_KEY = os.environ.get("PTT_KEY", "f9")

# Whisper wants 16 kHz mono.
SAMPLE_RATE = 16_000

# The Jarvis app; transcripts POST to /api/agent exactly as if typed.
JARVIS_URL = os.environ.get("JARVIS_URL", "http://localhost:3000")

# HTTP transcription server (voice.server) for the in-browser mic button.
HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "8018"))
