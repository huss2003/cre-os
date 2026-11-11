/**
 * Pure view model for the /today daily planner. Takes the stored 08:00 plan (mudar.orch_plan.sections) or, when no
 * plan has been generated yet, the same sections computed live — plus live tasks (with row_version so they can be
 * completed), exact approval counts and capacity. No AI wording; counts are never silently capped.
 */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "100+" when a list was cut off at its query limit, otherwise the exact number. */
export function countLabel(n: number, capped = false): string {
  return capped ? `${n}+` : String(n);
}

export interface PlannerItem { key: string; title: string; href: string; meta?: string | null; tone?: "bad" | "warn" | "ok" | "neutral" }
export interface PlannerTask { id: string; title: string; due: string | null; version: number; overdue: boolean; href: string }
export interface PlannerSection { key: string; title: string; count: number; countText: string; items: PlannerItem[]; empty: string; unavailable: string | null; link?: { href: string; label: string } }

export interface PlannerInput {
  date: string; tz: string;
  source: "plan" | "live";
  generatedAt: string | null;
  sections: Record<string, { state: "ok" | "unavailable"; items: any[]; note: string | null }> | null;
  headline: string | null;
  tasks: { items: { id: string; title: string; due_at: string | null; row_version: number }[]; capped: boolean } | null;
  approvals: { changes: number; drafts: number } | null;
  capacity: { freeMinutes: number; meetingMinutes: number; workingMinutes: number; warnings: { message: string; severity: string }[]; conflicts: { message: string }[] } | null;
  /** exact live count of new signals (the stored section keeps only the top 10) */
  signalTotal?: number | null;
  signalCap?: number;
  fmtTime: (iso: string) => string;
}

export interface PlannerView {
  date: string; source: "plan" | "live"; generatedAt: string | null;
  summary: string;               // "1 meeting · 8 follow-ups due · 20 new signals · …"
  headline: string | null;       // one short line max
  schedule: PlannerSection;
  tasks: { items: PlannerTask[]; countText: string; unavailable: string | null };
  sections: PlannerSection[];
  capacity: { line: string; warnings: string[] } | null;
}

const sec = (input: PlannerInput, k: string) => input.sections?.[k] ?? null;

function mk(key: string, title: string, s: { state: string; items: any[]; note: string | null } | null, map: (x: any, i: number) => PlannerItem, empty: string, opts: { cap?: number; link?: PlannerSection["link"]; capped?: boolean } = {}): PlannerSection {
  const items = s?.state === "ok" ? s.items : [];
  const capped = opts.capped ?? false;
  return {
    key, title, count: items.length, countText: countLabel(items.length, capped),
    items: items.slice(0, opts.cap ?? 6).map(map), empty,
    unavailable: !s ? null : s.state === "unavailable" ? (s.note ?? "Could not be loaded") : null,
    link: opts.link,
  };
}

