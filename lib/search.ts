import { getDb } from "@/lib/db";
import { escapeLike } from "@/lib/finance/query-builder";
import { searchNotes } from "@/lib/notes";
import { semanticSearch } from "@/lib/search-index";
import { RankedHit, dedupeAgainstExact } from "@/lib/search-rank";

// Global search, two tiers:
//   1. exact  — deterministic LIKE matching across every local source
//      (this function); instant, no model involved, always works.
//   2. semantic — embedding index over tasks/notes/mail subjects catches
//      fuzzy queries the exact tier misses. Garnish: if Ollama or the
//      embedding model is down, results are simply exact-only.

export type SearchHit = { title: string; sub: string; href: string };
export type SearchGroup = { source: string; hits: SearchHit[] };

const LIMIT_PER_SOURCE = 8;

export async function globalSearch(query: string): Promise<SearchGroup[]> {
  const groups = exactSearch(query);
  try {
    mergeSemanticHits(groups, await semanticSearch(query));
  } catch {
    // embedding model not running — exact tier already answered
  }
  return groups;
}

// Where each semantic source's hits render.
const SEMANTIC_GROUPS: Record<string, { source: string; href: (refId: string) => string }> = {
  task: { source: "Tasks", href: () => "/tasks" },
  mail: { source: "Mail", href: () => "/mail" },
  note: { source: "Notes", href: (refId) => `/notes?path=${encodeURIComponent(refId)}` },
};

function mergeSemanticHits(groups: SearchGroup[], ranked: RankedHit[]): void {
  for (const [sourceKey, target] of Object.entries(SEMANTIC_GROUPS)) {
    const group = groups.find((g) => g.source === target.source);
    const fuzzy = dedupeAgainstExact(
      ranked.filter((h) => h.source === sourceKey),
      group?.hits.map((h) => h.title) ?? []
    );
    if (fuzzy.length === 0) continue;
    const hits: SearchHit[] = fuzzy.map((h) => ({
      title: h.text,
      sub: `similar match · ${Math.round(h.score * 100)}%`,
      href: target.href(h.refId),
    }));
    if (group) group.hits.push(...hits.slice(0, Math.max(0, LIMIT_PER_SOURCE - group.hits.length)));
    else groups.push({ source: target.source, hits });
  }
}

function exactSearch(query: string): SearchGroup[] {
  const db = getDb();
  const like = `%${escapeLike(query)}%`;
  const groups: SearchGroup[] = [];
  const usd = (v: number) =>
    `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  const tasks = db
    .prepare(
      `SELECT id, title, status, due_at FROM tasks
       WHERE title LIKE ? ESCAPE '\\' ORDER BY status ASC, id DESC LIMIT ?`
    )
    .all(like, LIMIT_PER_SOURCE) as {
    id: number;
    title: string;
    status: string;
    due_at: string | null;
  }[];
  if (tasks.length > 0) {
    groups.push({
      source: "Tasks",
      hits: tasks.map((t) => ({
        title: t.title,
        sub: `${t.status}${t.due_at ? ` · due ${t.due_at.slice(0, 10)}` : ""}`,
        href: "/tasks",
      })),
    });
  }

  const txns = db
    .prepare(
      `SELECT merchant, raw_description, amount, date, category FROM transactions
       WHERE merchant LIKE ? ESCAPE '\\' OR raw_description LIKE ? ESCAPE '\\'
       ORDER BY date DESC LIMIT ?`
    )
    .all(like, like, LIMIT_PER_SOURCE) as {
    merchant: string;
    raw_description: string;
    amount: number;
    date: string;
    category: string;
  }[];
  if (txns.length > 0) {
    groups.push({
      source: "Transactions",
      hits: txns.map((t) => ({
        title: `${t.merchant} ${t.amount < 0 ? "-" : "+"}${usd(t.amount)}`,
        sub: `${t.date} · ${t.category}`,
        href: "/finance",
      })),
    });
  }

  const mail = db
    .prepare(
      `SELECT sender, subject, account, importance FROM mail_messages
       WHERE sender LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\'
       ORDER BY received_at DESC LIMIT ?`
    )
    .all(like, like, LIMIT_PER_SOURCE) as {
    sender: string;
    subject: string;
    account: string;
    importance: string | null;
  }[];
  if (mail.length > 0) {
    groups.push({
      source: "Mail",
      hits: mail.map((m) => ({
        title: m.subject,
        sub: `${m.sender} · ${m.account}${m.importance ? ` · ${m.importance}` : ""}`,
        href: "/mail",
      })),
    });
  }

  const people = db
    .prepare(
      `SELECT name, notes, last_contacted FROM people
       WHERE name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\'
       ORDER BY name LIMIT ?`
    )
    .all(like, like, LIMIT_PER_SOURCE) as {
    name: string;
    notes: string | null;
    last_contacted: string | null;
  }[];
  if (people.length > 0) {
    groups.push({
      source: "People",
      hits: people.map((p) => ({
        title: p.name,
        sub: p.last_contacted ? `last contact ${p.last_contacted}` : "never contacted",
        href: "/people",
      })),
    });
  }

  const reading = db
    .prepare(
      `SELECT title, author, status FROM reading
       WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT ?`
    )
    .all(like, like, LIMIT_PER_SOURCE) as {
    title: string;
    author: string | null;
    status: string;
  }[];
  if (reading.length > 0) {
    groups.push({
      source: "Reading",
      hits: reading.map((r) => ({
        title: r.title,
        sub: `${r.status}${r.author ? ` · ${r.author}` : ""}`,
        href: "/reading",
      })),
    });
  }

  const applications = db
    .prepare(
      `SELECT company, role, stage FROM applications
       WHERE company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(like, like, LIMIT_PER_SOURCE) as {
    company: string;
    role: string;
    stage: string;
  }[];
  if (applications.length > 0) {
    groups.push({
      source: "Career",
      hits: applications.map((a) => ({
        title: `${a.company} — ${a.role}`,
        sub: a.stage,
        href: "/career",
      })),
    });
  }

  const habits = db
    .prepare("SELECT name FROM habits WHERE name LIKE ? ESCAPE '\\' LIMIT ?")
    .all(like, LIMIT_PER_SOURCE) as { name: string }[];
  if (habits.length > 0) {
    groups.push({
      source: "Habits",
      hits: habits.map((h) => ({ title: h.name, sub: "habit", href: "/habits" })),
    });
  }

  // Obsidian is best-effort: skip quietly when the vault isn't configured.
  try {
    const notes = searchNotes(query, LIMIT_PER_SOURCE);
    if (notes.length > 0) {
      groups.push({
        source: "Notes",
        hits: notes.map((n) => ({
          title: n.path,
          sub: n.snippet,
          href: `/notes?path=${encodeURIComponent(n.path)}`,
        })),
      });
    }
  } catch {
    // vault not configured — other sources still answer
  }

  return groups;
}
