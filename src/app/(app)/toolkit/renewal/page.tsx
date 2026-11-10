import { HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { Panel, SavedList } from "@/modules/toolkit/ui/options/parts";
import { RenewalForm } from "./_parts/form";

export default async function RenewalPage() {
  const ctx = await requirePageContext();
  const rows = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "renewal_vs_relocation", limit: 30 });
  return (
    <div data-tour="toolkit-renewal" className="space-y-6">
      <ToolHeader eyebrow="Deal toolkit" title="Renew or relocate?" purpose="Compare staying in the current premises with moving: total cost, present value, month-by-month cost and break-even, plus a separate score for non-money factors. Blank = unknown and listed as missing, never zero."
        steps={["Stay option", "Move option", "Compare", "Decide"]} current={0} />
      <Legend />
      <Panel title={<>New analysis<HelpFor k="Renewal vs relocation" /></>} desc="Fill Stay and Move, then press Compare at the bottom."><RenewalForm /></Panel>
      <Panel title="Saved analyses"><SavedList rows={rows} base="/toolkit/renewal" emptyTitle="No analyses yet" emptyText="Enter the landlord renewal proposal and the best relocation option above, then press Compare & save." /></Panel>
    </div>
  );
}
