import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { callsAvoidedThisMonth } from "@/modules/admin/ai-policy";
import { PageHeader, Card, Stat, EmptyState, Input, Badge } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { loadUsage } from "@/modules/assistant/usage/service";
import { setBudgetAction } from "@/modules/assistant/usage/actions";
import { DayBars, SliceBars, UsageBanner, money } from "@/modules/assistant/usage/ui";
import { fmtDate } from "@/lib/util/time";
import { PRICING } from "@/lib/ai/pricing";

export const metadata = { title: "AI usage · CRE OS" };

const fmtN = (n: number) => n.toLocaleString("en-IN");

export default async function Page() {
  const ctx = await requirePageContext();
  if (!hasRole(ctx, "admin")) {
    return (<><PageHeader title="AI usage" /><EmptyState title="Only admins can see AI spend">Ask a workspace admin or the owner for the usage report.</EmptyState></>);
  }
  const u = await loadUsage(ctx.db, ctx.workspaceId);
  const avoided = hasRole(ctx, "admin") ? await callsAvoidedThisMonth(ctx.db, ctx.workspaceId) : null;
  const owner = hasRole(ctx, "owner");
  const userLabel = (k: string) => (k === "system" ? "Other AI features / scheduled" : k === ctx.userId ? "You" : `Member ${k.slice(0, 8)}`);
  const empty = u.monthUsd === 0 && u.byDay.every((d) => d.usd === 0);
  return (
    <>
      <PageHeader title="AI usage" subtitle="Estimated AI cost for this workspace (all AI features). Months and days follow India time." />
      <UsageBanner workspaceId={ctx.workspaceId} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Today" value={money(u.todayUsd)} />
        <Stat label="This month" value={money(u.monthUsd)} />
        <Stat label="Projected month-end" value={money(u.projectedUsd)} hint="Straight-line from spend so far" />
        <Stat label="Budget used" value={u.pct == null ? "No cap" : `${u.pct}%`} hint={u.budgetInr > 0 ? `of ₹${fmtN(u.budgetInr)}` : undefined} />
      </div>
      {empty ? <div className="mt-4"><EmptyState title="No AI usage yet">Costs appear here after someone uses Ask AI or another AI feature (captures, briefs, research). In test mode without an API key, calls cost nothing.</EmptyState></div> : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Last 30 days"><DayBars data={u.byDay} label="AI spend per day for the last 30 days" /></Card>
        <Card title="Monthly budget" help="When spend reaches the budget, every AI feature stops until it is raised. Alerts at 80% and 100%.">
          <p className="text-sm">{u.budgetInr > 0 ? <>Cap: <b>₹{fmtN(u.budgetInr)}</b> a month</> : "No cap set."} {u.paused ? <Badge tone="bad">AI paused</Badge> : null}</p>
          {owner ? (
            <ActionForm action={setBudgetAction} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex-1 text-sm">Monthly budget (₹, 0 = no cap)
                <Input name="budget" inputMode="decimal" defaultValue={String(u.budgetInr)} aria-label="Monthly AI budget in rupees" />
              </label>
              <Submit>Save budget</Submit>
            </ActionForm>
          ) : <p className="mt-2 text-xs text-ink-soft">Only the workspace owner can change the budget.</p>}
        </Card>
        <Card title="By question type"><SliceBars items={u.byIntent} /></Card>
        <Card title="By route"><SliceBars items={u.byRoute} labelFor={(k) => (k === "deep" ? "Deep (stronger model)" : k === "fast" ? "Fast" : k)} /></Card>
        <Card title="By person"><SliceBars items={u.byUser} labelFor={userLabel} /></Card>
        <Card title="By feature (workflow)"><SliceBars items={u.byWorkflow} /></Card>
        {avoided !== null ? <Card title="AI calls avoided this month" help="Features set to code only in Settings → AI use. These calls were handled by code and cost nothing."><p className="text-2xl font-semibold">{avoided}</p><a href="/settings/ai" className="text-sm text-brand underline">Change AI use per feature</a></Card> : null}
        <Card title="Tokens this month">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-ink-soft">Input</dt><dd className="tabular-nums">{fmtN(u.tokens.input)}</dd>
            <dt className="text-ink-soft">Output</dt><dd className="tabular-nums">{fmtN(u.tokens.output)}</dd>
            <dt className="text-ink-soft">Read from cache</dt><dd className="tabular-nums">{fmtN(u.tokens.cacheRead)} ({u.tokens.cacheReadShare}% of input)</dd>
            <dt className="text-ink-soft">Written to cache</dt><dd className="tabular-nums">{fmtN(u.tokens.cacheWrite)}</dd>
            <dt className="text-ink-soft">Saved by cache (est.)</dt><dd className="tabular-nums">{money(u.tokens.savedByCacheUsd)}</dd>
          </dl>
        </Card>
        <Card title="Most expensive questions this month">
          {u.topRuns.length ? (
            <ol className="space-y-2 text-sm">
              {u.topRuns.map((r) => (
                <li key={r.runId} className="flex justify-between gap-2">
                  <span className="min-w-0">
                    {r.conversationId ? <Link href={`/assistant/${r.conversationId}`} className="line-clamp-2 text-brand hover:underline">{r.request}</Link> : <span className="line-clamp-2">{r.request}</span>}
                    <span className="block text-xs text-ink-soft">{fmtDate(r.at)}{r.intent ? ` · ${r.intent}` : ""}{r.route ? ` · ${r.route}` : ""}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{money(r.usd)}</span>
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-ink-soft">No assistant questions with a cost yet this month.</p>}
        </Card>
      </div>
      <p className="mt-4 text-xs text-ink-soft">Estimates use published model prices and a planning rate of ₹{PRICING.fxInrPerUsd} per US$; the provider&apos;s invoice is the final figure.</p>
    </>
  );
}
