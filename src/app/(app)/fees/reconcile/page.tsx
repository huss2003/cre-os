import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Stat, Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { importFinanceCsvAction } from "@/modules/deals/actions-b";
import { importRows, listImports } from "@/modules/deals/fees/recon-service";
import { Flash } from "@/modules/deals/ui";

type Imp = { id: string; file_name: string; source_system: string | null; row_count: number; created_at: string; summary: Record<string, number>;
  totals: { official: { invoiced: string; collected: string }; recorded: { invoiced: string; collected: string }; difference: { invoiced: string; collected: string }; reconciles: boolean;
    notInExport?: { feeMilestoneId: string; opportunityId: string; invoiceNo: string | null; invoiced: string; invoicedOn: string | null }[] } };
type Row = { id: string; row_no: number; invoice_no: string | null; deal_ref: string | null; invoice_amount: string | null; collected_amount: string | null; status: string; match_method: string | null; exceptions: string[]; proposal_ids: string[]; fee_milestone_id: string | null };
const TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { matched: "ok", missing_in_cre_os: "warn", mismatch: "bad", unmatched: "bad", invalid: "bad" };

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const imports = (await listImports(ctx)) as Imp[];
  const selId = typeof sp.import === "string" ? sp.import : imports[0]?.id;
  const sel = imports.find((i) => i.id === selId) ?? null;
  const rows = sel ? ((await importRows(ctx, sel.id)) as Row[]) : [];
  return (
    <div className="space-y-5">
      <PageHeader title="Reconcile with official finance" subtitle="Import the invoice / collection export from your finance system. It is authoritative: differences become exceptions and change proposals for approval — recorded amounts are never overwritten here."
        actions={<Link className="text-sm text-brand underline" href="/fees">← Fees</Link>} />
      <Flash sp={sp} />
      {app.role !== "viewer" && (
        <Card title="Import finance export (CSV)">
          <form action={importFinanceCsvAction} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="CSV file" hint="Columns recognised: invoice no., invoice date, invoice amount, due date, amount received, receipt date, currency, and a deal reference (fee id or official CRM id). Dates dd/mm/yyyy or yyyy-mm-dd. Max 1 MB here (larger files: POST /api/v1/opportunities/reconcile, up to 2 MB)."><Input type="file" name="file" accept=".csv,text/csv" required /></Field>
            <Field label="Finance system (optional)"><Input name="source_system" placeholder="e.g. Tally, SAP" /></Field>
            <div className="flex items-end"><Button type="submit">Import and reconcile</Button></div>
          </form>
          <p className="mt-2 text-xs text-ink-soft">Matching order: invoice number → fee milestone id → official CRM id (+ amount). Importing the same file again shows the earlier result and proposes nothing twice.</p>
        </Card>
      )}
      {imports.length === 0 ? (
        <EmptyState title="No finance imports yet">Export invoices and collections from the official finance system as CSV and import them here to reconcile fee records.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            {imports.map((i) => <Link key={i.id} href={`/fees/reconcile?import=${i.id}`} className={`rounded-lg border px-2 py-1 ${i.id === sel?.id ? "border-brand text-brand" : "border-line"}`}>{i.file_name} · {i.created_at.slice(0, 10)} {i.totals?.reconciles ? "✓" : "⚠"}</Link>)}
          </div>
          {sel && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Official invoiced" value={inr(sel.totals.official.invoiced, { compact: true })} hint={`CRE OS ${inr(sel.totals.recorded.invoiced, { compact: true })}`} />
                <Stat label="Official collected" value={inr(sel.totals.official.collected, { compact: true })} hint={`CRE OS ${inr(sel.totals.recorded.collected, { compact: true })}`} />
                <Stat label="Difference (official − CRE OS)" value={`${inr(sel.totals.difference.invoiced, { compact: true })} / ${inr(sel.totals.difference.collected, { compact: true })}`} hint="invoiced / collected" />
                <Stat label="Result" value={sel.totals.reconciles ? <Badge tone="ok">Reconciles</Badge> : <Badge tone="bad">Exceptions</Badge>} hint={`${sel.summary.proposals ?? 0} proposal(s) for approval`} />
              </div>
              <Card title={`Rows (${sel.row_count}) — ${sel.file_name}${sel.source_system ? ` from ${sel.source_system}` : ""}`}>
                <Table head={["#", "Invoice / ref", "Official invoiced", "Official collected", "Result", "Exceptions"]}>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <Td>{r.row_no}</Td><Td>{r.invoice_no ?? "—"}{r.deal_ref ? <div className="text-xs text-ink-soft">{r.deal_ref}</div> : null}</Td>
                      <Td>{r.invoice_amount === null ? "—" : inr(r.invoice_amount)}</Td><Td>{r.collected_amount === null ? "—" : inr(r.collected_amount)}</Td>
                      <Td><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ")}</Badge>{r.match_method && r.match_method !== "none" ? <div className="text-xs text-ink-soft">by {r.match_method.replace(/_/g, " ")}</div> : null}</Td>
                      <Td className="text-xs">{r.exceptions.join("; ") || "—"}{r.proposal_ids.length ? <> · <Link className="text-brand underline" href="/approvals">approve proposal</Link></> : null}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
              {(sel.totals.notInExport ?? []).length > 0 && (
                <Card title="Recorded in CRE OS but missing from this export">
                  <ul className="space-y-1 text-sm">{sel.totals.notInExport!.map((n) => <li key={n.feeMilestoneId}><Link className="underline" href={`/deals/${n.opportunityId}`}>{n.invoiceNo ?? "invoice without number"}</Link> · {inr(n.invoiced)} on {n.invoicedOn ?? "?"} — check with finance (CRE OS is not authoritative)</li>)}</ul>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
