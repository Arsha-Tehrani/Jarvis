"""faster-whisper wrapper. Model loads lazily (first PTT press), weights
download from Hugging Face on first use (~1.6 GB for large-v3-turbo)."""

from typing import Protocol

import numpy as np

from . import config
from .hardware import ComputeChoice, detect


class Transcriber(Protocol):
    def transcribe(self, audio: np.ndarray) -> str: ...


class FasterWhisperTranscriber:
    def __init__(
        self,
        model_name: str = config.WHISPER_MODEL,
        choice: ComputeChoice | None = None,
    ) -> None:
        self.model_name = model_name
        self.choice = choice or detect()
        self._model = None

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            print(
                f"Loading {self.model_name} on {self.choice.device} "
                f"({self.choice.compute_type})…"
            )
            self._model = WhisperModel(
                self.model_name,
                device=self.choice.device,
                compute_type=self.choice.compute_type,
            )
        return self._model

    def transcribe(self, audio: np.ndarray) -> str:
        """audio: float32 mono at 16 kHz in [-1, 1]."""
        segments, _info = self._load().transcribe(audio, beam_size=5, vad_filter=True)
        return " ".join(segment.text.strip() for segment in segments).strip()


def make_transcriber() -> Transcriber:
    """Backend switch shared by the HTTP server and push-to-talk. The onnx
    backend logs its own provider ladder; faster-whisper logs via detect()."""
    if config.WHISPER_BACKEND == "onnx":
        from .onnx_transcriber import OnnxWhisperTranscriber

        return OnnxWhisperTranscriber()
    choice = detect()
    print(f"[voice] {choice.reason}")
    print(
        f"[voice] model={config.WHISPER_MODEL} "
        f"device={choice.device} compute={choice.compute_type}"
    )
    return FasterWhisperTranscriber(choice=choice)
