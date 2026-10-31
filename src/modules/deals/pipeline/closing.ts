/**
 * Closing coordinator (workflow 17) — pure, deterministic helpers: dependency timeline, blocked state, overdue /
 * blocked alerts and the outstanding-documents list. No I/O; dates are ISO yyyy-mm-dd strings compared lexically.
 */

export interface MilestoneLite {
  id: string; opportunity_id?: string; title: string; kind: string; status: string; due_date: string | null;
  depends_on: string | null; required_for_stage: string | null; proof_required: boolean; proof_text?: string | null;
  assignee_user_id?: string | null; owner_note?: string | null; sort_order?: number | null; template_key?: string | null;
}

export const CLEARED = new Set(["done", "waived", "not_applicable"]);
export const isCleared = (s: string) => CLEARED.has(s);

export interface TimelineItem extends MilestoneLite {
  level: number;                                  // 0 = no open prerequisite chain; n = depth in the dependency chain
  blocked: boolean;                               // explicitly blocked, or waiting on an uncleared dependency
  waitingOn: { id: string; title: string; status: string; due_date: string | null }[];  // full uncleared chain, nearest first
  overdue: boolean;
  daysOverdue: number | null;
  /** Earliest date this item can realistically finish = max(own due date, prerequisite due dates) — informational. */
  earliestFinish: string | null;
}

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Ordered timeline: dependency depth, then due date (unknown last), then template order. Cycles are cut defensively. */
export function dependencyTimeline(items: MilestoneLite[], asOf: string): TimelineItem[] {
  const byId = new Map(items.map((m) => [m.id, m]));
  const level = new Map<string, number>();
  const depth = (m: MilestoneLite, seen = new Set<string>()): number => {
    if (level.has(m.id)) return level.get(m.id)!;
    if (!m.depends_on || !byId.has(m.depends_on) || seen.has(m.id)) { level.set(m.id, 0); return 0; }
    seen.add(m.id);
    const d = depth(byId.get(m.depends_on)!, seen) + 1;
    level.set(m.id, d);
    return d;
  };
  const out: TimelineItem[] = items.map((m) => {
    const waitingOn: TimelineItem["waitingOn"] = [];
    const seen = new Set<string>([m.id]);
    let cur = m.depends_on ? byId.get(m.depends_on) : undefined;
    let earliest = m.due_date;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (!isCleared(cur.status)) {
        waitingOn.push({ id: cur.id, title: cur.title, status: cur.status, due_date: cur.due_date });
        if (cur.due_date && (!earliest || cur.due_date > earliest)) earliest = cur.due_date;
      }
      cur = cur.depends_on ? byId.get(cur.depends_on) : undefined;
    }
    const open = !isCleared(m.status);
    const overdue = open && !!m.due_date && m.due_date < asOf;
    return {
      ...m, level: depth(m), waitingOn, overdue, daysOverdue: overdue ? days(m.due_date!, asOf) : null,
      blocked: open && (m.status === "blocked" || waitingOn.length > 0), earliestFinish: open ? earliest : null,
    };
  });
  return out.sort((a, b) => a.level - b.level || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** True when making `id` depend on `dependsOn` would create a cycle (or a self-reference). */
export function wouldCycle(items: Pick<MilestoneLite, "id" | "depends_on">[], id: string, dependsOn: string | null): boolean {
  if (!dependsOn) return false;
  if (dependsOn === id) return true;
  const byId = new Map(items.map((m) => [m.id, m]));
  let cur: string | null | undefined = dependsOn;
  const seen = new Set<string>();
  while (cur) {
    if (cur === id || seen.has(cur)) return true;
    seen.add(cur);
    cur = byId.get(cur)?.depends_on ?? null;
  }
  return false;
}

export interface ClosingAlert {
  kind: "overdue" | "blocked";
  milestoneId: string; opportunityId: string | undefined; title: string; message: string;
  /** Stable per milestone + condition (+ due date for overdue) so re-running the job never duplicates alerts or tasks. */
  dedupeKey: string;
  assigneeUserId: string | null;
}

/**
 * Overdue = open item past its due date. Blocked = open item explicitly blocked, or waiting on a prerequisite that is
 * itself overdue (so the dependant will slip) — and whose own due date is within `blockedHorizonDays` or unknown.
 */
export function closingAlerts(items: MilestoneLite[], asOf: string, blockedHorizonDays = 14): ClosingAlert[] {
  const out: ClosingAlert[] = [];
  for (const t of dependencyTimeline(items, asOf)) {
    if (isCleared(t.status)) continue;
    if (t.overdue) out.push({
      kind: "overdue", milestoneId: t.id, opportunityId: t.opportunity_id, title: t.title, assigneeUserId: t.assignee_user_id ?? null,
      message: `"${t.title}" was due ${t.due_date} (${t.daysOverdue} day${t.daysOverdue === 1 ? "" : "s"} overdue)${t.waitingOn.length ? ` — waiting on ${t.waitingOn.map((w) => `"${w.title}"`).join(", ")}` : ""}`,
      dedupeKey: `deals.closing:${t.id}:overdue:${t.due_date}`,
    });
    const prereqOverdue = t.waitingOn.filter((w) => w.due_date && w.due_date < asOf);
    const soon = !t.due_date || days(asOf, t.due_date) <= blockedHorizonDays;
    if (t.status === "blocked" || (prereqOverdue.length > 0 && soon)) out.push({
      kind: "blocked", milestoneId: t.id, opportunityId: t.opportunity_id, title: t.title, assigneeUserId: t.assignee_user_id ?? null,
      message: t.status === "blocked"
        ? `"${t.title}" is marked blocked${t.waitingOn.length ? ` — waiting on ${t.waitingOn.map((w) => `"${w.title}" (${w.status})`).join(", ")}` : ""}`
        : `"${t.title}" is blocked by overdue ${prereqOverdue.map((w) => `"${w.title}" (due ${w.due_date})`).join(", ")}`,
      dedupeKey: `deals.closing:${t.id}:blocked:${t.status === "blocked" ? "manual" : prereqOverdue.map((w) => w.id).sort().join("+")}`,
    });
  }
  return out;
}

export interface OutstandingDoc { source: "checklist" | "document"; id: string; title: string; status: string; due_date: string | null; note: string }

/**
 * Outstanding documents for one deal: checklist items that are documents / legal / approvals / fee prerequisites and
 * not cleared (or done without the required proof), plus generated client documents that are not released or are stale.
 */
export function outstandingDocuments(items: MilestoneLite[], docs: { id: string; purpose: string | null; status: string; family_id?: string | null; version_no?: number | null; input_versions?: Record<string, unknown> | null }[], asOf: string): OutstandingDoc[] {
  const out: OutstandingDoc[] = [];
  const tl = new Map(dependencyTimeline(items, asOf).map((t) => [t.id, t]));
  for (const m of items) {
    if (!["document", "legal", "approval", "fee", "possession"].includes(m.kind)) continue;
    const t = tl.get(m.id)!;
    if (!isCleared(m.status)) out.push({ source: "checklist", id: m.id, title: m.title, status: t.blocked ? "blocked" : m.status, due_date: m.due_date,
      note: [t.overdue ? `overdue ${t.daysOverdue}d` : null, t.waitingOn.length ? `waiting on ${t.waitingOn.map((w) => w.title).join(", ")}` : null, m.proof_required ? "proof required" : null].filter(Boolean).join(" · ") });
    else if (m.status === "done" && m.proof_required && !(m.proof_text ?? "").trim()) out.push({ source: "checklist", id: m.id, title: m.title, status: "proof missing", due_date: m.due_date, note: "marked done without proof" });
  }
  // latest version per document family only
  const latest = new Map<string, (typeof docs)[number]>();
  for (const d of docs) {
    const k = d.family_id ?? d.id;
    const cur = latest.get(k);
    if (!cur || (d.version_no ?? 0) > (cur.version_no ?? 0)) latest.set(k, d);
  }
  for (const d of latest.values()) {
    if (d.status === "released") continue;
    const title = String(d.input_versions?.title ?? d.purpose ?? "document");
    out.push({ source: "document", id: d.id, title: `${title}${d.version_no ? ` (v${d.version_no})` : ""}`, status: d.status, due_date: null,
      note: d.status === "stale" ? (d.input_versions?.released_at ? "was released — inputs changed, re-review before sharing again" : "inputs changed — regenerate") : d.status === "approved" ? "approved, not yet released" : "draft — needs review" });
  }
  return out;
}
