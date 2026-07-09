// Pure state transition for the Finance page's Re-Analyze confirmation UI.
// At most one pending re-analyze action (a single statement, or "all") can
// be shown at a time — opening either kind always replaces whatever was
// previously pending, so a single-statement card and the "all" card can
// never both be on screen together (the bug this fixes: two independent
// booleans let both open at once, and confirming one left the other's stale
// card on screen, actionable against already-changed data).

export type ReanalyzePending = { type: "single"; statementId: number } | { type: "all" } | null;

export type ReanalyzeUiAction =
  | { type: "open_single"; statementId: number }
  | { type: "open_all" }
  | { type: "close" };

export function reanalyzeUiReducer(
  _state: ReanalyzePending,
  action: ReanalyzeUiAction
): ReanalyzePending {
  switch (action.type) {
    case "open_single":
      return { type: "single", statementId: action.statementId };
    case "open_all":
      return { type: "all" };
    case "close":
      return null;
  }
}
