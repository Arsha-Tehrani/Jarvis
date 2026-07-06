"""Transcript → Jarvis. POSTs to /api/agent exactly the payload the chat box
sends ({"text": ...}), so a spoken sentence can add tasks, log meals via
log_meal, or just get answered."""

import httpx

from . import config


def send_to_agent(text: str, jarvis_url: str = config.JARVIS_URL) -> str:
    """Returns the agent's reply string; raises RuntimeError with a clear
    message when Jarvis is down or refuses the turn."""
    text = text.strip()
    if not text:
        raise ValueError("Nothing to send: transcript is empty")
    try:
        response = httpx.post(
            f"{jarvis_url}/api/agent", json={"text": text}, timeout=300
        )
    except httpx.HTTPError as err:
        raise RuntimeError(
            f"Jarvis app not reachable at {jarvis_url} — is `npm run dev` running?"
        ) from err
    data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    if response.status_code != 200:
        raise RuntimeError(
            f"Agent turn failed ({response.status_code}): {data.get('error', response.text[:200])}"
        )
    reply = data.get("reply", "")
    if data.get("pending"):
        reply += "\n(Confirmation needed — open the Jarvis chat to approve.)"
    return reply
