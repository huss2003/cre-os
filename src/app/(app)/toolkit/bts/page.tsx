import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel, SavedList } from "@/modules/toolkit/ui/options/parts";
import { BtsForm } from "@/modules/toolkit/ui/models";

export default async function BtsPage() {
  const ctx = await requirePageContext();
  const [saved, reqs] = await Promise.all([listAnalyses(ctx.db, ctx.workspaceId, { kind: "bts" }), ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200)]);
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow="Deal toolkit · specialist model" title="Built-to-suit (BTS)" purpose="Work out the total project cost, the rent a developer needs for a target yield (or the yield a rent gives), the rent schedule and the tenant's total occupancy cost — optionally against leasing elsewhere. Formula bts-1.0, deterministic."
        steps={["Enter land, building and lease", "Calculate", "Read the result"]} current={0} />
      <Legend />
      <Panel title="New BTS model" desc="Blank = unknown. Results that depend on an unknown input are shown as unknown, with the reason.">
        <BtsForm requirements={(reqs.data ?? []) as { id: string; title: string }[]} />
        <div className="mt-4"><HowCalc items={["Project cost = land + area × construction cost/SF + soft costs % + interest during construction (if included).", "Required rent = (yield × project cost + annual land rent) ÷ area ÷ 12.", "Deposit is refundable and kept out of the tenant's cost and NPV."]} /></div>
      </Panel>
      <Panel title="Saved BTS models"><SavedList rows={saved} base="/toolkit/bts" emptyTitle="No BTS models yet" emptyText="Fill in the land, building and lease details above and press Calculate." /></Panel>
    </div>
  );
}
