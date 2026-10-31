import Link from "next/link";
import { Badge, Button, ButtonLink, Card, EmptyState, PageHeader, StaleBanner, Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { compareStoredScenarios, listScenarios } from "@/modules/deals/finance/service";
import { Flash } from "@/modules/deals/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

/**
 * Scenario comparison (workflow 11): equal horizon, base date, discount rate and currency or nothing. First selected
 * scenario is the baseline. Incomplete scenarios (unknown costs) are flagged on every row; drivers come from the
 * deterministic sensitivities.
 */
export default async function ComparePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const ids = (Array.isArray(sp.ids) ? sp.ids : typeof sp.ids === "string" ? sp.ids.split(",") : []).filter(Boolean);
  const requirementId = typeof sp.requirement === "string" ? sp.requirement : undefined;
  const all = (await listScenarios(ctx, { requirementId })) as Record<string, unknown>[];
  const c = ids.length ? await compareStoredScenarios(ctx, ids) : null;
  return (
    <div className="space-y-5">
      <PageHeader title="Compare scenarios" subtitle="Same horizon, base date, discount rate and currency — otherwise the comparison is refused. First selected = baseline."
        actions={<ButtonLink variant="secondary" href={`/finance${requirementId ? `?requirement=${requirementId}` : ""}`}>All scenarios</ButtonLink>} />
      <Flash sp={sp} />
      {all.length === 0 ? (
        <EmptyState title="No scenarios to compare">Create at least two scenarios on the same horizon and discount rate under Financials, then select them here.</EmptyState>
      ) : (
        <Card title="Choose scenarios">
          <form method="get" className="space-y-2">
            {requirementId && <input type="hidden" name="requirement" value={requirementId} />}
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {all.map((s) => {
                const rj = (s.result_json ?? {}) as { horizonMonths?: number; baseDate?: string; gaps?: unknown[] };
                return (
                  <li key={s.id as string}>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="ids" value={s.id as string} defaultChecked={ids.includes(s.id as string)} className="mt-1" />
                      <span>{s.name as string} <span className="text-xs text-ink-soft">v{String(s.version ?? 1)} · {rj.horizonMonths ?? "?"} mo from {rj.baseDate ?? "?"}{rj.gaps?.length ? ` · ${rj.gaps.length} unknown cost(s)` : ""}</span></span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <Button type="submit" variant="secondary">Compare</Button>
          </form>
        </Card>
      )}
      {c?.error && <StaleBanner>Not comparable: {c.error}. Recalculate the scenarios on a common horizon, base date and discount rate.</StaleBanner>}
      {c && ids.length === 1 && !c.error && <p className="text-sm text-ink-soft">Select at least one more scenario to compare against the baseline.</p>}
      {c?.comparison && (
        <>
          {c.comparison.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-warn">{c.comparison.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <Card title={`Comparison — baseline: ${c.comparison.baseline}`}>
            <Table head={["Rank", "Scenario", "NPV", "Nominal TCO", "Equiv. monthly", "₹/chg SF/mo", "₹/seat/mo", "Δ NPV vs baseline", "Break-even period", "Costs", "Assumptions", "Approved"]}>
              {c.comparison.rows.map((row, i) => {
                const meta = c.scenarios[i];
                return (
                  <tr key={meta.id}>
                    <Td>{row.rank}</Td>
                    <Td><Link className="font-medium text-brand" href={`/finance/${meta.id}`}>{row.name}</Link> <span className="text-xs text-ink-soft">{row.kind}</span></Td>
                    <Td>{inr(row.npv)}</Td><Td>{inr(row.nominalTco)}</Td><Td>{inr(row.equivalentMonthly)}</Td>
                    <Td>{row.perChargeableSfMonth ? inr(row.perChargeableSfMonth) : "—"}</Td><Td>{row.perPlannedSeatMonth ? inr(row.perPlannedSeatMonth) : "—"}</Td>
                    <Td>{i === 0 ? "baseline" : inr(row.incrementalNpvVsBaseline)}</Td>
                    <Td>{i === 0 ? "—" : row.breakEvenPeriodVsBaseline ?? "never in horizon"}</Td>
                    <Td>{row.complete ? <Badge tone="ok">complete</Badge> : <Badge tone="warn" title={row.gaps.join(", ")}>incomplete: {row.gaps.join(", ")}</Badge>}</Td>
                    <Td>{meta.assumptionsPending ? <Badge tone="warn">{meta.assumptionsPending} pending</Badge> : <Badge tone="ok">approved</Badge>}</Td>
                    <Td>{meta.approved ? <Badge tone="ok">yes</Badge> : <Badge>no</Badge>}</Td>
                  </tr>
                );
              })}
            </Table>
            <p className="mt-2 text-xs text-ink-soft">Lower NPV = lower cost of occupancy. An incomplete scenario’s NPV covers known items only and may understate its true cost.</p>
          </Card>
          <Card title="What drives each result (largest NPV sensitivities)">
            <div className="grid gap-3 sm:grid-cols-2">
              {c.drivers.map((d) => (
                <div key={d.id} className="text-sm">
                  <div className="font-medium">{d.name}</div>
                  {d.top.length ? <ul className="list-disc pl-5 text-ink-soft">{d.top.map((t) => <li key={t.label}>{t.label}: {inr(t.npvChange)}</li>)}</ul> : <p className="text-ink-soft">—</p>}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
