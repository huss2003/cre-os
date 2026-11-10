/**
 * Reusable evidence attachments for any deal analysis. Server component: `<EvidenceList analysisId=… revalidate="/path" />`.
 * Lists items with verification labels + a conflicting-information flag, lets editors change verification, and
 * includes an upload form (file to storage <ws>/evidence/…, or a link / note).
 */
import { Badge, Card, Field, Help, Input, Select, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { addEvidenceAction, setEvidenceVerificationAction } from "@/modules/toolkit/actions-extras";
import { EVIDENCE_KINDS, evidenceLink, evidenceSummary, listEvidence } from "@/modules/toolkit/evidence";
import { WorkspaceFileInput } from "../quotes/file-upload";

const TONE = { verified: "ok", unverified: "warn", conflicting: "bad" } as const;

export async function EvidenceList({ analysisId, revalidate }: { analysisId: string; revalidate: string }) {
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const rows = await listEvidence(ctx, analysisId);
  const links = await Promise.all(rows.map((r) => evidenceLink(ctx, r)));
  const sum = evidenceSummary(rows);
  return (
    <Card title={<span>Evidence <Badge>{sum.total}</Badge></span>} help={<Help>Brochures, floor plans, photos, emails and quotes behind this analysis. Mark items verified, or conflicting when sources disagree.</Help>}>
      {sum.hasConflict ? <StaleBanner>Conflicting information: {sum.conflicting} item(s) disagree with other sources. Resolve before sharing figures.</StaleBanner> : null}
      {rows.length === 0 ? <p className="text-sm text-ink-soft">No evidence attached yet. Add the quote, brochure or floor plan you relied on.</p> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r, i) => (
            <li key={r.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{links[i] ? <a className="text-brand" href={links[i]!} target="_blank" rel="noreferrer">{r.title}</a> : r.title} <span className="text-xs text-ink-soft">· {r.kind.replace("_", " ")}{r.source_date ? ` · ${r.source_date}` : ""}</span></span>
                <Badge tone={TONE[r.verification]}>{r.verification}</Badge>
              </div>
              {r.note ? <p className="text-xs text-ink-soft">{r.note}</p> : null}
              <ActionForm action={setEvidenceVerificationAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="revalidate" value={revalidate} />
                <Select name="verification" defaultValue={r.verification} className="w-36"><option value="verified">Verified</option><option value="unverified">Unverified</option><option value="conflicting">Conflicting</option></Select>
                <Input name="note" placeholder="What conflicts / how verified" className="min-w-40 flex-1" />
                <Submit variant="secondary">Update</Submit>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3"><summary className="cursor-pointer text-sm text-brand">Add evidence</summary>
        <ActionForm action={addEvidenceAction} className="mt-2 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="analysis_id" value={analysisId} /><input type="hidden" name="revalidate" value={revalidate} />
          <Field label="Title"><Input name="title" required /></Field>
          <Field label="Kind"><Select name="kind" defaultValue="brochure">{EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</Select></Field>
          <Field label="File"><WorkspaceFileInput workspaceId={app.workspaceId} folder="evidence" accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.eml,.txt" exts={["pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "eml", "txt"]} /></Field>
          <Field label="Or link"><Input name="url" type="url" placeholder="https://" /></Field>
          <Field label="Source date"><Input name="source_date" type="date" /></Field>
          <Field label="Verification"><Select name="verification" defaultValue="unverified"><option value="unverified">Unverified</option><option value="verified">Verified</option><option value="conflicting">Conflicting</option></Select></Field>
          <div className="sm:col-span-2"><Field label="Note"><Input name="note" /></Field></div>
          <div className="sm:col-span-2"><Submit>Attach</Submit></div>
        </ActionForm>
      </details>
    </Card>
  );
}
