import fs from "fs";
import path from "path";

// Obsidian vault read/append, straight off disk. The vault path comes from
// OBSIDIAN_VAULT_PATH; every user-supplied note path is resolved and must
// stay inside the vault (path-traversal guard). Not configured → clear
// error state, never a crash.

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const MAX_FILES = 5000;

export class VaultNotConfiguredError extends Error {
  constructor() {
    super("OBSIDIAN_VAULT_PATH is not set (or does not exist) — set it in .env.local");
  }
}

export function vaultPath(): string {
  const p = process.env.OBSIDIAN_VAULT_PATH;
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new VaultNotConfiguredError();
  }
  return path.resolve(p);
}

export function isVaultConfigured(): boolean {
  try {
    vaultPath();
    return true;
  } catch {
    return false;
  }
}

// Resolve a user/agent-supplied relative path safely inside the vault.
function resolveInVault(vault: string, relPath: string): string {
  const withExt = relPath.toLowerCase().endsWith(".md") ? relPath : `${relPath}.md`;
  const full = path.resolve(vault, withExt);
  if (full !== vault && !full.startsWith(vault + path.sep)) {
    throw new Error(`Path escapes the vault: "${relPath}"`);
  }
  return full;
}

function walkMarkdownFiles(vault: string): string[] {
  const files: string[] = [];
  const stack = [vault];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Case-insensitive: Obsidian writes ".Trash" on some platforms.
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

export type NoteSummary = { path: string; modified: string };
export type NoteContent = { path: string; content: string };
export type SearchHit = { path: string; snippet: string };

function readUtf8(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

function findDailyNoteFile(vault: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  return (
    walkMarkdownFiles(vault).find(
      (f) => path.basename(f).toLowerCase() === `${today}.md`
    ) ?? null
  );
}

// Today's daily note: any file named YYYY-MM-DD.md, wherever it lives
// (Obsidian daily-notes folders vary).
export function todaysDailyNote(): NoteContent | null {
  const vault = vaultPath();
  const match = findDailyNoteFile(vault);
  if (!match) return null;
  return {
    path: path.relative(vault, match),
    content: readUtf8(match).slice(0, 20_000),
  };
}

export function recentNotes(limit = 10): NoteSummary[] {
  const vault = vaultPath();
  return walkMarkdownFiles(vault)
    .map((f) => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => ({
      path: path.relative(vault, f.file),
      modified: new Date(f.mtime).toISOString(),
    }));
}

// Every note in the vault (walker already skips .obsidian/.trash/.git and
// caps at MAX_FILES), sorted by path for the explorer tree. Paths are
// normalized to forward slashes so the tree renders identically on
// Windows; readNote resolves either separator.
export function allNotes(): NoteSummary[] {
  const vault = vaultPath();
  return walkMarkdownFiles(vault)
    .map((f) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch {
        // race: file deleted mid-walk — keep it listed, opening will 404 clearly
      }
      return {
        path: path.relative(vault, f).split(path.sep).join("/"),
        modified: new Date(mtime).toISOString(),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function searchNotes(query: string, limit = 20): SearchHit[] {
  const vault = vaultPath();
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const file of walkMarkdownFiles(vault)) {
    if (hits.length >= limit) break;
    const rel = path.relative(vault, file);
    if (rel.toLowerCase().includes(needle)) {
      hits.push({ path: rel, snippet: "(filename match)" });
      continue;
    }
    let content: string;
    try {
      content = readUtf8(file);
    } catch {
      continue;
    }
    const idx = content.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      const from = Math.max(0, idx - 60);
      const snippet = content
        .slice(from, idx + needle.length + 60)
        .replace(/\s+/g, " ")
        .trim();
      hits.push({ path: rel, snippet: `…${snippet}…` });
    }
  }
  return hits;
}

export function readNote(relPath: string): NoteContent {
  const vault = vaultPath();
  const full = resolveInVault(vault, relPath);
  if (!fs.existsSync(full)) throw new Error(`Note not found: "${relPath}"`);
  return {
    path: path.relative(vault, full),
    content: readUtf8(full).slice(0, 50_000),
  };
}

// Append (additive only — never overwrites). Missing file is created,
// missing parent folders too; defaults to today's daily note — the existing
// one wherever it lives in the vault, else a new one at the vault root.
export function appendNote(relPath: string | undefined, text: string): string {
  const vault = vaultPath();
  const target =
    relPath ??
    (findDailyNoteFile(vault)
      ? path.relative(vault, findDailyNoteFile(vault) as string)
      : `${new Date().toISOString().slice(0, 10)}.md`);
  const full = resolveInVault(vault, target);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const existing = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(full, `${separator}${text}\n`, "utf8");
  return path.relative(vault, full);
}
