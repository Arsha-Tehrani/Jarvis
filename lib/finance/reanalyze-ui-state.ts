// Pure state transition for the Finance page's import-log dialog and its
// Re-Analyze confirmation UI. Two invariants, one state value:
//
// 1. At most one pending re-analyze action (a single statement, or "all")
//    can be shown at a time — opening either kind always replaces whatever
//    was previously pending, so a single-statement card and the "all" card
//    can never both be on screen together (the original bug: two independent
//    booleans let both open at once, and confirming one left the other's
//    stale card on screen, actionable against already-changed data).
// 2. The statement list now lives inside a dialog (fix-plan-3 Phase 2), and
//    closing that dialog also clears any pending confirmation — a hidden
//    card must never survive behind a closed log, or reopening could show a
//    confirm built against already-changed data. Same failure mode as (1),
//    prevented in the same reducer rather than a second, disconnected
//    boolean.

export type ReanalyzePending = { type: "single"; statementId: number } | { type: "all" } | null;

export type ImportLogUiState = {
  logOpen: boolean;
  pending: ReanalyzePending;
};

export const importLogInitialState: ImportLogUiState = { logOpen: false, pending: null };

export type ReanalyzeUiAction =
  | { type: "open_log" }
  | { type: "close_log" }
  | { type: "open_single"; statementId: number }
  | { type: "open_all" }
  | { type: "close" };

export function reanalyzeUiReducer(
  state: ImportLogUiState,
  action: ReanalyzeUiAction
): ImportLogUiState {
  switch (action.type) {
    case "open_log":
      return { ...state, logOpen: true };
    case "close_log":
      return { logOpen: false, pending: null };
    case "open_single":
      return { ...state, pending: { type: "single", statementId: action.statementId } };
    case "open_all":
      return { ...state, pending: { type: "all" } };
    case "close":
      return { ...state, pending: null };
  }
}
