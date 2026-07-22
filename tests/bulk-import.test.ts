import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import {
  bulkProposalSchema,
  detectSourceMode,
  parseBulkImportResponse,
  splitIntoChunks,
  splitSections,
} from "../lib/bulk-import/schema.ts";
import { parseChunkWithRepair, type ChatLike } from "../lib/bulk-import/parse-core.ts";
import {
  commitBulkImport,
  discardBulkImport,
  finalSelectionSchema,
  taskDescription,
  undoBulkImport,
} from "../lib/bulk-import/commit.ts";
import { canSplit, mergeTasks, noteBullets, splitTask } from "../lib/bulk-import/preview-edit.ts";
import { SYNC_TABLE_NAMES, getCategory } from "../lib/sync/tables.ts";
import { BACKUP_TABLES } from "../lib/backup-tables.ts";

// The worked-example fixture from the spec: an already-STRUCTURED checklist
// (lettered sections) that exercises structured-mode grouping, sub-item
// expansion, dependency flagging, calendar-suggestion, and
// no-date-when-none-implied in one input. The LLM itself is never called live
// in tests (this repo's rule) — the fixture drives the pure halves: mode
// detection, section splitting, chunking, and the validation gate against a
// hand-written correct proposal for it.
const FIXTURE = `Insurance & Coverage Checklist

A. Confirm Medicaid Status
☐ Call NJ FamilyCare at 1-800-701-0710 — ask them to confirm whether your coverage is active, and have your case number ready as proof.
☐ Check the NJ FamilyCare member portal for your renewal date.

B. Your Own Coverage
☐ Call each of these four insurers to ask about individual plans:
  - Horizon BCBS (1-800-355-2583)
  - AmeriHealth NJ (1-888-968-7241)
  - Oscar Health (1-855-672-2755)
  - UnitedHealthcare (1-866-414-1959)

C. Sister's Coverage
☐ Get the exact biologic name and dose from her doctor first.
☐ Contact the manufacturer patient-assistance program that matches the biologic.

D. General / Ongoing
☐ This exception ends on your 21st birthday, August 2027 — set something so you don't miss it.
☐ If your asylum case is granted, revisit this whole plan.`;

// A correct model proposal for the fixture — what a well-behaved parse looks
// like after the gate. Used to prove the schema accepts the full shape the
// spec's design decisions need (dependsOnNote, suggestAsReminder, null dates).
const FIXTURE_PROPOSAL = {
  groups: [
    {
      name: "A. Confirm Medicaid Status",
      reasoning: "The source's own section A groups the Medicaid status checks.",
      tasks: [
        {
          title: "Call NJ FamilyCare",
          notes:
            "1-800-701-0710 — ask them to confirm whether coverage is active; have the case number ready as proof.",
          due_at: null,
          priority: null,
          dependsOnNote: null,
          suggestAsReminder: false,
        },
        {
          title: "Check the NJ FamilyCare member portal for the renewal date",
          notes: null,
          due_at: null,
          priority: null,
          dependsOnNote: null,
          suggestAsReminder: false,
        },
      ],
    },
    {
      name: "B. Your Own Coverage",
      reasoning: "Section B's items are all calls about the user's own individual plan.",
      tasks: [
        { title: "Call Horizon BCBS about individual plans", notes: "1-800-355-2583", due_at: null, priority: null, dependsOnNote: null, suggestAsReminder: false },
        { title: "Call AmeriHealth NJ about individual plans", notes: "1-888-968-7241", due_at: null, priority: null, dependsOnNote: null, suggestAsReminder: false },
        { title: "Call Oscar Health about individual plans", notes: "1-855-672-2755", due_at: null, priority: null, dependsOnNote: null, suggestAsReminder: false },
        { title: "Call UnitedHealthcare about individual plans", notes: "1-866-414-1959", due_at: null, priority: null, dependsOnNote: null, suggestAsReminder: false },
      ],
    },
    {
      name: "C. Sister's Coverage",
      reasoning: "Section C covers the sister's biologic coverage steps.",
      tasks: [
        { title: "Get the exact biologic name and dose from the doctor", notes: null, due_at: null, priority: null, dependsOnNote: null, suggestAsReminder: false },
        {
          title: "Contact the matching manufacturer patient-assistance program",
          notes: null,
          due_at: null,
          priority: null,
          dependsOnNote: "after confirming the exact biologic name/dose",
          suggestAsReminder: false,
        },
      ],
    },
    {
      name: "D. General / Ongoing",
      reasoning: "Section D holds the standing/date-anchored items.",
      tasks: [
        {
          title: "Coverage exception ends on 21st birthday",
          notes: "August 2027 — needs an actual notification, not just a list entry.",
          due_at: "2027-08-01",
          priority: null,
          dependsOnNote: null,
          suggestAsReminder: true,
        },
        {
          title: "If the asylum case is granted, revisit the whole coverage plan",
          notes: null,
          due_at: null, // condition-triggered, not date-triggered — no guessed date
          priority: null,
          dependsOnNote: null,
          suggestAsReminder: false,
        },
      ],
    },
  ],
};

