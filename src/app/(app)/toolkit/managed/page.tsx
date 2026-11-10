import { HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { Panel, SavedList } from "@/modules/toolkit/ui/options/parts";
import { ManagedForm } from "./_parts/form";

const STEPS_MANAGED = ["Describe the lease option", "Describe the managed option", "Compare", "Read the recommendation"];

export default async function ManagedPage() {
  const ctx = await requirePageContext();
  const rows = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "conventional_vs_managed", limit: 30 });
  return (
    <div data-tour="toolkit-managed" className="space-y-6">
      <ToolHeader eyebrow="Deal toolkit" title="Conventional lease vs managed office" purpose="Put a conventional lease and a managed-office quote side by side over the same period, per usable seat, with included services counted once. Leave a box blank when you don't know — it is listed as missing, never taken as zero."
        steps={STEPS_MANAGED} current={0} />
      <Legend />
      <Panel title={<>New comparison<HelpFor k="Conventional vs managed" /></>} desc="Fill Option 1 and Option 2, then press Compare at the bottom."><ManagedForm /></Panel>
      <Panel title="Saved comparisons"><SavedList rows={rows} base="/toolkit/managed" emptyTitle="No comparisons yet" emptyText="Fill in the form above with the lease terms and the operator's quote, then press Compare & save." /></Panel>
    </div>
  );
}
