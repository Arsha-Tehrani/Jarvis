// Goals were folded into the unified Tracker model (Part E). This module is a
// thin compatibility shim so existing importers (morning brief, weekly digest,
// Today dashboard) keep working while reading from the one Tracker source.
export { computeGoalsProgress, type GoalProgress } from "@/lib/trackers";
