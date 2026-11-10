import Link from "next/link";
import { Badge, Card, EmptyState, Field, HelpFor, Input, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { createNegotiationAction } from "@/modules/toolkit/actions-lease";
import { listAnalyses } from "@/modules/toolkit/store";
import { LeaseTermFields } from "../lease/parts";
import { NonFinancialFields } from "./fields";

export default async function NegotiationPage() {
  const ctx = await requirePageContext();
  const saved = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "negotiation", limit: 30 });
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <PageHeader title="Negotiation comparison" subtitle="Every landlord offer is kept as its own version (Offer 1, Offer 2 …). See what moved, what it is worth (fin-1.0 NPV) and what is still open. Formula nego-1.0. CRE OS never accepts, rejects or sends anything." />
      <Card title="Negotiations">
        {saved.length === 0 ? <EmptyState title="No negotiations yet">Record the landlord&apos;s first offer below. Each later offer is added as a new version — nothing is overwritten.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {saved.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><Link className="text-brand" href={`/toolkit/negotiation/${a.id}`}>{a.title}</Link><span className="flex gap-1.5 text-xs text-ink-soft">v{a.current_version} <Badge tone={a.status === "needs_info" ? "warn" : "neutral"}>{a.status === "needs_info" ? "open terms" : a.status}</Badge></span></li>)}
          </ul>
        )}
      </Card>
      {ctx.role !== "viewer" && (
        <Card title={<span className="flex items-center">Start with Offer 1<HelpFor k="Negotiation" /></span>}>
          <ActionForm action={createNegotiationAction} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Title"><Input name="title" placeholder="Tower B, 4th floor — landlord X" /></Field>
              <Field label="Discount % p.a."><Input name="discount" inputMode="decimal" required /></Field>
            </div>
            <LeaseTermFields p="o0_" title="Offer 1 — financial terms" extra={<NonFinancialFields />} />
            <Submit>Save Offer 1</Submit>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
