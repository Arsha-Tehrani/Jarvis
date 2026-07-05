import { getDb } from "@/lib/db";

// Keep-in-touch: each person can have a contact cadence (days) and a
// birthday (MM-DD or YYYY-MM-DD — only month/day are used).

export type Person = {
  id: number;
  name: string;
  cadence_days: number | null;
  last_contacted: string | null;
  birthday: string | null;
  gift_ideas: string | null;
  notes: string | null;
};

export type PersonWithStatus = Person & {
  overdueDays: number | null; // null = not overdue / no cadence
  birthdayInDays: number | null; // 0 = today, within the next 30 days
};

function monthDay(birthday: string): { m: number; d: number } | null {
  const match = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(birthday.trim());
  if (!match) return null;
  return { m: Number(match[1]), d: Number(match[2]) };
}

function daysUntilBirthday(birthday: string, now: Date): number | null {
  const md = monthDay(birthday);
  if (!md) return null;
  const year = now.getFullYear();
  let next = new Date(Date.UTC(year, md.m - 1, md.d));
  const todayUtc = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  );
  if (next < todayUtc) next = new Date(Date.UTC(year + 1, md.m - 1, md.d));
  return Math.round((next.getTime() - todayUtc.getTime()) / 86400_000);
}

export function listPeople(): PersonWithStatus[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const people = getDb()
    .prepare("SELECT * FROM people ORDER BY name")
    .all() as Person[];

  return people.map((p) => {
    let overdueDays: number | null = null;
    if (p.cadence_days) {
      if (!p.last_contacted) {
        overdueDays = p.cadence_days; // never contacted → fully overdue
      } else {
        const dueBy = new Date(
          Date.parse(p.last_contacted.slice(0, 10)) + p.cadence_days * 86400_000
        )
          .toISOString()
          .slice(0, 10);
        if (dueBy <= today) {
          overdueDays = Math.round(
            (Date.parse(today) - Date.parse(dueBy)) / 86400_000
          );
        }
      }
    }
    const untilBirthday = p.birthday ? daysUntilBirthday(p.birthday, now) : null;
    return {
      ...p,
      overdueDays,
      birthdayInDays:
        untilBirthday != null && untilBirthday <= 30 ? untilBirthday : null,
    };
  });
}

export function overduePeople(): PersonWithStatus[] {
  return listPeople()
    .filter((p) => p.overdueDays != null)
    .sort((a, b) => (b.overdueDays ?? 0) - (a.overdueDays ?? 0));
}

export function birthdaysThisWeek(): PersonWithStatus[] {
  return listPeople()
    .filter((p) => p.birthdayInDays != null && p.birthdayInDays <= 7)
    .sort((a, b) => (a.birthdayInDays ?? 0) - (b.birthdayInDays ?? 0));
}

export function logContactByName(name: string, date?: string, notes?: string): string {
  const db = getDb();
  const person = db
    .prepare("SELECT id, name, notes FROM people WHERE LOWER(name) = LOWER(?)")
    .get(name.trim()) as { id: number; name: string; notes: string | null } | undefined;
  if (!person) {
    const names = (db.prepare("SELECT name FROM people ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .join(", ");
    throw new Error(
      `No person named "${name}". Known people: ${names || "(none — add them on the People page first)"}`
    );
  }
  const day = date ?? new Date().toISOString().slice(0, 10);
  const mergedNotes = notes
    ? `${person.notes ? `${person.notes}\n` : ""}${day}: ${notes}`
    : person.notes;
  db.prepare("UPDATE people SET last_contacted = ?, notes = ? WHERE id = ?").run(
    day,
    mergedNotes,
    person.id
  );
  return `Logged contact with ${person.name} on ${day}.`;
}
