"""Routing endpoint: food photo OR text description → strict nutrition JSON
→ upsert into Jarvis.

    .venv/Scripts/python -m macro.server        # http://127.0.0.1:8017

POST /nutrition
  as JSON:      {"text": "chicken burrito and a coke", "date": "2026-07-06"?}
  as multipart: image=<file> (and/or text=..., date=...)
→ {"source": "photo"|"text", "items": [...], "jarvis": {...}, "note"?: str}

HONEST NOTE: photo calorie estimates are rough approximations (see
ollama_client.describe_image) — the text path is more accurate. Photo
results carry a "note" saying so and are stored with source='photo'.
"""

import re

from fastapi import FastAPI, HTTPException, Request
from starlette.datastructures import UploadFile

from . import config
from .extract import extract_nutrition
from .jarvis_client import post_meals
from .ollama_client import describe_image, pulled_models
from .schema import MealParseError

app = FastAPI(title="Jarvis macro sidecar")

PHOTO_NOTE = (
    "Photo macros are rough approximations — portions are guessed from one "
    "image. Describing the meal in text is more accurate."
)

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_TEXT = 2000
MAX_IMAGE_BYTES = 20 * 1024 * 1024


async def _parse_payload(request: Request) -> tuple[bytes | None, str | None, str | None]:
    """→ (image_bytes, text, date) from either multipart or JSON."""
    content_type = request.headers.get("content-type", "")
    if content_type.startswith(("multipart/form-data", "application/x-www-form-urlencoded")):
        form = await request.form()
        image = form.get("image")
        image_bytes = await image.read() if isinstance(image, UploadFile) else None
        text = form.get("text")
        date = form.get("date")
        return (
            image_bytes,
            text if isinstance(text, str) else None,
            date if isinstance(date, str) else None,
        )
    body = await request.json() if await request.body() else {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    text = body.get("text")
    date = body.get("date")
    return None, text if isinstance(text, str) else None, date if isinstance(date, str) else None


@app.post("/nutrition")
async def nutrition(request: Request) -> dict:
    try:
        image_bytes, text, date = await _parse_payload(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Unreadable request body") from None

    if date and not DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    if text is not None and (not text.strip() or len(text) > MAX_TEXT):
        raise HTTPException(status_code=400, detail=f"text must be 1..{MAX_TEXT} chars")
    if image_bytes is not None and len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="image too large (max 20 MB)")

    try:
        if image_bytes:
            source = "photo"
            description = describe_image(image_bytes)
            if text:  # user caption sharpens the vision description
                description = f"{description}\n\nUser adds: {text}"
        elif text:
            source = "text"
            description = text
        else:
            raise HTTPException(
                status_code=400,
                detail="Send an image file (multipart field 'image') or a JSON/form 'text' field",
            )
        items = extract_nutrition(description)
        jarvis = post_meals(items, source, date)
    except MealParseError as err:
        # Model output failed validation even after the repair pass: reject,
        # never upsert (the schema gate is mandatory).
        raise HTTPException(
            status_code=422, detail=f"Model returned invalid nutrition JSON: {err}"
        ) from err
    except RuntimeError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err

    result: dict = {
        "source": source,
        "items": [item.model_dump() for item in items],
        "jarvis": jarvis,
    }
    if source == "photo":
        result["note"] = PHOTO_NOTE
    return result


@app.get("/health")
def health() -> dict:
    models = pulled_models()
    return {
        "status": "ok",
        "ollama": "up" if models is not None else "unreachable",
        "text_model": config.TEXT_MODEL,
        "text_model_pulled": None if models is None else any(m.startswith(config.TEXT_MODEL) for m in models),
        "vision_model": config.VISION_MODEL,
        "vision_model_pulled": None if models is None else any(m.startswith(config.VISION_MODEL) for m in models),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
