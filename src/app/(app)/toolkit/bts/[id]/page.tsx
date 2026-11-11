import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis, getVersion } from "@/modules/toolkit/store";
import type { BtsResult } from "@/modules/toolkit/calc/bts";
import { Legend, MissingNote, Readout, ToolHeader } from "@/modules/toolkit/ui/kit";
import { HowCalc, NoteList, Panel } from "@/modules/toolkit/ui/options/parts";
import { BtsForm, DataTable, OldVersionBanner, Versions } from "@/modules/toolkit/ui/models";
import { DeckPanel } from "@/modules/toolkit/ui/deck-button";
import { rs } from "../../fitout/results";

export default async function BtsView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const ctx = await requirePageContext();
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as Record<string, any> | null;
  if (!a || a.kind !== "bts") notFound();
  const vNum = sp.v ? Number(sp.v) : null;
  const ver = vNum && vNum !== a.current_version ? await getVersion(ctx.db, ctx.workspaceId, id, vNum) : null;
  const src = ver ?? a; const r = src.outputs as BtsResult;
  const reqs = (await ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(200)).data ?? [];
  const pc = r.projectCost; const why = (k: string) => r.nulls[k];
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow={`BTS · version ${ver ? ver.version : a.current_version} · formula ${src.formula_version} · ${r.areaBasis ?? "basis not stated"}`} title={a.title}
        purpose="Key numbers first, then the rent schedule. Edit below to save a new version." back={{ href: "/toolkit/bts", label: "All BTS models" }}
        steps={["Enter land, building and lease", "Calculate", "Read the result"]} current={2} action={<DeckPanel db={ctx.db} ws={ctx.workspaceId} analysisId={id} version={ver?.version ?? null} />} />
      {ver ? <OldVersionBanner base="/toolkit/bts" id={id} version={ver.version} /> : null}
      <MissingNote items={r.missing} />
      <Legend />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Readout label="Total project cost" value={rs(pc.total)} unknown={pc.total === null} emphasis sub={pc.perSf ? `₹${pc.perSf}/SF` : why("total")} />
        <Readout label={r.rent.mode === "yield" ? "Required rent" : "Target rent"} value={`₹${r.rent.requiredRentPerSfMonth}/SF/month`} unknown={r.rent.requiredRentPerSfMonth === null} sub={why("requiredRentPerSfMonth") ?? `${r.areaBasis ?? ""} basis`} />
        <Readout label="Yield on cost" value={`${r.rent.impliedYieldPct}%`} unknown={r.rent.impliedYieldPct === null} sub={why("impliedYieldPct")} />
        <Readout label="Tenant cost over term" value={rs(r.tenant.nominal)} unknown={r.tenant.nominal === null} sub={r.tenant.npv ? <>NPV {rs(r.tenant.npv)}</> : why("tenantNpv")} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Readout label="Refundable deposit (kept separate)" value={rs(r.tenant.deposit)} unknown={r.tenant.deposit === null} />
        <Readout label="Annual land rent (developer cost)" value={rs(r.rent.landRentAnnual)} unknown={r.rent.landRentAnnual === null} />
      </div>
      <Panel title="Project cost">
        <DataTable caption="Project cost breakdown" head={["Item", "₹"]} rows={[["Land", rs(pc.land)], ["Construction", rs(pc.hard)], ["Soft costs", rs(pc.soft)], ["Interest during construction", rs(pc.interest)]]} foot={["Total", rs(pc.total)]} />
      </Panel>
      {r.schedule.length ? <Panel title="Rent schedule by lease year"><DataTable caption="Rent schedule" head={["Year", "Months", "Rent ₹/SF/month", "Rent paid"]} rows={r.schedule.map((y) => [y.year, y.months, y.rentPerSfMonth ?? "—", rs(y.rentPaid)])} foot={["Total", "", "", rs(r.tenant.rentPaid)]} /></Panel> : null}
      {r.comparison ? (
        <Panel title={`BTS vs ${r.comparison.name}`} desc={r.comparison.comparable ? `Lower tenant cost: ${r.comparison.cheaper === "bts" ? "built-to-suit" : r.comparison.cheaper === "alternative" ? r.comparison.name : "equal"}.` : `Not compared — ${r.comparison.reason}`}>
          <DataTable caption="Comparison" head={["Measure", "BTS", r.comparison.name]} rows={[["Rent paid", rs(r.tenant.rentPaid), rs(r.comparison.alternative.rentPaid)], ["Fit-out", rs(r.tenant.fitout), rs(r.comparison.alternative.fitout)], ["Total (nominal)", rs(r.tenant.nominal), rs(r.comparison.alternative.nominal)], ["NPV", rs(r.tenant.npv), rs(r.comparison.alternative.npv)], ["Deposit (refundable)", rs(r.tenant.deposit), rs(r.comparison.alternative.deposit)]]} />
        </Panel>
      ) : null}
      <NoteList title="Assumptions" items={r.assumptions} tone="info" />
      <HowCalc items={r.method} />
      <Panel title="Change the inputs" desc="Saving creates a new version."><BtsForm id={id} title={a.title} initial={src.inputs} requirements={reqs as { id: string; title: string }[]} requirementId={a.requirement_id} /></Panel>
      <Versions base="/toolkit/bts" id={id} current={a.current_version} versions={a.versions} />
    </div>
  );
}
