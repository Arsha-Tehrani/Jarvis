# macro sidecar

Turns a **food photo or a text description** into validated macros
(`{item, calories, protein, carbs, fat}`) and upserts them into Jarvis's
`nutrition_logs` via the app's zod-validated `POST /api/nutrition`.
Standalone Python service — not part of the Next.js build.

**Honesty note:** photo calorie estimates are rough approximations — the
vision model guesses portions from one 2D image and misses oils/dressings.
The text path is more accurate. Photo entries are labeled `source='photo'`
and the API response carries a note saying so.

## Setup (one-time)

```powershell
cd sidecars/macro
py -3.13 -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# vision model for photos — CHECK https://ollama.com/search?c=vision for the
# current best tag first; the default is qwen2.5vl. Then:
ollama pull qwen2.5vl          # or whatever you set MACRO_VISION_MODEL to
# the text/extraction path uses the app's LLM_MODEL (default llama3.1:8b)
```

## Use

```powershell
.venv\Scripts\python -m macro.server        # http://127.0.0.1:8017
```

```
POST /nutrition   JSON      {"text": "chicken burrito and a coke", "date"?: "YYYY-MM-DD"}
POST /nutrition   multipart image=<file> [text=<caption>] [date=...]
→ {"source": "photo"|"text", "items": [...], "jarvis": {...}, "note"?}
GET /health → Ollama reachability + whether both models are pulled
```

Flow: image → vision model describes items+portions → primary model in
Ollama **JSON mode** extracts strict macros → `schema.py` validates (one
repair pass on bad output, then reject — invalid output is never upserted)
→ POST to Jarvis. Text input skips the vision step.

Config via env: `OLLAMA_BASE_URL`, `LLM_MODEL`, `MACRO_VISION_MODEL`,
`JARVIS_URL` (default `http://localhost:3000`), `MACRO_PORT` (8017).

## Tests (no models needed — chat/vision/Jarvis all stubbed)

```powershell
.venv\Scripts\python -m pytest
```