// ---- source-mode detection ---------------------------------------------------

test("fixture is detected as structured with its four source sections, in order", () => {
  assert.equal(detectSourceMode(FIXTURE), "structured");
  const sections = splitSections(FIXTURE);
  assert.ok(sections);
  assert.deepEqual(
    sections.map((s) => s.name),
    ["A. Confirm Medicaid Status", "B. Your Own Coverage", "C. Sister's Coverage", "D. General / Ongoing"]
  );
  // The preamble line is kept (prepended to the first section), never dropped.
  assert.ok(sections[0].body.includes("Insurance & Coverage Checklist"));
});

test("a flat dump with no headers is unstructured", () => {
  const flat = `call the bank about the disputed charge
pick up the dry cleaning
email Sam the draft
renew the passport before the trip`;
  assert.equal(detectSourceMode(flat), "unstructured");
  assert.equal(splitSections(flat), null);
});

test("a single header alone doesn't make input structured", () => {
  const text = `A. Only section\n☐ one item\n☐ two item`;
  assert.equal(detectSourceMode(text), "unstructured");
});

// ---- chunking ----------------------------------------------------------------

test("below the threshold the paste is one chunk", () => {
  assert.deepEqual(splitIntoChunks(FIXTURE, 10_000), [FIXTURE.trim()]);
});

test("above the threshold, structured input splits on section boundaries — never mid-item", () => {
  const chunks = splitIntoChunks(FIXTURE, 400);
  assert.ok(chunks.length > 1);
  // Every checklist line survives, in order, across the concatenation.
  const joined = chunks.join("\n\n");
  for (const line of FIXTURE.split("\n").filter((l) => l.trim().startsWith("☐"))) {
    assert.ok(joined.includes(line.trim()), `missing line: ${line}`);
  }
  // Section D's items stay in the same chunk as their header.
  const dChunk = chunks.find((c) => c.includes("D. General / Ongoing"));
  assert.ok(dChunk?.includes("asylum case"));
});

test("above the threshold, unstructured input splits on blank-line blocks", () => {
  const block = "call somebody about something important today\n";
  const text = Array.from({ length: 40 }, (_, i) => `${block}line ${i}`).join("\n\n");
  const chunks = splitIntoChunks(text, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(!c.startsWith("\n") && c.trim().length > 0);
  }
});

// ---- the validation gate -----------------------------------------------------

test("a correct proposal for the fixture passes the gate", () => {
  const parsed = bulkProposalSchema.safeParse(FIXTURE_PROPOSAL);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  // Structured mode kept the source's four groups in source order.
  assert.equal(parsed.data.groups.length, 4);
  // Sub-item expansion: the four-insurer sub-list is four separate tasks.
  assert.equal(parsed.data.groups[1].tasks.length, 4);
  // Dependency flag and reminder flag survive validation.
  assert.equal(
    parsed.data.groups[2].tasks[1].dependsOnNote,
    "after confirming the exact biologic name/dose"
  );
  assert.equal(parsed.data.groups[3].tasks[0].suggestAsReminder, true);
  // Condition-triggered item keeps a null date.
  assert.equal(parsed.data.groups[3].tasks[1].due_at, null);
});

test("a group with a missing reasoning field fails the gate (schema-required)", () => {
  const bad = {
    groups: [{ name: "G", tasks: [{ title: "t", suggestAsReminder: false }] }],
  };
  assert.ok(!bulkProposalSchema.safeParse(bad).success);
});

