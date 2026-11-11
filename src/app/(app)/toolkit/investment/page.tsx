import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel, SavedList } from "@/modules/toolkit/ui/options/parts";
import { InvestmentForm } from "@/modules/toolkit/ui/models";

export default async function InvestmentPage() {
  const ctx = await requirePageContext();
  const [saved, reqs] = await Promise.all([listAnalyses(ctx.db, ctx.workspaceId, { kind: "investment" }), ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200)]);
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow="Deal toolkit · specialist model" title="Investment analysis" purpose="Buy, hold and sell an income-producing building: NOI by year, yield on cost, cash flows, unlevered and levered IRR, NPV, equity multiple, DSCR and exit value, with exit-cap and rent sensitivities. Formula inv-1.0, deterministic."
        steps={["Enter price, tenancies and exit", "Calculate", "Read the returns"]} current={0} />
      <Legend />
      <Panel title="New investment analysis" desc="Blank = unknown. Results that depend on an unknown input are shown as unknown, with the reason.">
        <InvestmentForm requirements={(reqs.data ?? []) as { id: string; title: string }[]} />
        <div className="mt-4"><HowCalc items={["NOI = rent + CAM recovery − opex − capex reserve.", "Exit value = next-year NOI ÷ exit cap rate, less sale costs.", "IRR is solved deterministically; if no rate solves it, it is shown as unknown."]} /></div>
      </Panel>
      <Panel title="Saved investment analyses"><SavedList rows={saved} base="/toolkit/investment" emptyTitle="No investment analyses yet" emptyText="Enter the price, tenancy schedule, hold and exit above and press Calculate." /></Panel>
    </div>
  );
}
