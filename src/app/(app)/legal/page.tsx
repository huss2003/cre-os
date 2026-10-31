import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Textarea, Table, Td } from "@/components/ui";
import { listLegalDocuments } from "@/modules/intelligence/legal/queries";
import { LEGAL_DISCLAIMER } from "@/modules/intelligence/common";
import { Flash, Disclaimer, fmtDay, label } from "@/modules/intelligence/ui";
import { addDocumentAction, compareAction } from "./actions";

export default async function LegalPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const docs = await listLegalDocuments(ctx.db, ctx.workspaceId);
  const opts = docs.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.title)} · v{String(d.version)}</option>);

  return (
    <div>
      <PageHeader title="Legal desk" subtitle="Clause extraction, version redlines and an exposure checklist for LOIs, term sheets and leases." />
      <Disclaimer>{LEGAL_DISCLAIMER} The tenant&apos;s legal team owns advice and approval; a generated redline is never legal approval.</Disclaimer>
      <Flash sp={sp} />

      <Card title="Documents" className="mb-4">
        {docs.length === 0 ? <EmptyState title="No documents yet">Paste the text of an LOI, term sheet or lease below. Upload a later version with the same family key to get a redline.</EmptyState> : (
          <Table head={["Document", "Kind", "Version", "Status", "Added"]}>
            {docs.map((d) => (
              <tr key={String(d.id)}>
                <Td><Link className="font-medium text-brand" href={`/legal/${d.id}`}>{String(d.title)}</Link><div className="text-xs text-ink-soft">{String(d.family_key)}</div></Td>
                <Td>{label(String(d.doc_kind))}</Td><Td>v{String(d.version)}</Td>
                <Td><Badge>{label(String(d.status))}</Badge>{d.ocr_unverified ? <> <Badge tone="warn">OCR unverified</Badge></> : null}</Td>
                <Td>{fmtDay(String(d.created_at))}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canEdit && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Add a document version">
            <form action={addDocumentAction} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Title"><Input name="title" required minLength={2} maxLength={200} placeholder="Acme Baner LOI" /></Field>
                <Field label="Kind"><Select name="doc_kind" defaultValue="loi"><option value="loi">LOI</option><option value="term_sheet">Term sheet</option><option value="lease">Lease</option><option value="amendment">Amendment</option><option value="other">Other</option></Select></Field>
              </div>
              <Field label="Family key" hint="Same key = new version of the same document. Leave blank to derive from the title."><Input name="family_key" maxLength={120} /></Field>
              <Field label="Text" hint="Paste the full text. Scanned documents: tick OCR unverified."><Textarea name="text" required minLength={20} className="min-h-48" /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="ocr_unverified" /> Text came from OCR (clauses need verification)</label>
              <Button type="submit">Store &amp; extract clauses</Button>
            </form>
          </Card>
          <Card title="Compare two versions">
            {docs.length < 2 ? <p className="text-sm text-ink-soft">Add at least two documents to compare.</p> : (
              <form action={compareAction} className="space-y-3">
                <Field label="Base (earlier)"><Select name="base_id" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...opts]}</Select></Field>
                <Field label="Compare (later)"><Select name="compare_id" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...opts]}</Select></Field>
                <Button type="submit">Build redline</Button>
              </form>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
