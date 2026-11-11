/** "601 jobs waiting, oldest 6 hours ago — the scheduler may not be running." Null when nothing is overdue. */
export function backlogMessage(b: { overdue: number; oldestDueAt: string | null } | null, now = new Date()): string | null {
  if (!b || b.overdue <= 0) return null;
  const mins = b.oldestDueAt ? Math.max(0, Math.round((+now - Date.parse(b.oldestDueAt)) / 60000)) : null;
  const age = mins === null ? "" : mins < 60 ? `, oldest ${mins} min ago` : mins < 48 * 60 ? `, oldest ${Math.round(mins / 60)} h ago` : `, oldest ${Math.round(mins / 1440)} days ago`;
  return `${b.overdue.toLocaleString("en-IN")} background job${b.overdue === 1 ? "" : "s"} waiting${age} — the scheduler may not be running. Results that depend on them (scores, briefs, tasks) may be out of date.`;
}
