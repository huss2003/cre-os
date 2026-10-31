import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Badge, EmptyState, Button, Input, ButtonLink } from "@/components/ui";
import { contentCalendar } from "@/modules/intelligence/content/service";
import { weekStartOf } from "@/modules/intelligence/content/editor";
import { addDays, isoDate } from "@/modules/intelligence/common";
import { Flash, Disclaimer, fmtDay, label } from "@/modules/intelligence/ui";
import { dateAction } from "../actions";

const TONE: Record<string, "ok" | "warn" | "neutral" | "brand"> = { approved: "ok", published_manually: "brand", in_review: "warn", drafted: "warn" };

/** Publishing calendar (agenda by week — readable at 375px). Approved = ready; you post it yourself. */
export default async function ContentCalendarPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; from?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? weekStartOf(sp.from) : weekStartOf(isoDate(new Date())!);
  const to = addDays(from, 41);
  const { planned, unscheduled } = await contentCalendar(ctx.db, ctx.workspaceId, from, to);
  const weeks = Array.from({ length: 6 }, (_, i) => addDays(from, i * 7));

  return (
    <div>
      <PageHeader title="Publishing calendar" subtitle={<><Link className="text-brand" href="/content">Content</Link> · {fmtDay(from)} – {fmtDay(to)}</>} actions={<>
        <ButtonLink variant="secondary" href={`/content/calendar?from=${addDays(from, -42)}`}>← Earlier</ButtonLink>
        <ButtonLink variant="secondary" href={`/content/calendar?from=${addDays(from, 42)}`}>Later →</ButtonLink>
      </>} />
      <Disclaimer>Planned dates are a schedule, not automation: CRE OS never publishes. Only approved posts show as ready.</Disclaimer>
      <Flash sp={sp} />
      {planned.length === 0 && unscheduled.length === 0 ? <Card><EmptyState title="Nothing scheduled">Plan the week on the <Link className="text-brand" href="/content">Content</Link> page — ideas get planned dates automatically.</EmptyState></Card> : null}
      <div className="space-y-4">
        {weeks.map((w) => {
          const days = Array.from({ length: 7 }, (_, i) => addDays(w, i));
          const inWeek = planned.filter((p) => String(p.planned_publish_on) >= w && String(p.planned_publish_on) <= days[6]);
          return (
            <Card key={w} title={`Week of ${fmtDay(w)}`}>
              {inWeek.length === 0 ? <p className="text-sm text-ink-soft">No posts planned.</p> : (
                <ul className="divide-y divide-line">
                  {days.map((d) => inWeek.filter((p) => String(p.planned_publish_on) === d).map((p) => (
                    <li key={String(p.id)} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0"><span className="mr-2 text-xs text-ink-soft">{new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })}</span>
                        <span className="font-medium">{String(p.topic)}</span> <Badge>{label(String(p.channel))}</Badge> <Badge tone={TONE[String(p.status)] ?? "neutral"}>{p.status === "approved" ? "ready" : label(String(p.status))}</Badge>
                        {p.market_note_id ? <> <Badge tone="brand">market note</Badge></> : null}
                        {p.published_url ? <> <a className="text-xs text-brand" href={String(p.published_url)} target="_blank" rel="noopener noreferrer">published</a></> : null}</div>
                      {canEdit && p.status !== "published_manually" && (
                        <form action={dateAction} className="flex items-center gap-1"><input type="hidden" name="id" value={String(p.id)} /><input type="hidden" name="back" value="calendar" />
                          <Input name="planned" type="date" defaultValue={d} className="w-40" /><Button variant="ghost" type="submit">Move</Button></form>
                      )}
                    </li>
                  )))}
                </ul>
              )}
            </Card>
          );
        })}
        {unscheduled.length > 0 && (
          <Card title={`Unscheduled (${unscheduled.length})`}>
            <ul className="divide-y divide-line">{unscheduled.map((p) => (
              <li key={String(p.id)} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span><span className="font-medium">{String(p.topic)}</span> <Badge tone={TONE[String(p.status)] ?? "neutral"}>{p.status === "approved" ? "ready" : label(String(p.status))}</Badge></span>
                {canEdit && <form action={dateAction} className="flex items-center gap-1"><input type="hidden" name="id" value={String(p.id)} /><input type="hidden" name="back" value="calendar" /><Input name="planned" type="date" required className="w-40" /><Button variant="ghost" type="submit">Schedule</Button></form>}
              </li>
            ))}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}
