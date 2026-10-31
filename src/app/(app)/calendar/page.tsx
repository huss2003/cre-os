import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt, localDate } from "@/lib/util/time";
import { agenda, clusterByLocality, findConflicts } from "@/modules/integrations/calendar";
import { staleness } from "@/modules/integrations/sync";
import { FeedbackForm, InviteDraftForm } from "./forms";

const KIND: Record<string, string> = { site_visit: "Site visit", meeting: "Meeting", call: "Call", internal: "Internal" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const days = Math.min(60, Math.max(1, Number(sp.days ?? 14) || 14));
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 86_400_000);
  const to = new Date(now.getTime() + days * 86_400_000);
  const items = await agenda(ctx.db, ctx.workspaceId, from, to);
  const conflicts = findConflicts(items);
  const conflictIds = new Set(conflicts.flat());
  const clusters = clusterByLocality(items, ctx.timezone).filter((c) => c.items.length > 1);
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
      <PageHeader title="Calendar & visits" subtitle="Read-only view of your connected calendar: conflicts, visits grouped by locality, and visit feedback." />
      {broken.length ? <StaleBanner>Calendar connection {broken.map((b) => `${b.provider} (${b.status})`).join(", ")} needs attention — the agenda may be out of date. <Link className="underline" href="/settings/connections">Reconnect</Link>.</StaleBanner> : null}
      {calStale && !broken.length ? <StaleBanner>Calendar last synced {calStale.lastSuccessAt ? fmt(calStale.lastSuccessAt, "dd MMM, HH:mm", ctx.timezone) : "never"}. Recent changes may be missing.</StaleBanner> : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          {conflicts.length ? <StaleBanner>{conflicts.length} overlapping {conflicts.length === 1 ? "pair" : "pairs"} of meetings — marked below.</StaleBanner> : null}
          {items.length === 0 ? (
            <EmptyState title="No meetings in this period">
              {(accounts ?? []).length === 0
                ? <>No calendar is connected yet, so this does not mean your calendar is empty. Connect Microsoft 365 or Google in <Link className="text-brand underline" href="/settings/connections">Settings → Connections</Link>.</>
                : "Nothing scheduled between these dates. New events appear after the next calendar sync (every 15 minutes)."}
            </EmptyState>
          ) : [...byDay.entries()].map(([day, list]) => (
            <Card key={day} title={`${fmt(`${day}T12:00:00Z`, "EEE dd MMM", "UTC")}${day === today ? " · today" : ""}`}>
              <ul className="divide-y divide-line">
                {list.map((i) => {
                  const past = Date.parse(i.end_at) < now.getTime();
                  return (
                    <li key={i.id} className="py-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`font-medium tabular-nums ${i.status === "cancelled" ? "line-through text-ink-soft" : ""}`}>{fmt(i.start_at, "HH:mm", ctx.timezone)}–{fmt(i.end_at, "HH:mm", ctx.timezone)}</span>
                        <Badge>{KIND[i.kind] ?? i.kind}</Badge>
                        {i.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : null}
                        {i.status === "completed" ? <Badge tone="ok">Done</Badge> : null}
                        {conflictIds.has(i.id) && i.status !== "cancelled" ? <Badge tone="warn">Conflict</Badge> : null}
                        {i.event?.reschedule_count ? <Badge tone="accent" title={i.event.previous_start_at ? `Previously ${fmt(i.event.previous_start_at, "dd MMM HH:mm", ctx.timezone)}` : undefined}>Rescheduled</Badge> : null}
                        {i.provider === "mock" ? <Badge tone="accent">mock data</Badge> : null}
                      </div>
                      <div className={`mt-1 text-sm break-words ${i.status === "cancelled" ? "text-ink-soft line-through" : ""}`}>{i.title ?? "(no title)"}</div>
                      <div className="text-xs text-ink-soft break-words">
                        {i.location ?? (i.event?.is_online ? "Online" : "No location")}{i.locality ? ` · ${i.locality}` : ""}
                        {i.event?.attendees?.length ? ` · ${i.event.attendees.map((a) => a.name ?? a.address).join(", ")}` : ""}
                      </div>
                      {i.kind === "site_visit" || i.kind === "meeting" ? (past && i.status !== "cancelled" && hasRole(ctx, "editor") ? <FeedbackForm id={i.id} initial={i.feedback} /> : null) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          <Card title="Visits by locality">
            {clusters.length === 0 ? <p className="text-sm text-ink-soft">When two or more in-person visits fall in the same locality on one day they are grouped here to help plan the route. Locality is matched against your Geography list; travel times are not calculated.</p> : (
              <ul className="space-y-2 text-sm">
                {clusters.map((c) => (
                  <li key={`${c.day}-${c.locality}`}><span className="font-medium">{c.locality}</span> <span className="text-ink-soft">· {fmt(`${c.day}T12:00:00Z`, "EEE dd MMM", "UTC")}</span>
                    <div className="text-xs text-ink-soft">{c.items.map((x) => `${fmt(x.start_at, "HH:mm", ctx.timezone)} ${x.title ?? ""}`).join(" → ")}</div></li>
                ))}
              </ul>
            )}
          </Card>
          {hasRole(ctx, "editor") ? <Card title="Draft an invite"><InviteDraftForm tz={ctx.timezone} /></Card> : null}
        </div>
      </div>
    </div>
  );
}
