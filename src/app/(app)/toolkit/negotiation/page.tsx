import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { createNegotiationAction } from "@/modules/toolkit/actions-lease";
import { listAnalyses } from "@/modules/toolkit/store";
import { EmptyState, Legend, ToolHeader } from "@/modules/toolkit/ui/kit";
import { BlankHint, H, In, SavedList, StickyBar } from "@/modules/toolkit/ui/lease/shared";
import { LeaseTermFields } from "../lease/parts";
import { NonFinancialFields } from "./fields";
import { NothingSent } from "@/modules/toolkit/ui/lease/negotiation";

const STEPS = ["Record Offer 1", "Add each counter-offer", "See what changed", "Value concessions & plan"];

export default async function NegotiationPage() {
  const ctx = await requirePageContext();
  const saved = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "negotiation", limit: 30 });
  return (
    <div data-tour="toolkit-negotiation" className="mx-auto max-w-5xl space-y-6 pb-16">
      <ToolHeader eyebrow="Deal toolkit" title="Negotiation comparison" purpose="Every landlord offer is kept as its own version (Offer 1, Offer 2 …). See what moved, what it is worth and what is still open." steps={STEPS} current={0} />
      <NothingSent />
      <Legend />
      <section className="space-y-3" aria-labelledby="nego-list-h">
        <H><span id="nego-list-h">Negotiations</span></H>
        {saved.length === 0 ? <EmptyState title="No negotiations yet" text="Record the landlord's first offer below. Each later offer is added as a new version — nothing is overwritten." /> : (
          <SavedList items={saved as any} href={(id) => `/toolkit/negotiation/${id}`} statusLabel={(s) => (s === "needs_info" ? "Open terms" : undefined)} />
        )}
      </section>
      {ctx.role !== "viewer" && (
        <section className="space-y-4" aria-labelledby="nego-new-h">
          <H sub="Enter the landlord's first offer. Later offers are added on the negotiation's page."><span id="nego-new-h">Start with Offer 1</span></H>
          <ActionForm action={createNegotiationAction} className="space-y-5" dataTour="nego-offer1">
            <BlankHint />
            <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
              <In label="Negotiation title" name="title" placeholder="Tower B, 4th floor — landlord X" />
              <In label="Discount rate" unit="% per year" name="discount" inputMode="decimal" required placeholder="e.g. 10" hint="Your cost of money; used for present value. Required." />
            </div>
            <LeaseTermFields p="o0_" title="Offer 1 — financial terms" extra={<NonFinancialFields />} />
            <StickyBar note="Saves Offer 1. Nothing is sent to anyone.">
              <Submit dataTour="nego-save1">Save Offer 1</Submit>
            </StickyBar>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
