// Deterministic mail pre-filter — pure, unit-tested, no imports.
// Obvious newsletter/notification mail never reaches the model. Returns a
// category string, or null to let LLM triage decide.
export function preFilterCategory(sender: string, listUnsubscribe: string): string | null {
  if (listUnsubscribe) return "newsletter";
  const address = sender.toLowerCase();
  if (/no-?reply|donotreply|newsletter|notifications?@|updates@|marketing@|promo|mailer|digest@/.test(address)) {
    return "newsletter";
  }
  return null;
}
