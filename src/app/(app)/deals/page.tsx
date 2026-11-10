import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, Input, MoreFields, PageHeader, Select, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { createOpportunityAction } from "@/modules/deals/actions";
import { listBoard } from "@/modules/deals/pipeline/service";
import { STAGES, STAGE_LABEL, type Stage } from "@/modules/deals/pipeline/stages";
import { Flash } from "@/modules/deals/ui";

const tempTone = (t: unknown) => (t === "hot" ? "bad" : t === "warm" ? "warn" : "neutral") as "bad" | "warn" | "neutral";

export default async function DealsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const all = sp.all === "1";
  const opps = await listBoard(ctx, { includeClosed: all }) as Record<string, unknown>[];
  const [{ data: reqs }, { data: orgs }] = await Promise.all([
    ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).neq("status", "closed").order("updated_at", { ascending: false }).limit(200),
    ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("display_name").limit(500),
  ]);
  const byStage = new Map<string, Record<string, unknown>[]>();
  for (const o of opps) byStage.set(o.stage as string, [...(byStage.get(o.stage as string) ?? []), o]);
  const Cardlet = ({ o }: { o: Record<string, unknown> }) => (
    <Link href={`/deals/${o.id}`} className="block rounded-lg border border-line bg-surface p-2.5 text-sm shadow-sm hover:border-brand">
      <div className="font-medium">{o.name as string}</div>
      <div className="text-xs text-ink-soft">{(o.organisation as { display_name?: string } | null)?.display_name ?? "—"}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {o.temperature ? <Badge tone={tempTone(o.temperature)}>{o.temperature as string}</Badge> : null}
        {o.mandate_status && o.mandate_status !== "unknown" ? <Badge tone="brand">{String(o.mandate_status).replace("_", "-")}</Badge> : null}
        {o.outcome !== "open" ? <Badge tone="ok">{o.outcome as string}</Badge> : null}
        {o.expected_fee ? <Badge>{inr(o.expected_fee as number, { compact: true })}</Badge> : null}
      </div>
      {o.next_action ? <div className="mt-1 text-xs text-ink-soft">Next: {o.next_action as string}{o.next_action_due ? ` · ${o.next_action_due}` : ""}</div> : null}
    </Link>
  );
  return (
    <div>
      <div data-tour="deals-header">
      <PageHeader title="Pipeline" subtitle="Stage = deal progress. Outcome, temperature and mandate are tracked separately."
        actions={<Link className="text-sm text-brand underline" href={all ? "/deals" : "/deals?all=1"}>{all ? "Hide lost / dormant" : "Show lost / dormant"}</Link>} />
      </div>
      <Flash sp={sp} />
      {opps.length === 0 ? (
        <EmptyState title="No opportunities yet">Create one below, or open a requirement and choose “Track as opportunity”.</EmptyState>
      ) : (
        <>
          <div className="space-y-4 lg:hidden">
            {STAGES.filter((s) => byStage.has(s)).map((s) => (
              <section key={s}>
                <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">{STAGE_LABEL[s]} ({byStage.get(s)!.length})</h2>
                <div className="space-y-2">{byStage.get(s)!.map((o) => <Cardlet key={o.id as string} o={o} />)}</div>
              </section>
            ))}
          </div>
          <div className="hidden gap-3 overflow-x-auto pb-3 lg:flex">
            {STAGES.map((s: Stage) => (
              <section key={s} className="w-56 shrink-0 rounded-xl bg-canvas p-2">
                <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">{STAGE_LABEL[s]} · {byStage.get(s)?.length ?? 0}</h2>
                <div className="space-y-2">{(byStage.get(s) ?? []).map((o) => <Cardlet key={o.id as string} o={o} />)}</div>
              </section>
            ))}
          </div>
        </>
      )}
      {app.role !== "viewer" && (
        <Card title="New opportunity" className="mt-6">
          <form action={createOpportunityAction} className="max-w-md space-y-4">
            <Field label="Name"><Input name="name" required /></Field>
            <Field label="Requirement"><Select name="requirement_id" defaultValue=""><option value="">— none yet —</option>{(reqs ?? []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</Select></Field>
            <Field label="Or company"><Select name="org_id" defaultValue=""><option value="">— choose —</option>{(orgs ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</Select></Field>
            <Field label="Stage"><Select name="stage" defaultValue="research">{STAGES.slice(0, 4).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</Select></Field>
            <MoreFields>
            <Field label="Temperature"><Select name="temperature" defaultValue=""><option value="">—</option><option>cold</option><option>warm</option><option>hot</option></Select></Field>
            <Field label="Mandate"><Select name="mandate_status" defaultValue="unknown">{["unknown", "none", "non_exclusive", "exclusive", "support"].map((m) => <option key={m}>{m}</option>)}</Select></Field>
            <Field label="Expected fee ₹"><Input name="expected_fee" inputMode="decimal" /></Field>
            <Field label="Credit share %"><Input name="credit_share_pct" inputMode="decimal" /></Field>
            <Field label="CRM id"><Input name="crm_external_id" /></Field>
            </MoreFields>
            <Button type="submit">Create</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