test("an empty-string reasoning fails too", () => {
  const bad = {
    groups: [{ name: "G", reasoning: "  ", tasks: [{ title: "t" }] }],
  };
  assert.ok(!bulkProposalSchema.safeParse(bad).success);
});

test("omitted optional task fields normalize to null/false", () => {
  const parsed = bulkProposalSchema.parse({
    groups: [{ name: "G", reasoning: "why", tasks: [{ title: "t" }] }],
  });
  const t = parsed.groups[0].tasks[0];
  assert.equal(t.notes, null);
  assert.equal(t.due_at, null);
  assert.equal(t.priority, null);
  assert.equal(t.dependsOnNote, null);
  assert.equal(t.suggestAsReminder, false);
});

test("a malformed due date fails the gate", () => {
  const bad = {
    groups: [
      { name: "G", reasoning: "why", tasks: [{ title: "t", due_at: "next Friday" }] },
    ],
  };
  assert.ok(!bulkProposalSchema.safeParse(bad).success);
});

test("parseBulkImportResponse extracts JSON from surrounding prose", () => {
  const p = parseBulkImportResponse(
    `Here you go:\n${JSON.stringify(FIXTURE_PROPOSAL)}\nHope that helps!`
  );
  assert.equal(p.groups.length, 4);
});

test("parseBulkImportResponse throws clearly on no-JSON and invalid-JSON replies", () => {
  assert.throws(() => parseBulkImportResponse("I couldn't parse that."), /no JSON object/);
  assert.throws(() => parseBulkImportResponse('{"groups": [,]}'), /not valid JSON/);
});

// ---- one-repair-then-reject --------------------------------------------------

function scriptedChat(replies: string[]): { fn: ChatLike; calls: Array<{ role: string; content: string }[]> } {
  const calls: Array<{ role: string; content: string }[]> = [];
  let i = 0;
  return {
    calls,
    fn: async ({ messages }) => {
      calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return { text: replies[Math.min(i++, replies.length - 1)], meta: { model: "test-model" } };
    },
  };
}

test("a malformed first response gets one corrective retry that shows the model its error", async () => {
  const good = JSON.stringify(FIXTURE_PROPOSAL);
  const { fn, calls } = scriptedChat(["not json at all", good]);
  const result = await parseChunkWithRepair(FIXTURE, "structured", "2026-07-18", fn);
  assert.equal(result.groups.length, 4);
  assert.equal(calls.length, 2);
  const repairTurn = calls[1];
  // The retry carries the model's own bad output and the rejection reason.
  assert.ok(repairTurn.some((m) => m.role === "assistant" && m.content === "not json at all"));
  assert.ok(repairTurn.some((m) => m.content.includes("rejected")));
});

test("a second malformed response hard-rejects — never partial data", async () => {
  const { fn, calls } = scriptedChat(['{"groups": "nope"}', "still not json"]);
  await assert.rejects(
    () => parseChunkWithRepair(FIXTURE, "structured", "2026-07-18", fn),
    /after one repair attempt/
  );
  assert.equal(calls.length, 2); // exactly one retry, no more
});

