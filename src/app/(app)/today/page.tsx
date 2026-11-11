import { Suspense } from "react";
import Link from "next/link";
import { requirePageContext, hasRole, type AppContext } from "@/lib/auth/context";
import { Card, StaleBanner } from "@/components/ui";
import { atLocal, fmt } from "@/lib/util/time";
import { buildBrief } from "@/modules/brief/builder";
import { gatherBriefInputs, latestBrief } from "@/modules/brief/brief-service";
import { loadCtxFor, todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";
import { addDays } from "@/modules/brief/dates";
import { computeDailySections } from "@/modules/orchestrator/schedule/daily-plan";
import { loadOrchSettings } from "@/modules/orchestrator/schedule/settings-db";
import { loadCapacity } from "@/modules/orchestrator/capacity/service";
import { buildPlannerView, type PlannerItem, type PlannerSection, type PlannerView } from "@/modules/orchestrator/ui/planner";
import { GettingStarted } from "./getting-started";
import { completePlannerTask } from "./actions-planner";

type SP = Promise<Record<string, string | string[] | undefined>>;
const TASK_LIMIT = 50;

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<div className="p-6 text-sm text-ink-soft">Loading your day…</div>}><Body searchParams={searchParams} /></Suspense>;
}

async function loadView(ctx: AppContext, date: string, today: string): Promise<PlannerView> {
  const tz = ctx.timezone || "Asia/Kolkata";
  const lc = loadCtxFor(ctx);
  const now = new Date();
  const ws = ctx.workspaceId, uid = ctx.userId;

  const { data: plan } = await ctx.db.from("orch_plan").select("sections, ai_status, ai_summary, generated_at")
    .eq("workspace_id", ws).eq("user_id", uid).eq("kind", "daily").eq("period_key", date).maybeSingle();

  let sections = (plan?.sections as Record<string, any> | null) ?? null;
  if (!sections) {
    // No 08:00 plan for this day yet: build the same sections live (nothing is stored, no AI).
    const settings = await loadSettings(ctx.db, ws, uid);
    let brief: any = await latestBrief(ctx.db, ws, uid, date, "daily").catch(() => null);
    let briefError: string | null = null;
    if (!brief) {
      try { brief = { id: "live", content: buildBrief(await gatherBriefInputs(lc, settings, date, now, { persistPlan: false })) }; }
      catch (e) { briefError = e instanceof Error ? e.message : "Brief data unavailable"; }
    }
    sections = await computeDailySections(lc, date, now, brief, briefError) as Record<string, any>;
  }

  const endOfDay = atLocal(addDays(date, 1), "00:00", tz).toISOString();
  const mine = `assigned_user_id.eq.${uid},and(assigned_user_id.is.null,owner_user_id.eq.${uid})`;
  const [tasks, changes, drafts, signalTotal, capacity] = await Promise.all([
    ctx.db.from("task").select("id, title, due_at, row_version").eq("workspace_id", ws).is("archived_at", null).eq("status", "open")
      .or(mine).lt("due_at", endOfDay).order("due_at").limit(TASK_LIMIT + 1),
    ctx.db.from("change_proposal").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null).in("state", ["proposed", "clarify"]).eq("approval_required", true),
    ctx.db.from("draft").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null).eq("state", "drafted").eq("owner_user_id", uid),
    date === today
      ? ctx.db.from("signal").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null)
        .gte("detected_at", new Date(+now - 36 * 3600e3).toISOString()).not("status", "in", "(rejected,dismissed)").neq("confidence", "insufficient").then((r) => r.error ? null : r.count)
      : Promise.resolve(null),
    loadOrchSettings(ctx.db, ws, uid).then((s) => loadCapacity(lc, s, date, now)).catch(() => null),
  ]);

  const ai = plan?.ai_status === "ok" ? (plan.ai_summary as { headline?: string } | null) : null;
  return buildPlannerView({
    date, tz, source: plan ? "plan" : "live", generatedAt: (plan?.generated_at as string | undefined) ?? null,
    sections, headline: ai?.headline ?? null,
    tasks: tasks.error ? null : { items: (tasks.data ?? []).slice(0, TASK_LIMIT) as any[], capped: (tasks.data?.length ?? 0) > TASK_LIMIT },
    approvals: changes.error || drafts.error ? null : { changes: changes.count ?? 0, drafts: drafts.count ?? 0 },
    capacity: capacity as any, signalTotal, signalCap: 10,
    fmtTime: (iso) => fmt(iso, "HH:mm", tz),
  });
}

