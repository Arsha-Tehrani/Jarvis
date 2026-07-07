# Adding an agent tool

Every tool the agent can call lives in one registry: [`lib/tools.ts`](../lib/tools.ts).
A tool is `{ name, description, schema, requiresConfirm, handler }`. The agent
route validates the model's arguments against `schema` **before** `handler`
runs — an unvalidated call is never executed. That's the whole pattern; this
page is the recipe for repeating it.

## Worked example: `log_habit`

```ts
const logHabitSchema = z.object({
  name: z.string().min(1).max(100)
    .describe("The habit's name as the user calls it (matched case-insensitively)"),
  date: dateField, // shared YYYY-MM-DD field, optional, defaults to today
});

const logHabitTool: Tool<typeof logHabitSchema> = {
  name: "log_habit",
  description:
    "Mark a habit as done for a date (defaults to today). Use when the user says they did one of their tracked habits. Fails with the list of existing habits if the name doesn't match.",
  schema: logHabitSchema,
  requiresConfirm: false,
  handler: (args) => logHabitByName(args.name, args.date),
};
```

Why this one is the model example:

- **The handler is one line.** Real logic lives in a lib module
  (`lib/habits.ts`), where it's shared with the API route and testable.
- **It fails helpfully.** On an unknown habit, `logHabitByName` throws
  `No habit named "gymm". Existing habits: gym, reading, …` — the error goes
  back to the model/user with the valid options, so the next attempt can
  self-correct. Prefer this over a bare "not found".
- **`.describe()` on every field.** Those strings are the model's only
  documentation for the arguments — say what format you want ("resolve
  relative dates yourself") rather than hoping.

## Checklist

### 1. Define the zod schema

Constrain everything: `.min()/.max()` on strings and numbers, `z.enum` for
fixed choices, regex for dates (`dateField` already exists). For a
multi-kind tool where valid ranges differ per kind, use a **discriminated
union** — see `log_metric` (`healthValueSchema` in `lib/health.ts`), where
`mood` must be an int 1–5 but `sleep_hours` is 0–16.

### 2. Write the handler

- Put real logic in a `lib/` module; the handler in `tools.ts` just calls it.
- DB access goes through `getDb()` from `@/lib/db` with prepared statements.
- Don't call unconfigured services: check the `isXConfigured()` helper and
  throw a message that says how to fix it (see `ask_textbook`'s "sidecar is
  not running — start it: …").
- **Fail by throwing an `Error` with a clear message.** The agent route
  catches it per-call and reports `<tool> failed: <message>` — one bad call
  never kills the turn. Never `process.exit`, never swallow.
- Return a short past-tense confirmation string: `Logged "gym" for 2026-07-07.`

### 3. Decide `requiresConfirm`

The rule (non-negotiable #2): **money movement, deletion, or anything
hard-to-reverse → `true`.** Everything additive → `false`.

| `requiresConfirm: true` | `requiresConfirm: false` |
|---|---|
| `set_goal` (writes financial targets) | `add_task`, `log_gym` (additive rows) |
| `revert_action` (deletes logged data) | `append_note` (append-only, never overwrites) |
| a hypothetical `pay_bill` / `delete_transactions` | `create_calendar_event` (visible, easily deleted in Google) |

Confirmed tools aren't executed on the first leg — the route returns a
pending payload, the UI shows exactly what would run, and a second request
re-validates and executes.

### 4. Register it

Append your tool to the `tools` array at the bottom of `lib/tools.ts`
(`myTool as Tool`). That's it — the agent route, the Slack check-in path,
and the LLM tool list all read from that array.

### 5. Logging: do nothing

`agent_log` already records every turn generically — user text, validated
tool calls as JSON, result. **Do not add logging inside a handler**; it
would be redundant, and the undo system (`lib/revert-plan.ts`) depends on
the generic log being the single record of what ran. If your tool is
cleanly invertible, consider adding it to `REVERTIBLE_TOOLS` there too.

### 6. Test it

Template — validation gate plus happy path, in `tests/`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
// Import the PURE parts (schema / lib logic without db-network imports);
// tests run under plain `node --test`, where "@/..." aliases don't resolve.
import { myToolSchema } from "../lib/my-feature-core.ts";

test("rejects out-of-range args instead of executing", () => {
  const parsed = myToolSchema.safeParse({ name: "" }); // synthetic bad payload
  assert.equal(parsed.success, false);
});

test("accepts a well-formed call", () => {
  const parsed = myToolSchema.safeParse({ name: "gym" });
  assert.equal(parsed.success, true);
});
```

If the handler's logic is deterministic, extract it into a pure module and
test it directly (see `lib/revert-plan.ts` + `tests/revert-plan.test.ts`).
The contract under test is *"unvalidated output never executes"* — you're
testing the gate, not the model.

### 7. Update the tool list

The **"Current tools" line in `README.md`** (under "The agent") is
**manually maintained** — add your tool's name there. The system prompt
doesn't need touching: the LLM's tool list is generated from the registry.

Keep the whole thing boring. A new tool should be ~30 lines in `tools.ts`,
a lib function, and a test.
