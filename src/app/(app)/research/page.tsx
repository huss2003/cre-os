import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Table, Td, ButtonLink } from "@/components/ui";
import { watchlistView, openFindings, orgOptions } from "@/modules/intelligence/research/queries";
import { TIER_POLICY } from "@/modules/intelligence/common";
import { Flash, Sev, TIER_TONE, fmtDay, label } from "@/modules/intelligence/ui";
import { watchAction, patrolAction, findingAction } from "./actions";

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const [{ watch, unwatchedDossiers }, findings, orgs] = await Promise.all([watchlistView(ctx.db, ctx.workspaceId), openFindings(ctx.db, ctx.workspaceId), orgOptions(ctx.db, ctx.workspaceId)]);
  const counts = { critical: 0, active: 0, universe: 0 } as Record<string, number>;
  for (const w of watch) counts[String(w.tier)]++;

  return (
    <div>
      <PageHeader title="Research" subtitle="Cited company dossiers. Every claim has dates, an expiry and an evidence tier; unknowns stay unknown." actions={<><ButtonLink variant="secondary" href="/research/sources">Approved sources</ButtonLink>{canEdit ? <form action={patrolAction}><Button variant="secondary">Run evidence patrol</Button></form> : null}</>} />
      <Flash sp={sp} />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["critical", "active", "universe"] as const).map((t) => (
          <div key={t} className="rounded-xl border border-line bg-surface p-3 text-sm">
            <div className="flex items-center justify-between"><Badge tone={TIER_TONE[t]}>{TIER_POLICY[t].label}</Badge><span className="font-semibold">{counts[t]}</span></div>
            <div className="mt-1 text-xs text-ink-soft">Operating limit {TIER_POLICY[t].capacity}. Re-runs only when evidence changes or every {TIER_POLICY[t].cadenceDays} days.</div>
          </div>
        ))}
      </div>

      {canEdit && (
        <Card title="Add a company to the watchlist" className="mb-4">
          {orgs.length === 0 ? (
            <p className="text-sm text-ink-soft">No companies yet. Add companies in <Link className="text-brand underline" href="/companies">Companies</Link> or run an <Link className="text-brand underline" href="/imports">import</Link> first.</p>
          ) : (
            <form action={watchAction} className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
              <Field label="Company"><Select name="org_id" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)]}</Select></Field>
              <Field label="Tier"><Select name="tier" defaultValue="active"><option value="critical">Critical (weekly)</option><option value="active">Active (monthly)</option><option value="universe">Universe (quarterly)</option></Select></Field>
              <Field label="Why"><Input name="reason" placeholder="e.g. lease expiry 2027" maxLength={300} /></Field>
              <Button type="submit">Save</Button>
            </form>
          )}
        </Card>
      )}

      <Card title="Watchlist" className="mb-4">
        {watch.length === 0 ? (
          <EmptyState title="No companies on the watchlist">Add companies above. Research works from stored evidence and notes or URLs you paste — nothing is scraped, and LinkedIn is never automated.</EmptyState>
        ) : (
          <Table head={["Company", "Tier", "Dossier", "Next refresh", ""]}>
            {watch.map((w) => {
              const d = w.dossier as Record<string, unknown> | null;
              return (
                <tr key={String(w.id)}>
                  <Td><Link className="font-medium text-brand" href={`/research/${w.org_id}`}>{w.name}</Link>{w.reason ? <div className="text-xs text-ink-soft">{String(w.reason)}</div> : null}</Td>
                  <Td><Badge tone={TIER_TONE[String(w.tier)]}>{String(w.tier)}</Badge></Td>
                  <Td>{d ? <span>v{String(d.version)} · {fmtDay(String(d.generated_at))}{Number(d.expired_claim_count) > 0 ? <> · <Badge tone="warn">{String(d.expired_claim_count)} expired</Badge></> : null}{d.synthesis_status !== "ok" ? <> · <Badge tone="accent">no AI</Badge></> : null}</span> : <span className="text-ink-soft">not generated</span>}</Td>
                  <Td>{fmtDay(String(w.next_due_at))}</Td>
                  <Td><ButtonLink variant="ghost" href={`/research/${w.org_id}`}>Open</ButtonLink></Td>
                </tr>
              );
            })}
          </Table>
        )}
        {unwatchedDossiers.length > 0 && <p className="mt-2 text-xs text-ink-soft">Also: {unwatchedDossiers.map((d, i) => <span key={String(d.org_id)}>{i ? ", " : ""}<Link className="text-brand" href={`/research/${d.org_id}`}>{String(d.name)}</Link></span>)} (dossier, not watched)</p>}
      </Card>

      <Card title={`Evidence patrol — open findings (${findings.length})`}>
        {findings.length === 0 ? (
          <EmptyState title="No open findings">The daily patrol reports newer quotes vs old listings, former contacts still listed as stakeholders, changed completion dates, conflicting and expired evidence. Findings are reports — nothing is changed automatically.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {findings.map((f) => (
              <li key={String(f.id)} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="text-sm"><Sev s={String(f.severity)} /> <span className="font-medium">{label(String(f.kind))}</span> — {String(f.detail)}
                  {f.subject_type === "organisation" && f.subject_id ? <> <Link className="text-brand" href={`/research/${f.subject_id}`}>open dossier</Link></> : null}
                  <div className="text-xs text-ink-soft">{fmtDay(String(f.detected_at))}</div></div>
                {canEdit && (
                  <form action={findingAction} className="flex gap-2"><input type="hidden" name="id" value={String(f.id)} />
                    <Button variant="secondary" name="status" value="resolved">Resolved</Button><Button variant="ghost" name="status" value="dismissed">Dismiss</Button></form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
