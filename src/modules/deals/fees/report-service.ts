/** Revenue controller report (RLS-scoped): fee register by status, forecast, receivables aging, slippage, cohort funnel. */
import { type DealsCtx, dbError } from "../ctx";
import { cohortFunnel, feeLedger, ledgerTotals, receivablesAging, slippageReport, type CloseChange, type FeeRowB, type LedgerLine, type OppLite, type StageHist } from "./ledger";

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>, what: string, cap = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const r = await q(from, from + 999);
    if (r.error) throw dbError(r.error, what);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  return out;
}

export async function revenueReport(ctx: DealsCtx, asOf: string) {
  const ws = ctx.workspaceId;
  const [opps, fees, hist, close] = await Promise.all([
    all<OppLite & { name: string }>((f, t) => ctx.db.from("opportunity").select("id, name, stage, outcome, expected_fee, credit_share, expected_close, crm_external_id, created_at").eq("workspace_id", ws).is("archived_at", null).order("id").range(f, t), "opportunity"),
    all<FeeRowB & { id: string; opportunity_id: string; currency: string | null }>((f, t) => ctx.db.from("fee_milestone").select("*").eq("workspace_id", ws).is("archived_at", null).order("id").range(f, t), "fee_milestone"),
    all<StageHist>((f, t) => ctx.db.from("opportunity_stage_history").select("opportunity_id, to_stage, changed_at").eq("workspace_id", ws).order("id").range(f, t), "stage history"),
    all<CloseChange>((f, t) => ctx.db.from("opportunity_close_history").select("opportunity_id, old_expected_close, new_expected_close, changed_at").eq("workspace_id", ws).order("id").range(f, t), "close history"),
  ]);
  const currencies = new Set(fees.map((f) => f.currency ?? "INR"));
  const byOpp = new Map<string, typeof fees>();
  for (const f of fees) byOpp.set(f.opportunity_id, [...(byOpp.get(f.opportunity_id) ?? []), f]);
  const register: { opp: OppLite & { name: string }; rows: FeeRowB[]; lines: LedgerLine[] }[] = [];
  for (const o of opps) {
    const rows = byOpp.get(o.id) ?? [];
    if (!rows.length && (o.expected_fee === null || o.expected_fee === undefined)) continue;
    register.push({ opp: o, rows, lines: feeLedger(o, rows) });
  }
  const lines = register.flatMap((r) => r.lines);
  const openOpps = opps.filter((o) => (o.outcome ?? "open") === "open" && o.expected_fee !== null && o.expected_fee !== undefined);
  return {
    asOf, mixedCurrency: currencies.size > 1,
    register, totals: currencies.size > 1 ? null : ledgerTotals(lines),
    forecast: openOpps.map((o) => ({ id: o.id, name: o.name, stage: o.stage, expectedFee: String(o.expected_fee), expectedClose: o.expected_close ?? null, status: "forecast" as const })),
    aging: receivablesAging(fees, asOf),
    slippage: slippageReport(opps, close, asOf),
    cohorts: cohortFunnel(opps, hist),
  };
}
