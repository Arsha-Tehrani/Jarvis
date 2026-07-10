import { z } from "zod";

// Pure date handling for job applications — kept out of lib/career.ts so the
// node test suite can import it without pulling in the DB connection.

// Shared by the add_application tool schema and the /api/career create
// schema: a strict YYYY-MM-DD, optional. The agent resolves relative dates
// ("applied last Tuesday") to a concrete ISO date itself before calling.
export const applicationDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .optional()
  .describe(
    "Date the application was submitted as YYYY-MM-DD; omit for today. Resolve relative dates yourself."
  );

// Missing → today: an application that exists was applied to on some date,
// and today is the only honest default when no better one was given. Applied
// at execution time (here), not baked into the zod schema, so a validated
// payload still shows exactly what the caller sent.
export function resolveDateApplied(input?: string | null): string {
  return input ?? new Date().toISOString().slice(0, 10);
}
