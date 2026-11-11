import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis, getVersion } from "@/modules/toolkit/store";
import type { InvestmentResult } from "@/modules/toolkit/calc/investment";
import { Legend, MissingNote, Readout, ToolHeader } from "@/modules/toolkit/ui/kit";
import { HowCalc, NoteList, Panel } from "@/modules/toolkit/ui/options/parts";
import { DataTable, InvestmentForm, OldVersionBanner, Versions } from "@/modules/toolkit/ui/models";
import { DeckPanel } from "@/modules/toolkit/ui/deck-button";
import { rs } from "../../fitout/results";
import { ReassessBanner } from "@/modules/orchestrator/ui/components";

const pc = (x: string | null | undefined) => (x == null ? "unknown" : `${Number(x).toFixed(2)}%`);
export default async function InvestmentView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const ctx = await requirePageContext();
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as Record<string, any> | null;
  if (!a || a.kind !== "investment") notFound();
  const vNum = sp.v ? Number(sp.v) : null;
  const ver = vNum && vNum !== a.current_version ? await getVersion(ctx.db, ctx.workspaceId, id, vNum) : null;
  const src = ver ?? a; const r = src.outputs as InvestmentResult;
  const reqs = (await ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(200)).data ?? [];
  const lev = r.levered;
  return (
    <div className="space-y-6">
      <ReassessBanner ctx={ctx} entityType="deal_analysis" entityId={a.id} />
      <ToolHeader eyebrow={`Investment · version ${ver ? ver.version : a.current_version} · formula ${src.formula_version}`} title={a.title}
        purpose="Returns first, then the year-by-year cash flows and sensitivities. Edit below to save a new version." back={{ href: "/toolkit/investment", label: "All investment analyses" }}
        steps={["Enter price, tenancies and exit", "Calculate", "Read the returns"]} current={2} action={<DeckPanel db={ctx.db} ws={ctx.workspaceId} analysisId={id} version={ver?.version ?? null} />} />
      {ver ? <OldVersionBanner base="/toolkit/investment" id={id} version={ver.version} /> : null}
      <MissingNote items={r.missing} />
      {r.nulls.all ? <NoteList title="Why results are unknown" items={[r.nulls.all]} tone="warn" /> : null}
      <Legend />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Readout label="Unlevered IRR" value={pc(r.unlevered.irrPct)} unknown={r.unlevered.irrPct === null} emphasis sub={r.nulls.unleveredIrr} />
        <Readout label="NPV (unlevered)" value={rs(r.unlevered.npv)} unknown={r.unlevered.npv === null} />
        <Readout label="Yield on cost" value={pc(r.yieldOnCostPct)} unknown={r.yieldOnCostPct === null} sub={r.goingInCapPct ? `Going-in cap ${pc(r.goingInCapPct)}` : undefined} />
        <Readout label="Exit value (net)" value={rs(r.exit.net)} unknown={r.exit.net === null} sub={r.exit.value ? <>gross {rs(r.exit.value)}</> : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Readout label="Acquisition cost" value={rs(r.acquisition.total)} unknown={r.acquisition.total === null} />
        <Readout label="Equity multiple" value={`${r.unlevered.equityMultiple}×`} unknown={r.unlevered.equityMultiple === null} />
        {lev ? <Readout label="Levered IRR" value={pc(lev.irrPct)} unknown={lev.irrPct === null} sub={lev.equityMultiple ? `multiple ${lev.equityMultiple}× · NPV ₹${lev.npv}` : r.nulls.levered} /> : null}
        {lev ? <Readout label="Minimum DSCR" value={`${r.minDscr}×`} unknown={r.minDscr === null} sub={`Loan ${r.acquisition.loan ?? "unknown"}`} /> : null}
      </div>
      {r.years.length ? <Panel title="Cash flows by year"><DataTable caption="Annual cash flows" head={["Year", "Rent", "CAM recovery", "Opex", "Capex", "NOI", ...(lev ? ["Debt service", "DSCR", "Levered CF"] : []), "Unlevered CF"]}
        rows={r.years.map((y) => [y.year, rs(y.rent), rs(y.camRecovery), rs(y.opex), rs(y.capex), rs(y.noi), ...(lev ? [rs(y.debtService), y.dscr ?? "—", rs(y.levered)] : []), rs(y.unlevered)])} /></Panel> : null}
      {r.sensitivities.length ? <Panel title="Sensitivities"><DataTable caption="Sensitivities" head={["Case", "Exit value", "Unlevered IRR", ...(lev ? ["Levered IRR"] : []), "NPV"]} rows={r.sensitivities.map((s) => [s.label, rs(s.exitValue), pc(s.unleveredIrrPct), ...(lev ? [pc(s.leveredIrrPct)] : []), rs(s.npv)])} /></Panel> : null}
      <NoteList title="Assumptions" items={r.assumptions} tone="info" />
      <HowCalc items={r.method} />
      <Panel title="Change the inputs" desc="Saving creates a new version."><InvestmentForm id={id} title={a.title} initial={src.inputs} requirements={reqs as { id: string; title: string }[]} requirementId={a.requirement_id} /></Panel>
      <Versions base="/toolkit/investment" id={id} current={a.current_version} versions={a.versions} />
    </div>
  );
}