// ---- commit / undo (in-memory db) -------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      due_at TEXT,
      priority TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      description TEXT, gcal_event_id TEXT, completed_at TEXT,
      sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
      sync_dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT
    );
    CREATE TABLE bulk_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      raw_input_text TEXT NOT NULL,
      source_mode TEXT NOT NULL,
      model_used TEXT,
      proposed_json TEXT NOT NULL,
      final_json TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_task_ids TEXT
    );
  `);
  return db;
}

function insertProposal(db: Database.Database): number {
  return Number(
    db
      .prepare(
        `INSERT INTO bulk_imports (raw_input_text, source_mode, proposed_json)
         VALUES ('raw', 'structured', ?)`
      )
      .run(JSON.stringify(FIXTURE_PROPOSAL)).lastInsertRowid
  );
}

test("commit writes only the edited selection — an excluded task is never created", () => {
  const db = freshDb();
  const importId = insertProposal(db);
  // The user kept group A's first task only, plus group C (both tasks).
  const selection = finalSelectionSchema.parse({
    groups: [
      { ...FIXTURE_PROPOSAL.groups[0], tasks: [FIXTURE_PROPOSAL.groups[0].tasks[0]] },
      FIXTURE_PROPOSAL.groups[2],
    ],
  });
  const result = commitBulkImport(db, importId, selection);
  assert.equal(result.taskIds.length, 3);

  const rows = db
    .prepare("SELECT title, description, priority, source, status FROM tasks ORDER BY id")
    .all() as Array<{ title: string; description: string | null; priority: string; source: string; status: string }>;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.source === "bulk_import" && r.status === "open"));
  // Null priority fell back to the app default.
  assert.ok(rows.every((r) => r.priority === "high"));
  // Notes landed in description; the dependency flag rides description too.
  assert.ok(rows[0].description?.includes("1-800-701-0710"));
  assert.ok(rows[2].description?.includes("After: after confirming the exact biologic name/dose"));
  // The excluded portal-check task was never created.
  assert.ok(!rows.some((r) => r.title.includes("portal")));

  const imp = db
    .prepare("SELECT status, final_json, created_task_ids FROM bulk_imports WHERE id = ?")
    .get(importId) as { status: string; final_json: string; created_task_ids: string };
  assert.equal(imp.status, "committed");
  assert.deepEqual(JSON.parse(imp.created_task_ids), result.taskIds);
  assert.ok(imp.final_json.includes("Call NJ FamilyCare"));
});

test("reminder-toggled items are returned for calendar creation, not written as tasks", () => {
  const db = freshDb();
  const importId = insertProposal(db);
  const selection = finalSelectionSchema.parse({
    groups: [
      {
        ...FIXTURE_PROPOSAL.groups[3],
        tasks: [
          { ...FIXTURE_PROPOSAL.groups[3].tasks[0], createAsReminder: true },
          FIXTURE_PROPOSAL.groups[3].tasks[1],
        ],
      },
    ],
  });
  const result = commitBulkImport(db, importId, selection);
  assert.equal(result.taskIds.length, 1);
  assert.equal(result.reminders.length, 1);
  assert.equal(result.reminders[0].title, "Coverage exception ends on 21st birthday");
  const titles = (db.prepare("SELECT title FROM tasks").all() as Array<{ title: string }>).map(
    (r) => r.title
  );
  assert.ok(!titles.some((t) => t.includes("21st birthday")));
});

test("a commit against an already-committed import is rejected (no double-write)", () => {
  const db = freshDb();
  const importId = insertProposal(db);
  const selection = finalSelectionSchema.parse({ groups: [FIXTURE_PROPOSAL.groups[0]] });
  commitBulkImport(db, importId, selection);
  assert.throws(() => commitBulkImport(db, importId, selection), /already committed/);
});

test("discard only works on a pending proposal", () => {
  const db = freshDb();
  const importId = insertProposal(db);
  discardBulkImport(db, importId);
  assert.equal(
    (db.prepare("SELECT status FROM bulk_imports WHERE id = ?").get(importId) as { status: string })
      .status,
    "discarded"
  );
  assert.throws(() => discardBulkImport(db, importId), /already discarded/);
});

test("bulk undo tombstones exactly the created tasks and no others", () => {
  const db = freshDb();
  // A pre-existing task that must survive the undo untouched.
  db.prepare("INSERT INTO tasks (title) VALUES ('pre-existing')").run();
  const importId = insertProposal(db);
  const selection = finalSelectionSchema.parse({ groups: [FIXTURE_PROPOSAL.groups[1]] });
  const { taskIds } = commitBulkImport(db, importId, selection);
  assert.equal(taskIds.length, 4);

  const result = undoBulkImport(db, importId);
  assert.equal(result.removed, 4);
  assert.deepEqual(result.removedTaskIds, taskIds);

  const alive = db
    .prepare("SELECT title FROM tasks WHERE deleted_at IS NULL")
    .all() as Array<{ title: string }>;
  assert.deepEqual(
    alive.map((r) => r.title),
    ["pre-existing"]
  );
  assert.equal(
    (db.prepare("SELECT status FROM bulk_imports WHERE id = ?").get(importId) as { status: string })
      .status,
    "reverted"
  );
  // A second undo is refused.
  assert.throws(() => undoBulkImport(db, importId), /only a committed import/);
});

test("undo skips tasks the user already deleted by hand", () => {
  const db = freshDb();
  const importId = insertProposal(db);
  const selection = finalSelectionSchema.parse({ groups: [FIXTURE_PROPOSAL.groups[0]] });
  const { taskIds } = commitBulkImport(db, importId, selection);
  db.prepare("UPDATE tasks SET deleted_at = '2026-07-18T00:00:00Z' WHERE id = ?").run(taskIds[0]);
  const result = undoBulkImport(db, importId);
  assert.equal(result.removed, taskIds.length - 1);
});

test("taskDescription folds notes + dependency note, and stays null when both empty", () => {
  assert.equal(
    taskDescription({
      title: "t",
      notes: "call 555",
      due_at: null,
      priority: null,
      dependsOnNote: "after X",
      suggestAsReminder: false,
    }),
    "call 555\n\nAfter: after X"
  );
  assert.equal(
    taskDescription({
      title: "t",
      notes: null,
      due_at: null,
      priority: null,
      dependsOnNote: null,
      suggestAsReminder: false,
    }),
    null
  );
});

// ---- preview split/merge -----------------------------------------------------

const SPLITTABLE = {
  name: "B",
  reasoning: "why",
  tasks: [
    {
      title: "Call each of these four insurers",
      notes: "ask about individual plans\n- Horizon BCBS (1-800-355-2583)\n- Oscar (1-855-672-2755)",
      due_at: "2026-07-25",
      priority: "high" as const,
      dependsOnNote: null,
      suggestAsReminder: false,
    },
  ],
};

test("split expands noted sub-bullets into separate tasks inheriting shared context", () => {
  assert.deepEqual(noteBullets(SPLITTABLE.tasks[0].notes), [
    "Horizon BCBS (1-800-355-2583)",
    "Oscar (1-855-672-2755)",
  ]);
  assert.ok(canSplit(SPLITTABLE.tasks[0]));
  const g = splitTask(SPLITTABLE, 0);
  assert.equal(g.tasks.length, 2);
  assert.equal(g.tasks[0].title, "Horizon BCBS (1-800-355-2583)");
  assert.ok(g.tasks[0].notes?.includes("ask about individual plans"));
  assert.equal(g.tasks[0].due_at, "2026-07-25"); // inherited
});

test("merge collapses tasks into one, keeping earliest due date and highest priority", () => {
  const g = {
    name: "G",
    reasoning: "why",
    tasks: [
      { title: "a", notes: null, due_at: "2026-08-01", priority: null, dependsOnNote: null, suggestAsReminder: false },
      { title: "b", notes: "detail", due_at: "2026-07-20", priority: "urgent" as const, dependsOnNote: null, suggestAsReminder: false },
    ],
  };
  const merged = mergeTasks(g, [0, 1]);
  assert.equal(merged.tasks.length, 1);
  assert.equal(merged.tasks[0].title, "a");
  assert.ok(merged.tasks[0].notes?.includes("- b (detail)"));
  assert.equal(merged.tasks[0].due_at, "2026-07-20");
  assert.equal(merged.tasks[0].priority, "urgent");
});

test("split/merge are no-ops on invalid input", () => {
  const g = { name: "G", reasoning: "r", tasks: SPLITTABLE.tasks };
  assert.equal(splitTask(g, 5), g);
  assert.equal(mergeTasks(g, [0]), g);
});

// ---- privacy: sync is now opt-in, backups still exclude it ------------------

test("bulk_imports sync is opt-in (registered but off by default), still never backed up", () => {
  // The Sync Control Center makes bulk_imports a toggle (pasted dumps are the
  // user's own hardware/mesh) — so it IS now a registered syncable table…
  assert.ok(SYNC_TABLE_NAMES.includes("bulk_imports"));
  // …but seeded OFF, so an upgrade doesn't start syncing it silently.
  assert.equal(getCategory("bulk-imports")?.defaultEnabled, false);
  // Backups still exclude it (privacy: like oauth_tokens, never leaves in a dump).
  assert.ok(!(BACKUP_TABLES as readonly string[]).includes("bulk_imports"));
});
