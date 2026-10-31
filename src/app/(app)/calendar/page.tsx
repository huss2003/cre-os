import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt, localDate } from "@/lib/util/time";
import { agenda, checklistFor, conflictAlerts, findConflicts, findTravelConflicts, loadGeos, planRoutes, withPoints } from "@/modules/integrations/calendar";
import { staleness } from "@/modules/integrations/sync";
import { ChecklistPanel, FeedbackForm, InviteDraftForm, PlannedVisitForm, VisitStatusButtons } from "./forms";

const KIND: Record<string, string> = { site_visit: "Site visit", meeting: "Meeting", call: "Call", internal: "Internal" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const days = Math.min(60, Math.max(1, Number(sp.days ?? 14) || 14));
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 86_400_000);
  const to = new Date(now.getTime() + days * 86_400_000);
  const items = withPoints(await agenda(ctx.db, ctx.workspaceId, from, to), await loadGeos(ctx.db, ctx.workspaceId));
  const conflicts = findConflicts(items);
  const travel = findTravelConflicts(items, ctx.timezone);
  const conflictIds = new Set(conflicts.flat());
  const travelIds = new Set(travel.flatMap((t) => [t.a, t.b]));
  const alerts = conflictAlerts(items, ctx.timezone, now);
  const routes = planRoutes(items, ctx.timezone).filter((c) => c.items.length > 1);
  const canEdit = hasRole(ctx, "editor");
  const [{ data: assetRows }, { data: oppRows }] = canEdit ? await Promise.all([
    ctx.db.from("asset").select("id, name, address").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(300),
    ctx.db.from("opportunity").select("id, name").eq("workspace_id", ctx.workspaceId).eq("outcome", "open").is("archived_at", null).order("name").limit(200),
  ]) : [{ data: [] }, { data: [] }];
  const assets = (assetRows ?? []).map((a) => ({ id: a.id as string, label: `${a.name}${a.address ? ` — ${String(a.address).slice(0, 60)}` : ""}` }));
  const { data: accounts } = await ctx.db.from("connector_account").select("id, provider, status").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId);
  const { data: cursors } = await ctx.db.from("connector_cursor").select("resource, last_success_at, last_error").eq("workspace_id", ctx.workspaceId).in("connector_account_id", (accounts ?? []).map((a) => a.id));
  const calStale = (accounts ?? []).length ? staleness(cursors ?? []).find((s) => s.resource === "calendar" && s.stale) : null;
  const broken = (accounts ?? []).filter((a) => ["expired", "revoked", "error"].includes(a.status));
  const byDay = new Map<string, typeof items>();
  for (const i of items) {
    const k = localDate(new Date(i.start_at), ctx.timezone);
    byDay.set(k, [...(byDay.get(k) ?? []), i]);
  }
  const today = localDate(now, ctx.timezone);

  return (
    <div>
      <PageHeader title="Calendar & visits" subtitle="Your connected calendar (read-only) plus visits you plan here: conflicts, provisional routes, visit checklists and feedback. Nothing is sent to anyone." />
      {broken.length ? <StaleBanner>Calendar connection {broken.map((b) => `${b.provider} (${b.status})`).join(", ")} needs attention — the agenda may be out of date. <Link className="underline" href="/settings/connections">Reconnect</Link>.</StaleBanner> : null}
      {calStale && !broken.length ? <StaleBanner>Calendar last synced {calStale.lastSuccessAt ? fmt(calStale.lastSuccessAt, "dd MMM, HH:mm", ctx.timezone) : "never"}. Recent changes may be missing.</StaleBanner> : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          {alerts.length ? (
            <StaleBanner>
              <span className="font-medium">{alerts.length} schedule {alerts.length === 1 ? "conflict" : "conflicts"} ahead</span> (also sent to your in-app alerts):
              <ul className="mt-1 list-disc pl-5">{alerts.slice(0, 6).map((a) => <li key={a.dedupeKey}>{a.detail}</li>)}</ul>
            </StaleBanner>
          ) : null}
          {items.length === 0 ? (
            <EmptyState title="No meetings in this period">
              {(accounts ?? []).length === 0
                ? <>No calendar is connected yet, so this does not mean your calendar is empty. Connect Microsoft 365 or Google in <Link className="text-brand underline" href="/settings/connections">Settings → Connections</Link>, or plan a site visit by hand with “Plan a visit”.</>
                : "Nothing scheduled between these dates. New events appear after the next calendar sync (every 15 minutes), or plan a visit by hand."}
            </EmptyState>
          ) : [...byDay.entries()].map(([day, list]) => (
            <Card key={day} title={`${fmt(`${day}T12:00:00Z`, "EEE dd MMM", "UTC")}${day === today ? " · today" : ""}`}>
              <ul className="divide-y divide-line">
                {list.map((i) => {
                  const started = Date.parse(i.start_at) <= now.getTime();
                  const inPerson = i.kind === "site_visit" || i.kind === "meeting";
                  return (
                    <li key={i.id} className="py-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`font-medium tabular-nums ${i.status === "cancelled" ? "line-through text-ink-soft" : ""}`}>{fmt(i.start_at, "HH:mm", ctx.timezone)}–{fmt(i.end_at, "HH:mm", ctx.timezone)}</span>
                        <Badge>{KIND[i.kind] ?? i.kind}</Badge>
                        {i.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : null}
                        {i.status === "completed" ? <Badge tone="ok">Done</Badge> : null}
                        {i.status === "provisional" ? <Badge tone="accent" title="Planned in CRE OS; not yet confirmed">Provisional</Badge> : null}
                        {i.provider === "manual" ? <Badge>Planned here</Badge> : null}
                        {conflictIds.has(i.id) && i.status !== "cancelled" ? <Badge tone="warn">Conflict</Badge> : null}
                        {travelIds.has(i.id) && i.status !== "cancelled" ? <Badge tone="warn" title="Gap shorter than the estimated travel time">Tight travel</Badge> : null}
                        {i.event?.reschedule_count ? <Badge tone="accent" title={i.event.previous_start_at ? `Previously ${fmt(i.event.previous_start_at, "dd MMM HH:mm", ctx.timezone)}` : undefined}>Rescheduled</Badge> : null}
                        {i.provider === "mock" ? <Badge tone="accent">mock data</Badge> : null}
                      </div>
                      <div className={`mt-1 text-sm break-words ${i.status === "cancelled" ? "text-ink-soft line-through" : ""}`}>{i.title ?? "(no title)"}</div>
                      <div className="text-xs text-ink-soft break-words">
                        {i.location ?? (i.event?.is_online ? "Online" : "No location")}{i.locality ? ` · ${i.locality}` : ""}
                        {i.event?.attendees?.length ? ` · ${i.event.attendees.map((a) => a.name ?? a.address).join(", ")}` : ""}
                      </div>
                      {i.provider === "manual" && canEdit ? <VisitStatusButtons id={i.id} status={i.status} /> : null}
                      {inPerson && i.status !== "cancelled" ? <ChecklistPanel key={`${i.id}:${i.checklist.length}`} id={i.id} canEdit={canEdit} items={checklistFor(i.kind, i.checklist)} /> : null}
                      {inPerson && started && i.status !== "cancelled" && canEdit ? <FeedbackForm id={i.id} initial={i.feedback} /> : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          <Card title="Provisional routes">
            {routes.length === 0 ? <p className="text-sm text-ink-soft">When two or more in-person visits on one day are close to each other (estimated travel ≤ 25 min) they are grouped here with travel estimates. Coordinates come from the linked building or the locality in your Geography list.</p> : (
              <ul className="space-y-3 text-sm">
                {routes.map((c) => (
                  <li key={`${c.day}-${c.items[0].id}`}>
                    <span className="font-medium">{c.label}</span> <span className="text-ink-soft">· {fmt(`${c.day}T12:00:00Z`, "EEE dd MMM", "UTC")}</span>
                    <ol className="mt-1 space-y-1 text-xs">
                      {c.items.map((x, k) => {
                        const leg = c.legs[k - 1];
                        return (
                          <li key={x.id}>
                            {leg ? <div className={leg.feasible ? "text-ink-soft" : "font-medium text-bad"}>↓ ~{leg.travelMinutes} min travel (estimate) · {leg.gapMinutes} min gap{leg.feasible ? "" : " — too tight"}</div> : null}
                            <span className="tabular-nums">{fmt(x.start_at, "HH:mm", ctx.timezone)}</span> {x.title ?? ""}
                          </li>
                        );
                      })}
                    </ol>
                    {c.basis === "locality" ? <p className="text-xs text-ink-soft">Grouped by locality only (no coordinates).</p> : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-soft">Estimates: straight-line distance × 1.4 at ~20 km/h, no live traffic. You confirm the route.</p>
          </Card>
          {canEdit ? <Card title="Plan a visit"><PlannedVisitForm tz={ctx.timezone} assets={assets} opportunities={(oppRows ?? []).map((o) => ({ id: o.id as string, name: o.name as string }))} /></Card> : null}
          {canEdit ? <Card title="Draft an invite"><InviteDraftForm tz={ctx.timezone} /></Card> : null}
        </div>
      </div>
    </div>
  );
}
