# voice sidecar — push-to-talk STT bridge

Hold a key, speak, release: the audio is transcribed **locally** with
faster-whisper and the text is POSTed to Jarvis `/api/agent` exactly as if
typed into the chat box — so "log the gym" or "I ate two eggs and toast"
triggers the same tools. Transcript and agent reply print to the console.
Standalone Python script — no server, not part of the Next.js build.

## Setup (one-time)

```powershell
cd sidecars/voice
py -3.13 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Model weights (large-v3-turbo, ~1.6 GB) download from Hugging Face on the
first transcription.

## Run

```powershell
.venv\Scripts\python -m voice.push_to_talk
# hold F9 (PTT_KEY) to record, release to send; Ctrl+C to quit
```

## Hardware / compute path (auto-detected, logged at startup)

| Hardware | Path |
|---|---|
| NVIDIA GPU | CUDA + float16 (needs CUDA 12 + cuDNN 9 runtimes installed) |
| AMD GPU (e.g. RX 6700 XT) | **CPU int8.** faster-whisper/CTranslate2 has no clean native AMD path — CUDA-only upstream; ROCm exists only as experimental Linux community builds. The startup log says so explicitly. |
| Apple Silicon (M-series) | CPU int8 via Accelerate/NEON — the runtime has no Metal GPU offload (use whisper.cpp if that matters more). |
| Anything else | CPU int8 — the reliable default. |

Override with env: `WHISPER_DEVICE=cuda|cpu`, `WHISPER_COMPUTE=float16|int8|…`,
`WHISPER_MODEL=large-v3-turbo|small|…` (drop to `small` on weak CPUs —
large-v3-turbo on CPU int8 is usable but not instant), `PTT_KEY=f9`,
`JARVIS_URL=http://localhost:3000`.

## Tests (no mic, no model — fakes + a mocked agent endpoint)

```powershell
.venv\Scripts\python -m pytest
```
