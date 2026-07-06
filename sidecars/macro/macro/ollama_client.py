"""Local Ollama calls: JSON-mode extraction chat and vision description."""

import base64

import httpx

from . import config


def _post_chat(payload: dict, model: str) -> str:
    try:
        response = httpx.post(
            f"{config.OLLAMA_BASE_URL}/api/chat", json=payload, timeout=300
        )
    except httpx.HTTPError as err:
        raise RuntimeError(
            f"Could not reach Ollama at {config.OLLAMA_BASE_URL}. "
            "Is it running? (ollama serve)"
        ) from err
    if response.status_code == 404:
        raise RuntimeError(f"Model {model!r} not found. Run: ollama pull {model}")
    response.raise_for_status()
    return response.json()["message"]["content"] or ""


def chat_json(messages: list[dict]) -> str:
    """One completion from the primary text model with Ollama JSON mode
    (format=json constrains decoding to valid JSON — the schema gate in
    schema.py still validates the shape and bounds)."""
    return _post_chat(
        {
            "model": config.TEXT_MODEL,
            "messages": messages,
            "format": "json",
            "stream": False,
        },
        config.TEXT_MODEL,
    )


VISION_PROMPT = (
    "Identify every food and drink item in this photo. For each item, "
    "estimate the portion size (grams, cups, or pieces). Reply as a short "
    "plain-text list like '2 scrambled eggs; 1 slice whole-wheat toast with "
    "butter; ~200ml orange juice'. Only describe what is visible."
)


def describe_image(image_bytes: bytes) -> str:
    """Food photo → portion description via the local vision model.

    HONEST NOTE: photo calorie estimates are rough approximations — the
    model guesses portions from a single 2D image and can miss oils,
    dressings, and anything occluded. The text path (user-stated portions)
    is more accurate; photo entries are labeled source='photo' downstream.
    """
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return _post_chat(
        {
            "model": config.VISION_MODEL,
            "messages": [{"role": "user", "content": VISION_PROMPT, "images": [encoded]}],
            "stream": False,
        },
        config.VISION_MODEL,
    )


def pulled_models() -> list[str] | None:
    """Model tags Ollama has locally, or None if Ollama is unreachable."""
    try:
        response = httpx.get(f"{config.OLLAMA_BASE_URL}/api/tags", timeout=5)
        response.raise_for_status()
    except httpx.HTTPError:
        return None
    return [m["name"] for m in response.json().get("models", [])]
