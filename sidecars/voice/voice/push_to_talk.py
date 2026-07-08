"""Push-to-talk main loop.

    .venv/Scripts/python -m voice.push_to_talk

Hold PTT_KEY (default F9) to record, release to transcribe locally and send
the text to Jarvis /api/agent as if typed. The session logic is separated
from the keyboard/audio libraries so tests can drive it with fakes.
"""

from typing import Callable

import numpy as np

from . import config
from .handoff import send_to_agent
from .transcriber import Transcriber

MIN_SECONDS = 0.3  # releases shorter than this are treated as misfires


class SoundDeviceRecorder:
    """Mic capture via sounddevice/PortAudio (imported lazily so tests and
    audio-less machines can import this module)."""

    def __init__(self, sample_rate: int = config.SAMPLE_RATE) -> None:
        self.sample_rate = sample_rate
        self._chunks: list[np.ndarray] = []
        self._stream = None

    def start(self) -> None:
        import sounddevice as sd

        self._chunks = []

        def callback(indata, _frames, _time, status):
            if status:
                print(f"[audio] {status}", flush=True)
            self._chunks.append(indata[:, 0].copy())

        self._stream = sd.InputStream(
            samplerate=self.sample_rate, channels=1, dtype="float32", callback=callback
        )
        self._stream.start()

    def stop(self) -> np.ndarray:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if not self._chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(self._chunks)


class PushToTalkSession:
    """press → record; release → transcribe → POST to the agent → print.
    One failure never kills the loop; every path prints something."""

    def __init__(
        self,
        recorder,
        transcriber: Transcriber,
        sender: Callable[[str], str] = send_to_agent,
        out: Callable[[str], None] = print,
        sample_rate: int = config.SAMPLE_RATE,
    ) -> None:
        self.recorder = recorder
        self.transcriber = transcriber
        self.sender = sender
        self.out = out
        self.sample_rate = sample_rate
        self.recording = False

    def on_press(self) -> None:
        # Key auto-repeat refires while held — only the first press matters.
        if self.recording:
            return
        self.recording = True
        try:
            self.recorder.start()
            self.out("* recording... (release to send)")
        except Exception as err:
            self.recording = False
            self.out(f"Mic error: {err}")

    def on_release(self) -> None:
        if not self.recording:
            return
        self.recording = False
        try:
            audio = self.recorder.stop()
        except Exception as err:
            self.out(f"Mic error: {err}")
            return
        if len(audio) < MIN_SECONDS * self.sample_rate:
            self.out("(too short — hold the key while speaking)")
            return
        try:
            text = self.transcriber.transcribe(audio)
        except Exception as err:
            self.out(f"Transcription failed: {err}")
            return
        if not text.strip():
            self.out("(heard nothing)")
            return
        self.out(f"You said: {text}")
        try:
            self.out(f"Jarvis: {self.sender(text)}")
        except Exception as err:
            self.out(f"Handoff failed: {err}")


def main() -> None:
    import keyboard  # requires admin only on Linux; fine on Windows

    from .transcriber import make_transcriber

    session = PushToTalkSession(
        recorder=SoundDeviceRecorder(),
        transcriber=make_transcriber(),
    )
    keyboard.on_press_key(config.PTT_KEY, lambda _e: session.on_press())
    keyboard.on_release_key(config.PTT_KEY, lambda _e: session.on_release())
    print(f"[voice] Hold {config.PTT_KEY.upper()} to talk to Jarvis ({config.JARVIS_URL}). Ctrl+C to quit.")
    try:
        keyboard.wait()
    except KeyboardInterrupt:
        print("\n[voice] bye")


if __name__ == "__main__":
    main()
