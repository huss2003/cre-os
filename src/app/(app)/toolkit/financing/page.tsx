import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel, SavedList } from "@/modules/toolkit/ui/options/parts";
import { loadPartners } from "../fitout/data";
import { FinancingForm } from "./form";

export default async function FinancingPage() {
  const ctx = await requirePageContext();
  const [saved, partners] = await Promise.all([listAnalyses(ctx.db, ctx.workspaceId, { kind: "financing" }), loadPartners(ctx.db, ctx.workspaceId)]);
  return (
    <div data-tour="toolkit-financing" className="space-y-6">
      <ToolHeader eyebrow="Deal toolkit" title="Fit-out financing" purpose="Work out the monthly EMI, the full repayment schedule, total interest, fees and the month-by-month cash needed. Formula loan-1.0 — deterministic, rounded to paise only per row."
        steps={["Loan details", "Calculate", "Read the schedule"]} current={0} />
      <Legend />
      <Panel title="New financing analysis" desc="Fill the loan details, then press Calculate at the bottom.">
        <FinancingForm partners={partners} />
        <div className="mt-4"><HowCalc items={["EMI = P·r·(1+r)^n ÷ ((1+r)^n − 1), where r = annual rate ÷ 12.", "The last EMI is adjusted by a few paise so the loan closes at exactly ₹0."]} /></div>
      </Panel>
      <Panel title="Saved financing analyses"><SavedList rows={saved} base="/toolkit/financing" emptyTitle="No financing analyses yet" emptyText="Enter the amount, rate and tenure above. To compare partners, save one analysis per partner's terms." /></Panel>
    </div>
  );
}
