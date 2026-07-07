"""HTTP transcription endpoint for the in-browser mic button.

    .venv/bin/python -m voice.server            # http://127.0.0.1:8018
    (.venv/Scripts/python on Windows)

POST /transcribe
  multipart: audio=<file>   (whatever MediaRecorder produced — webm/opus,
                             mp4/aac, wav; ffmpeg-style decoding via PyAV)
→ {"text": "..."}

Same lazy faster-whisper model as the push-to-talk loop (voice.transcriber),
so running both costs one model load. The Jarvis app proxies browser audio
here via /api/transcribe and treats this sidecar being down as a normal,
clearly-messaged state.
"""

import io

import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile

from . import config
from .transcriber import FasterWhisperTranscriber, Transcriber

app = FastAPI(title="Jarvis voice sidecar")

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MIN_SAMPLES = int(0.3 * config.SAMPLE_RATE)  # same misfire floor as PTT

_transcriber: Transcriber | None = None


def get_transcriber() -> Transcriber:
    """Lazy singleton; tests swap in a stub via set_transcriber."""
    global _transcriber
    if _transcriber is None:
        _transcriber = FasterWhisperTranscriber()
    return _transcriber


def set_transcriber(transcriber: Transcriber | None) -> None:
    global _transcriber
    _transcriber = transcriber


def decode_to_pcm(data: bytes) -> np.ndarray:
    """Container/codec bytes → float32 mono 16 kHz, via faster-whisper's own
    decoder (PyAV) so the endpoint accepts exactly what the model accepts."""
    from faster_whisper.audio import decode_audio

    return decode_audio(io.BytesIO(data), sampling_rate=config.SAMPLE_RATE)


@app.post("/transcribe")
async def transcribe(audio: UploadFile) -> dict:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio too large (max 25 MB)")

    try:
        pcm = decode_to_pcm(data)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Could not decode the audio — send what MediaRecorder produced (webm/mp4/wav)",
        ) from None

    if len(pcm) < MIN_SAMPLES:
        return {"text": ""}  # sub-0.3s misfire, same rule as push-to-talk

    try:
        text = get_transcriber().transcribe(pcm)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"Transcription failed: {err}") from err
    return {"text": text}


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": config.WHISPER_MODEL,
        "loaded": _transcriber is not None,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