async function Body({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const today = todayFor(ctx);
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const canEdit = hasRole(ctx, "editor");
  const v = await loadView(ctx, date, today);
  const byKey = Object.fromEntries(v.sections.map((s) => [s.key, s]));
  const dayHref = (d: string) => (d === today ? "/today" : `/today?date=${d}`);
  const label = fmt(atLocal(date, "12:00", tz), "EEEE, d MMMM", tz);
  const rel = date === today ? "Today" : date === addDays(today, 1) ? "Tomorrow" : date === addDays(today, -1) ? "Yesterday" : fmt(atLocal(date, "12:00", tz), "yyyy", tz);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">{rel}</p>
          <h1 className="text-xl font-semibold tracking-tight">{label}</h1>
          {v.summary ? <p className="mt-1 text-sm text-ink-soft">{v.summary}</p> : null}
          {v.headline ? <p className="mt-1 text-sm">{v.headline}</p> : null}
        </div>
        <nav aria-label="Change day" className="flex items-center gap-1">
          <Link href={dayHref(addDays(date, -1))} aria-label="Previous day" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-line bg-surface text-sm hover:bg-canvas sm:min-h-8 sm:min-w-8">‹</Link>
          {date !== today ? <Link href="/today" className="inline-flex min-h-11 items-center rounded-md border border-line bg-surface px-3 text-sm hover:bg-canvas sm:min-h-8">Today</Link> : null}
          <Link href={dayHref(addDays(date, 1))} aria-label="Next day" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-line bg-surface text-sm hover:bg-canvas sm:min-h-8 sm:min-w-8">›</Link>
        </nav>
      </header>

      {typeof sp.ok === "string" ? <div role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">{sp.ok}</div> : null}
      {typeof sp.error === "string" ? <div role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{sp.error}</div> : null}
      {date === today ? <Suspense fallback={null}><GettingStarted ctx={ctx} /></Suspense> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <SectionCard s={v.schedule} />
          <Card title={<>Priority tasks &amp; follow-ups <Count text={v.tasks.countText} /></>} help={null} actions={<Link href="/tasks" className="text-sm text-brand">All tasks</Link>}>
            {v.tasks.unavailable ? <StaleBanner>{v.tasks.unavailable}</StaleBanner> : v.tasks.items.length ? (
              <ul className="-my-1 divide-y divide-line">
                {v.tasks.items.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 py-2">
                    {canEdit ? (
                      <form action={completePlannerTask} className="pt-0.5">
                        <input type="hidden" name="id" value={t.id} /><input type="hidden" name="version" value={t.version} /><input type="hidden" name="date" value={date} />
                        <button type="submit" aria-label={`Mark "${t.title}" done`} title="Mark done" className="flex h-6 w-6 items-center justify-center rounded border border-line bg-surface hover:border-brand hover:bg-brand/10">
                          <span className="sr-only">Done</span>
                        </button>
                      </form>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <Link href={t.href} className="block break-words text-sm font-medium hover:underline">{t.title}</Link>
                      <p className={`text-xs ${t.overdue ? "text-bad" : "text-ink-soft"}`}>{t.due ? (t.overdue ? `Overdue · was due ${fmt(t.due, "d MMM", tz)}` : `Due ${fmt(t.due, "HH:mm", tz) === "00:00" ? "today" : fmt(t.due, "HH:mm", tz)}`) : "No due date"}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-soft">No tasks due. Add one from a company, deal or the Tasks page.</p>}
          </Card>
          <SectionCard s={byKey.overdue} />
          <SectionCard s={byKey.prep} />
          <SectionCard s={byKey.next} numbered />
        </div>
        <div className="min-w-0 space-y-4">
          <Card title="Capacity" help={null}>
            {v.capacity ? (
              <div className="space-y-2 text-sm">
                <p>{v.capacity.line}</p>
                {v.capacity.warnings.length ? (
                  <ul className="space-y-1">{v.capacity.warnings.slice(0, 4).map((w, i) => <li key={i} className="rounded-md border border-warn/30 bg-warn/5 px-2 py-1 text-xs">{w}</li>)}{v.capacity.warnings.length > 4 ? <li className="text-xs text-ink-soft">+{v.capacity.warnings.length - 4} more clashes — see <Link href="/automation?view=daily" className="text-brand hover:underline">capacity details</Link></li> : null}</ul>
                ) : <p className="text-xs text-ink-soft">No clashes — the day fits.</p>}
              </div>
            ) : <p className="text-sm text-ink-soft">Free time could not be worked out for this day.</p>}
          </Card>
          <SectionCard s={byKey.approvals} />
          <SectionCard s={byKey.signals} />
          <SectionCard s={byKey.leases} />
          <SectionCard s={byKey.deals} />
          <SectionCard s={byKey.accounts} />
        </div>
      </div>

      <p className="text-xs text-ink-soft">
        {v.source === "plan" && v.generatedAt ? `Plan prepared at ${fmt(v.generatedAt, "HH:mm", tz)}.` : "Showing live data — the daily plan is prepared each morning."}{" "}
        <Link href="/today/details" className="text-brand hover:underline">Full brief details</Link>
      </p>
    </div>
  );
}

function Count({ text }: { text: string }) {
  return <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs font-medium tabular-nums text-ink-soft">{text}</span>;
}

const DOT: Record<NonNullable<PlannerItem["tone"]>, string> = { bad: "bg-bad", warn: "bg-warn", ok: "bg-ok", neutral: "bg-line" };

function SectionCard({ s, numbered }: { s: PlannerSection; numbered?: boolean }) {
  return (
    <Card title={<>{s.title} <Count text={s.countText} /></>} help={null} actions={s.link ? <Link href={s.link.href} className="text-sm text-brand">{s.link.label}</Link> : null}>
      {s.unavailable ? <StaleBanner>{s.unavailable}</StaleBanner> : s.items.length ? (
        <ul className="-my-1 divide-y divide-line">
          {s.items.map((it, i) => (
            <li key={it.key}>
              <Link href={it.href} className="flex items-start gap-3 py-2 hover:bg-canvas/60">
                {numbered ? <span className="w-4 shrink-0 text-sm font-semibold text-brand">{i + 1}</span>
                  : <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[it.tone ?? "neutral"]}`} />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium">{it.title}</span>
                  {it.meta ? <span className="block break-words text-xs text-ink-soft">{it.meta}</span> : null}
                </span>
              </Link>
            </li>
          ))}
          {s.count > s.items.length && s.link ? <li className="pt-2 text-xs"><Link href={s.link.href} className="text-brand hover:underline">+{s.count - s.items.length} more</Link></li> : null}
        </ul>
      ) : <p className="text-sm text-ink-soft">{s.empty}</p>}
    </Card>
  );
}

