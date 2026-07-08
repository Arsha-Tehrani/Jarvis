"""ONNX Runtime Whisper backend — opt-in via WHISPER_BACKEND=onnx.

Why this exists: the default faster-whisper/CTranslate2 backend has no AMD
GPU path (see hardware.py — CUDA-only upstream). ONNX Runtime does have one:
DirectML runs on any DirectX-12 GPU on Windows, including the RX 6700 XT.
This backend routes the heavy lifting to whatever GPU the host machine
actually has, with no manual configuration.

Execution-provider priority (first available wins; ORT itself falls back
down the array at session-create time if a provider fails to initialize):

  1. CUDAExecutionProvider  — NVIDIA        (pip install onnxruntime-gpu)
  2. DmlExecutionProvider   — AMD/Intel on Windows via DirectML
                                            (pip install onnxruntime-directml)
  3. CPUExecutionProvider   — always present; weights are dynamically
                              quantized to int8 first to cut RAM use

Install exactly ONE onnxruntime flavor per venv — they conflict — plus the
export/tokenizer stack (see requirements.txt's optional block). Provider
selection reads `onnxruntime.get_available_providers()` at runtime, so the
same code lands on the best path for whichever flavor is installed.

Model export happens once and is cached under ~/.cache/jarvis-voice-onnx
(override with WHISPER_ONNX_CACHE). large-v3-turbo exports to ~3 GB fp32;
drop WHISPER_MODEL to "small" or "base" if that's too heavy for VRAM.
"""

import shutil
from pathlib import Path
from typing import Sequence

import numpy as np

from . import config

# The exact fallback ladder, best-first. select_providers() intersects this
# with what the installed onnxruntime build actually offers.
PROVIDER_PRIORITY = [
    "CUDAExecutionProvider",
    "DmlExecutionProvider",
    "CPUExecutionProvider",
]

_WINDOW_SAMPLES = 30 * config.SAMPLE_RATE  # Whisper's native 30 s receptive field


def select_providers(available: Sequence[str] | None = None) -> list[str]:
    """Ordered provider array for this machine — pure function over the
    probed provider list (unit-tested), same pattern as hardware.choose_compute.
    Always ends with CPU so a session can be created no matter what."""
    if available is None:
        import onnxruntime as ort

        available = ort.get_available_providers()
    chosen = [p for p in PROVIDER_PRIORITY if p in available]
    if "CPUExecutionProvider" not in chosen:
        chosen.append("CPUExecutionProvider")
    return chosen


def hf_model_id(name: str) -> str:
    """Map faster-whisper-style short names ('large-v3-turbo') to HF ids."""
    return name if "/" in name else f"openai/whisper-{name}"


def _quantize_int8(src_dir: Path, dst_dir: Path) -> None:
    """Dynamic int8 weight quantization of every exported ONNX graph —
    roughly quarters weight RAM on the CPU path. Non-model files (configs,
    tokenizer) are copied through so dst_dir is loadable on its own."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    dst_dir.mkdir(parents=True, exist_ok=True)
    for item in src_dir.iterdir():
        if item.suffix == ".onnx":
            quantize_dynamic(item, dst_dir / item.name, weight_type=QuantType.QInt8)
        elif item.is_file():
            shutil.copy2(item, dst_dir / item.name)


class OnnxWhisperTranscriber:
    """Same Transcriber protocol as FasterWhisperTranscriber: lazy load on
    first use, float32 mono 16 kHz in, text out."""

    def __init__(self, model_name: str = config.WHISPER_MODEL) -> None:
        self.model_name = model_name
        self._model = None
        self._processor = None

    def _load(self):
        if self._model is None:
            # torch is only the tensor frontend optimum requires; all compute
            # runs inside the ONNX Runtime session on the selected provider.
            from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
            from transformers import WhisperProcessor

            providers = select_providers()
            primary = providers[0]
            model_id = hf_model_id(self.model_name)
            print(f"[onnx] provider ladder: {' > '.join(providers)} -> using {primary}")

            cache = config.WHISPER_ONNX_CACHE / self.model_name
            fp32_dir = cache / "fp32"
            if not (fp32_dir / "config.json").exists():
                print(f"[onnx] exporting {model_id} to ONNX (one-time, cached in {cache})…")
                ORTModelForSpeechSeq2Seq.from_pretrained(model_id, export=True).save_pretrained(fp32_dir)

            load_dir = fp32_dir
            if primary == "CPUExecutionProvider":
                int8_dir = cache / "int8"
                if not (int8_dir / "config.json").exists():
                    try:
                        print("[onnx] CPU path -> quantizing weights to int8 (one-time)…")
                        _quantize_int8(fp32_dir, int8_dir)
                    except Exception as err:
                        print(f"[onnx] int8 quantization failed ({err}); staying on fp32 CPU")
                        int8_dir = fp32_dir
                load_dir = int8_dir

            self._model = ORTModelForSpeechSeq2Seq.from_pretrained(load_dir, provider=primary)
            # Processor (feature extractor + tokenizer) comes from the HF hub
            # cache — save_pretrained above only writes the model graphs.
            self._processor = WhisperProcessor.from_pretrained(model_id)
        return self._model, self._processor

    def transcribe(self, audio: np.ndarray) -> str:
        """audio: float32 mono at 16 kHz in [-1, 1]. Inputs longer than
        Whisper's 30 s window are transcribed in consecutive windows."""
        model, processor = self._load()
        texts = []
        for start in range(0, len(audio), _WINDOW_SAMPLES):
            chunk = audio[start : start + _WINDOW_SAMPLES]
            features = processor(
                chunk, sampling_rate=config.SAMPLE_RATE, return_tensors="pt"
            ).input_features
            ids = model.generate(features)
            texts.append(processor.batch_decode(ids, skip_special_tokens=True)[0].strip())
        return " ".join(t for t in texts if t).strip()
