"""Push-to-talk state machine with a fake recorder + stub transcriber, and
the transcribe→POST handoff against a real (mocked) HTTP agent endpoint."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import pytest

from voice.handoff import send_to_agent
from voice.push_to_talk import MIN_SECONDS, PushToTalkSession


class FakeRecorder:
    def __init__(self, audio: np.ndarray) -> None:
        self.audio = audio
        self.started = 0
        self.stopped = 0

    def start(self) -> None:
        self.started += 1

    def stop(self) -> np.ndarray:
        self.stopped += 1
        return self.audio


class StubTranscriber:
    def __init__(self, text: str = "log the gym") -> None:
        self.text = text
        self.heard: list[np.ndarray] = []

    def transcribe(self, audio: np.ndarray) -> str:
        self.heard.append(audio)
        return self.text


def one_second() -> np.ndarray:
    return np.zeros(16_000, dtype=np.float32)


def make_session(audio=None, text="log the gym", sender=None):
    recorder = FakeRecorder(audio if audio is not None else one_second())
    transcriber = StubTranscriber(text)
    lines: list[str] = []
    sent: list[str] = []

    def default_sender(t: str) -> str:
        sent.append(t)
        return "Logged gym for 2026-07-06."

    session = PushToTalkSession(
        recorder=recorder,
        transcriber=transcriber,
        sender=sender or default_sender,
        out=lines.append,
    )
    return session, recorder, transcriber, lines, sent


def test_press_release_records_transcribes_and_sends():
    session, recorder, transcriber, lines, sent = make_session()
    session.on_press()
    session.on_release()
    assert recorder.started == 1 and recorder.stopped == 1
    assert len(transcriber.heard) == 1
    assert sent == ["log the gym"]
    assert any("You said: log the gym" in line for line in lines)
    assert any("Logged gym" in line for line in lines)


def test_key_autorepeat_does_not_restart_recording():
    session, recorder, *_ = make_session()
    session.on_press()
    session.on_press()  # auto-repeat while held
    session.on_press()
    assert recorder.started == 1
    session.on_release()
    session.on_release()  # bounce
    assert recorder.stopped == 1


def test_too_short_release_is_dropped():
    short = np.zeros(int(MIN_SECONDS * 16_000) - 1, dtype=np.float32)
    session, _, transcriber, lines, sent = make_session(audio=short)
    session.on_press()
    session.on_release()
    assert transcriber.heard == []
    assert sent == []
    assert any("too short" in line for line in lines)


def test_empty_transcript_is_not_sent():
    session, _, _, lines, sent = make_session(text="   ")
    session.on_press()
    session.on_release()
    assert sent == []
    assert any("heard nothing" in line for line in lines)


def test_sender_failure_is_printed_not_raised():
    def broken_sender(text: str) -> str:
        raise RuntimeError("Jarvis app not reachable at http://localhost:3000")

    session, _, _, lines, _ = make_session(sender=broken_sender)
    session.on_press()
    session.on_release()
    assert any("Handoff failed" in line and "not reachable" in line for line in lines)
    assert session.recording is False  # ready for the next press


# --- handoff → mocked /api/agent over real HTTP ---------------------------


class FakeAgentHandler(BaseHTTPRequestHandler):
    received: list[dict] = []

    def do_POST(self):  # noqa: N802 (http.server API)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeAgentHandler.received.append({"path": self.path, "body": body})
        if body.get("text") == "make it fail":
            payload, status = {"error": "LLM call failed"}, 502
        elif body.get("text") == "set a goal":
            payload, status = {"reply": "1 action(s) need your confirmation before they run.", "pending": [{"name": "set_goal"}]}, 200
        else:
            payload, status = {"reply": f"Added task \"{body['text']}\"."}, 200
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):  # keep test output quiet
        pass


@pytest.fixture
def fake_agent():
    FakeAgentHandler.received = []
    server = HTTPServer(("127.0.0.1", 0), FakeAgentHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_handoff_posts_transcript_as_if_typed(fake_agent):
    reply = send_to_agent("remind me to stretch tomorrow", jarvis_url=fake_agent)
    assert reply == 'Added task "remind me to stretch tomorrow".'
    [request] = FakeAgentHandler.received
    assert request["path"] == "/api/agent"
    assert request["body"] == {"text": "remind me to stretch tomorrow"}


def test_handoff_surfaces_pending_confirmations(fake_agent):
    reply = send_to_agent("set a goal", jarvis_url=fake_agent)
    assert "Confirmation needed" in reply


def test_handoff_agent_error_raises_with_detail(fake_agent):
    with pytest.raises(RuntimeError, match="LLM call failed"):
        send_to_agent("make it fail", jarvis_url=fake_agent)


def test_handoff_refuses_empty_transcript():
    with pytest.raises(ValueError):
        send_to_agent("   ", jarvis_url="http://127.0.0.1:1")


def test_handoff_jarvis_down_is_clear():
    with pytest.raises(RuntimeError, match="not reachable"):
        send_to_agent("hello", jarvis_url="http://127.0.0.1:9")
