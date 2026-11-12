/**
 * Deterministic plan headlines (AI policy "off" path for orchestrator.daily_plan / orchestrator.weekly_review).
 * Sentence templates over section counts and the top items; never invents numbers, people or dates (S5/S6).
 * Sections reported "unavailable" are named so a failed source is never read as "nothing happened" (S10).
 */
type Sec = { state?: string; items?: unknown[] } | undefined;
const n = (s: Sec) => (s && s.state !== "unavailable" ? (s.items ?? []).length : 0);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const titleOf = (x: unknown) => String((x as { title?: string; name?: string })?.title ?? (x as { name?: string })?.name ?? "").trim();

function sentence(parts: string[]): string {
  if (!parts.length) return "";
  const body = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return body.charAt(0).toUpperCase() + body.slice(1) + ".";
}

function unavailable(sections: Record<string, Sec>, labels: Record<string, string>): string {
  const bad = Object.entries(sections).filter(([, s]) => s?.state === "unavailable").map(([k]) => labels[k] ?? k.replace(/_/g, " "));
  return bad.length ? ` Not checked: ${bad.join(", ")}.` : "";
}

export interface PlanHeadline { headline: string; focus: string[] }

export function dailyHeadline(sections: Record<string, Sec>, recommended: { title: string }[]): PlanHeadline {
  const parts: string[] = [];
  const meetings = n(sections.todays_meetings);
  const prep = n(sections.meetings_needing_prep);
  if (meetings) parts.push(`${plural(meetings, "meeting")} today${prep ? ` (${prep} need${prep === 1 ? "s" : ""} prep)` : ""}`);
  else if (prep) parts.push(`${plural(prep, "upcoming meeting")} need${prep === 1 ? "s" : ""} prep`);
  const overdue = n(sections.overdue_commitments);
  if (overdue) parts.push(`${plural(overdue, "overdue commitment")}`);
  const follow = n(sections.followups_due_today);
  if (follow) parts.push(`${plural(follow, "follow-up")} due`);
  const leases = n(sections.lease_alerts);
  if (leases) parts.push(`${plural(leases, "lease alert")}`);
  const deals = n(sections.deals_attention);
  if (deals) parts.push(`${plural(deals, "deal")} needing attention`);
  let headline = sentence(parts);
  if (recommended[0]) headline = (headline ? headline + " " : "") + `Start with: ${recommended[0].title}.`;
  if (!headline) headline = "No urgent items today — work the priority list.";
  headline += unavailable(sections, { todays_meetings: "calendar", tasks: "tasks", deals_attention: "deals", new_signals: "signals" });
  return { headline: headline.slice(0, 400), focus: recommended.slice(0, 3).map((r) => r.title) };
}

const WEEK_LABELS: Record<string, string> = {
  new_opportunities: "new opportunities", priority_account_changes: "score changes", important_signals: "signals", meetings_completed: "meetings",
  meetings_scheduled: "next week's meetings", followups_completed: "follow-ups", overdue_commitments: "commitments", requirements_changed: "requirements",
  active_deals: "deals", stalled_transactions: "stalled deals", proposals_pending: "proposals", market_developments: "market data",
};

export function weeklySummary(sections: Record<string, Sec>): PlanHeadline {
  const done: string[] = [];
  const meetings = n(sections.meetings_completed); if (meetings) done.push(`${plural(meetings, "meeting")} held`);
  const fu = n(sections.followups_completed); if (fu) done.push(`${plural(fu, "follow-up")} completed`);
  const opps = n(sections.new_opportunities); if (opps) done.push(`${plural(opps, "new opportunity", "new opportunities")}`);
  const reqs = n(sections.requirements_changed); if (reqs) done.push(`${plural(reqs, "requirement")} added or changed`);
  const watch: string[] = [];
  const stalled = n(sections.stalled_transactions); if (stalled) watch.push(`${plural(stalled, "deal")} stalled 30+ days`);
  const overdue = n(sections.overdue_commitments); if (overdue) watch.push(`${plural(overdue, "overdue commitment")}`);
  const props = n(sections.proposals_pending); if (props) watch.push(`${plural(props, "proposal")} pending`);
  const next = n(sections.meetings_scheduled);
  let headline = done.length ? `This week: ${sentence(done).replace(/^./, (c) => c.toLowerCase())}` : "Quiet week — no meetings, follow-ups or new opportunities recorded.";
  if (watch.length) headline += ` Watch: ${sentence(watch).replace(/^./, (c) => c.toLowerCase())}`;
  if (next) headline += ` ${plural(next, "meeting")} booked for next week.`;
  headline += unavailable(sections, WEEK_LABELS);
  const recs = (sections.recommended_next_week?.items ?? []).map(titleOf).filter(Boolean);
  return { headline: headline.slice(0, 500), focus: recs.slice(0, 3) };
}
