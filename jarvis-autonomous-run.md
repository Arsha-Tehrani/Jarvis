# Jarvis — Autonomous "start it and walk away" guide

This is for running Claude Code unattended while you're out. It replaces the phase-by-phase
kickoff (which intentionally stops after each phase) with a single autonomous run that
progresses on its own, commits after each phase, and stops at the first point that genuinely
needs you (Google OAuth).

---

## A. Before you leave the house (checklist)

You do NOT need Ollama for this run, and you do NOT need any CSVs. Ollama is only the runtime
brain the *finished* app calls, and you're not testing yet — this run is pure code-building by
Claude Code (Fable). Install Ollama and add CSVs when you're back.

1. Install Node.js (recent LTS) and Claude Code: `npm install -g @anthropic-ai/claude-code`.
   Run `claude` once to log in.
2. Create the project folder, e.g. `~/jarvis`. Put `CLAUDE.md` at its ROOT and
   `jarvis-plan-final.md` beside it (or in `docs/`).
3. Turn on autonomy: either enable **auto mode** (recommended) or plan to launch with the
   bypass flag (see section D). Add the deny rules in section D either way.
4. Launch with the wrapper in section C so usage limits don't end the run.

Realistic reach: Phases 1–3 get BUILT — code written, typechecked, and committed. Anything that
needs the app actually running (the agent chat, live transaction categorization) is deliberately
left UNTESTED and listed in HANDOFF.md. It stops before Phase 4 (Calendar/OAuth).

## When you come back (≈5 minutes to first test)

1. Install Ollama; pull a tool-capable model sized to your RAM (ollama.com/library); start it.
2. Drop a sample bank CSV in `statements/`.
3. Add any API keys to `.env.local` (Finnhub/Alpha Vantage).
4. Run the app and work through HANDOFF.md's deferred-test checklist. You can drive this
   test-and-fix pass with a cheaper model (e.g. Opus) to save Fable for heavy building — that's
   just which model runs Claude Code, and is separate from Ollama (the app's own engine).

---

## B. The autonomous run prompt (paste this)

```
You are building the Jarvis dashboard described in CLAUDE.md and jarvis-plan-final.md in this
repo. Read both fully first; CLAUDE.md's "Non-negotiable rules" are binding.

This is an UNATTENDED run. I am away. Work autonomously and do not stop to ask me questions
unless you are truly blocked (missing secret, external service down, or a decision CLAUDE.md
says needs me). When blocked, don't spin — record it and move on or stop as instructed below.

Scope for this run: complete Phase 1, then Phase 2, then attempt Phase 3. STOP before Phase 4
(Notes/Stocks/Calendar) because Google OAuth needs my decision and secrets.

Rules for the run:
- Follow the phase specs and definitions of done in jarvis-phase1-kickoff.md (Phases 1–3).
- Ollama will NOT be running and I am not testing during this run. Build against the LLM
  interface in lib/llm.ts, but do not require a live model: skip live agent/chat and live
  categorization tests, rely on typecheck + non-LLM paths, and list every deferred test in
  HANDOFF.md. Treat a phase as "built" when it compiles, typechecks, and its non-LLM paths work.
- After each phase: run it / typecheck, verify its definition of done as far as possible, then
  `git add -A && git commit` with a clear message. Never move to the next phase on a red build.
- Validate every agent tool call before executing (zod). Confirm-gate money/destructive tools.
- Keep secrets server-side only. Never print or commit .env* or jarvis.db.
- If create-next-app refuses because CLAUDE.md / docs already exist, scaffold into a temporary
  subdirectory and merge, keeping CLAUDE.md at the repo root.
- Phase 3: BUILD the finance module fully even though no CSV is present (ingest, categorize via
  the lib/llm.ts interface, spend-by-category + recurring views, goals editor). Defer the live
  ingest/categorize test to HANDOFF.md rather than skipping the code. A tiny synthetic sample row
  for typechecking is fine, but do not require a real CSV or a live model.

When you reach the stop point (or get blocked), create HANDOFF.md summarizing: what was built,
what passed/failed verification, every commit made, anything you skipped and why, and the exact
next steps for me (including which Google OAuth path to choose per CLAUDE.md). Then stop.

Begin with Phase 1.
```

---

## C. Usage-limit wrapper (back off, then resume)

Native "auto-resume when the limit resets" is still a known gap in Claude Code, so use this
shell wrapper. It relaunches and resumes the same conversation after each stop; when you're
inside your usage window again it picks up where it left off. Save as `run-jarvis.sh`,
`chmod +x run-jarvis.sh`, then run it instead of `claude`.

```bash
#!/usr/bin/env bash
# Relaunch Claude Code until the task completes, waiting out usage-limit stops.
cd "$(dirname "$0")" || exit 1
INTERVAL="${CLAUDE_RETRY_SECONDS:-900}"   # 15 min between retries

# First launch: paste the section B prompt when the session opens, then let it run.
# Subsequent launches resume the same session with --continue.
FIRST=1
while true; do
  if [ "$FIRST" -eq 1 ]; then
    claude          # opens interactive; paste the Section B prompt here
    FIRST=0
  else
    claude --continue
  fi
  code=$?
  # Exit 0 = you ended it cleanly / task done -> stop looping.
  [ "$code" -eq 0 ] && { echo "Session ended cleanly. Done."; break; }
  echo "Session stopped (exit $code) — likely a usage-limit or transient stop."
  echo "Waiting ${INTERVAL}s, then resuming with --continue... (Ctrl+C to quit)"
  sleep "$INTERVAL" || break
done
```

Notes:
- The retry interval just needs to be longer than a usage window's reset; 15 min polling is
  fine because it simply re-tries until you're back inside your limit.
- Alternative if you'd rather not maintain a script: the community tool `claude-auto-retry`
  (npm) watches for the limit message and sends "continue" at reset. Same idea, packaged.
- If your plan allows enabling "extra usage", the hard stop may not trigger at all — but the
  wrapper is harmless either way.

---

## D. Permission setup (so it doesn't ask, without being reckless)

Preferred: turn on **auto mode** — it removes routine prompts but keeps a safety classifier and
keeps Claude working without stopping for clarifying questions. Check whether it's enabled for
your plan/model at code.claude.com/docs/en/auto-mode; enable per-project in `.claude/settings.json`.

If you instead use `--dangerously-skip-permissions` (blunt, intended for sandboxes), at minimum
protect your secrets. Put this in `.claude/settings.json` in the project — deny rules are honored
even in bypass mode:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env*)",
      "Read(./statements/**)",
      "Bash(rm -rf *)",
      "Bash(curl *)"
    ]
  }
}
```

Either way, because this is your real laptop with financial data and OAuth tokens, glance at the
commit history and HANDOFF.md when you get back before letting it touch Phase 4.
