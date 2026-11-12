import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, Input, MoreFields, PageHeader, Select, StaleBanner, Textarea } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listTransactions } from "@/modules/transactions/service";
import { TX_TYPES, TX_TYPE_LABEL, prefillRequirement } from "@/modules/transactions/model";
import { codeLabel } from "@/lib/util/labels";
import { createTransactionAction, saveTemplateAction } from "@/modules/transactions/actions";

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const ctx = { db: app.db, workspaceId: app.workspaceId, userId: app.userId };
  const rows = await listTransactions(ctx, { opportunityId: sp.opportunity });
  const [reqs, opps, tpls] = await Promise.all([
    app.db.from("requirement").select("id, title, status").eq("workspace_id", app.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(50),
    app.db.from("opportunity").select("id, name, requirement_id").eq("workspace_id", app.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(50),
    app.db.from("tx_stage_template").select("id, name, tx_type").eq("workspace_id", app.workspaceId).is("archived_at", null),
  ]);
  const canEdit = app.role !== "viewer";
  // B13: a deal opened from its page brings its requirement (fetched even if it is outside the recent 50).
  let oppRows = (opps.data ?? []) as { id: string; name: string; requirement_id: string | null }[];
  if (sp.opportunity && !oppRows.some((o) => o.id === sp.opportunity)) {
    const one = (await app.db.from("opportunity").select("id, name, requirement_id").eq("workspace_id", app.workspaceId).eq("id", sp.opportunity).maybeSingle()).data;
    if (one) oppRows = [one, ...oppRows];
  }
  const reqDefault = prefillRequirement(sp.opportunity, oppRows);
  let reqRows = (reqs.data ?? []) as { id: string; title: string; status: string }[];
  if (reqDefault && !reqRows.some((r) => r.id === reqDefault)) {
    const one = (await app.db.from("requirement").select("id, title, status").eq("workspace_id", app.workspaceId).eq("id", reqDefault).maybeSingle()).data;
    if (one) reqRows = [one, ...reqRows];
  }
  return (
    <div className="space-y-5">
      <PageHeader title="Transactions" subtitle="Execute confirmed requirements: offers, negotiation, approvals, documents, execution, possession and handover." />
      {sp.err && <StaleBanner>{sp.err}</StaleBanner>}
      {sp.ok && <p className="text-sm text-ok">{sp.ok}</p>}
      {rows.length === 0 ? (
        <EmptyState title="No transactions yet">Create one below when a client requirement is confirmed and ready to progress. Link it to the requirement and the deal so the offers, approvals and documents stay on the same records.</EmptyState>
      ) : (
        <ul className="divide-y divide-ink/10 rounded-md border border-ink/10">
          {rows.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 p-3">
              <Link className="font-medium text-brand underline" href={`/transactions/${t.id}`}>{t.name}</Link>
              <span className="text-xs text-ink-soft">{t.code}</span>
              <Badge>{TX_TYPE_LABEL[t.tx_type] ?? t.tx_type}</Badge>
              <Badge tone={t.status === "completed" ? "ok" : t.status === "active" ? "brand" : "neutral"}>{codeLabel(t.status)}</Badge>
              {t.priority !== "normal" && <Badge tone="warn">{codeLabel(t.priority)}</Badge>}
              <span className="ml-auto text-xs text-ink-soft">stage: {codeLabel(t.current_stage)}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <Card title="New transaction">
          <form action={createTransactionAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input name="name" required placeholder="Acme — Kharadi 25k SF" /></Field>
            <Field label="Type">
              <Select name="tx_type" defaultValue="conventional_leasing">
                {TX_TYPES.map((t) => <option key={t} value={t}>{TX_TYPE_LABEL[t]}</option>)}
                {(tpls.data ?? []).filter((x) => !TX_TYPES.includes(x.tx_type)).map((x) => <option key={x.id} value={x.tx_type}>{x.tx_type}</option>)}
              </Select>
            </Field>
            <Field label="Confirmed requirement"><Select name="requirement_id" defaultValue={reqDefault}><option value="">—</option>{reqRows.map((r) => <option key={r.id} value={r.id}>{r.title} ({codeLabel(r.status)})</option>)}</Select></Field>
            <Field label="Deal"><Select name="opportunity_id" defaultValue={sp.opportunity ?? ""}><option value="">—</option>{oppRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
            <Field label="Properties under consideration" hint="comma separated"><Input name="properties" /></Field>
            <Field label="Expected completion"><Input name="expected_completion" type="date" /></Field>
            <MoreFields>
              <Field label="Priority"><Select name="priority" defaultValue="normal">{["low", "normal", "high", "critical"].map((p) => <option key={p}>{p}</option>)}</Select></Field>
              <Field label="Workflow template"><Select name="template_id" defaultValue=""><option value="">Default for type</option>{(tpls.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.tx_type})</option>)}</Select></Field>
            </MoreFields>
            <div className="sm:col-span-2"><Button>Create transaction</Button></div>
          </form>
        </Card>
      )}
      {canEdit && (
        <Card title="Workflow templates" help="Customise stages per transaction type, or add a new type. Existing transactions keep their stages.">
          <form action={saveTemplateAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Transaction type (existing or new)"><Input name="tx_type" required placeholder="conventional_leasing" /></Field>
            <Field label="Template name"><Input name="name" required /></Field>
            <div className="sm:col-span-2"><Field label="Stages (one per line)"><Textarea name="stages" rows={5} required /></Field></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_default" /> Use as default for this type</label>
            <div><Button variant="secondary">Save template</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}