function hm(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

export function buildPlannerView(i: PlannerInput): PlannerView {
  const t = i.fmtTime;
  const meetings = sec(i, "todays_meetings");
  const schedule = mk("schedule", "Today's schedule", meetings ? { ...meetings, items: [...meetings.items].sort((a, b) => String(a.start).localeCompare(String(b.start))) } : null,
    (m) => ({ key: `m:${m.id}`, title: m.title ?? "Untitled meeting", href: m.href, meta: `${t(m.start)}–${t(m.end)}${m.location ? ` · ${m.location}` : ""} · ${m.prep}`, tone: m.prep === "Brief ready" ? "ok" : "warn" }),
    "No meetings today.", { cap: 50 });

  const taskItems: PlannerTask[] = (i.tasks?.items ?? []).map((x) => ({
    id: x.id, title: x.title, due: x.due_at, version: x.row_version,
    overdue: !!x.due_at && x.due_at.slice(0, 10) < i.date, href: `/tasks?q=${encodeURIComponent(x.title.slice(0, 40))}`,
  }));
  const dueToday = taskItems.filter((x) => !x.overdue).length;

  const signals = sec(i, "new_signals");
  const listed = signals?.state === "ok" ? signals.items.length : 0;
  const signalCount = i.signalTotal ?? listed;
  const signalsCapped = i.signalTotal == null && i.signalCap != null && listed >= i.signalCap;
  const approvalsTotal = i.approvals ? i.approvals.changes + i.approvals.drafts : null;
  const lease = sec(i, "lease_alerts");

  const sections: PlannerSection[] = [
    mk("overdue", "Overdue commitments", sec(i, "overdue_commitments"), (c) => ({ key: `c:${c.id}`, title: c.title, href: c.href, meta: `Due ${c.due}`, tone: "bad" }), "Nothing overdue."),
    mk("prep", "Meetings needing prep", sec(i, "meetings_needing_prep"), (m) => ({ key: `p:${m.id}`, title: m.title ?? "Untitled meeting", href: m.href, meta: `${t(m.start)} · ${(m.missing ?? []).slice(0, 2).join("; ") || "No current brief"}`, tone: "warn" }), "All upcoming meetings are prepared."),
    mk("accounts", "Priority accounts", sec(i, "priority_accounts"), (a) => ({ key: `a:${a.orgId}`, title: a.name, href: a.href, meta: a.why ? `Score ${a.score} · ${a.why}` : `Score ${a.score}` }), "No priority accounts yet — import companies or leases to score them.", { link: { href: "/companies", label: "Companies" } }),
    { ...mk("signals", "New signals", signals, (s) => ({ key: `s:${s.id}`, title: s.title, href: s.href, meta: `${s.confidence} confidence · ${s.verification}` }), "No new signals since yesterday.", { cap: 3, capped: signalsCapped, link: { href: "/signals", label: "All signals" } }), count: signalCount, countText: countLabel(signalCount, signalsCapped) },
    mk("leases", "Lease alerts", lease, (l) => ({ key: `l:${l.leaseId}:${l.kind}`, title: `${l.tenant} — ${l.kind}`, href: l.href, meta: `${l.date} · ${plural(l.days, "day")} away`, tone: l.days <= 30 ? "bad" : "warn" }), "No lease dates in the next 90 days.", { link: { href: "/leases", label: "Leases" } }),
    mk("deals", "Deals needing attention", sec(i, "deals_attention"), (d) => ({ key: `d:${d.id}`, title: d.name, href: d.href, meta: `${d.stage} · ${d.reason}` }), "All open deals are on track.", { link: { href: "/deals", label: "Deals" } }),
    {
      key: "approvals", title: "Pending approvals", count: approvalsTotal ?? 0, countText: String(approvalsTotal ?? 0),
      items: i.approvals && approvalsTotal ? [{ key: "approvals", title: [i.approvals.changes ? plural(i.approvals.changes, "record change") : null, i.approvals.drafts ? plural(i.approvals.drafts, "draft") : null].filter(Boolean).join(" and ") + " to review", href: "/approvals" }] : [],
      empty: "Nothing waiting for review.", unavailable: i.approvals ? null : "Approvals could not be loaded", link: { href: "/approvals", label: "Review" },
    },
    mk("next", "Recommended next actions", sec(i, "recommended_actions"), (r) => ({ key: r.ref, title: r.title, href: r.href, meta: r.why }), "Nothing pressing — a good day to call priority accounts.", { cap: 7 }),
  ];

  const parts = [
    meetings?.state === "ok" ? plural(meetings.items.length, "meeting") : null,
    i.tasks ? `${plural(dueToday, "follow-up")} due` : null,
    signals?.state === "ok" ? `${countLabel(signalCount, signalsCapped)} new ${signalCount === 1 && !signalsCapped ? "signal" : "signals"}` : null,
    lease?.state === "ok" ? plural(lease.items.length, "lease alert") : null,
    approvalsTotal != null ? plural(approvalsTotal, "approval") : null,
  ].filter(Boolean) as string[];

  const cap = i.capacity;
  return {
    date: i.date, source: i.source, generatedAt: i.generatedAt,
    summary: parts.join(" · "),
    headline: i.headline ? i.headline.split(/(?<=[.!?])\s/)[0].slice(0, 160) : null,
    schedule,
    tasks: { items: taskItems, countText: countLabel(taskItems.length, i.tasks?.capped ?? false), unavailable: i.tasks ? null : "Tasks could not be loaded" },
    sections,
    capacity: cap ? {
      line: `${hm(cap.freeMinutes)} free · ${hm(cap.meetingMinutes)} in meetings · ${hm(cap.workingMinutes)} working day`,
      warnings: [...cap.conflicts.map((c) => c.message), ...cap.warnings.map((w) => w.message)],
    } : null,
  };
}
