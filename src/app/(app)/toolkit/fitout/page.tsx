import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { Panel, SavedList } from "@/modules/toolkit/ui/options/parts";
import { FitoutEditor } from "./editor";
import { loadPartners } from "./data";

export default async function FitoutPage() {
  const ctx = await requirePageContext();
  const [saved, partners] = await Promise.all([listAnalyses(ctx.db, ctx.workspaceId, { kind: "fitout" }), loadPartners(ctx.db, ctx.workspaceId)]);
  return (
    <div data-tour="toolkit-fitout" className="space-y-6">
      <ToolHeader eyebrow="Deal toolkit" title="Fit-out budget & partner quotes" purpose="Track estimated, approved and actual costs by category with tax shown separately, and compare partner quotations like-for-like. Formula fitout-1.0 — deterministic, no AI arithmetic."
        steps={["Add budget lines", "Add partner quotes", "Compare"]} current={0} />
      <Legend />
      <Panel title="New fit-out budget" desc="Leave unknown amounts blank — they show as unknown, never as zero."><FitoutEditor partners={partners} /></Panel>
      <Panel title="Saved budgets"><SavedList rows={saved} base="/toolkit/fitout" emptyTitle="No fit-out budgets yet" emptyText="Add budget lines above (amounts excluding tax, with each line's tax %), then add partner quotations and press Compare & save." /></Panel>
    </div>
  );
}
