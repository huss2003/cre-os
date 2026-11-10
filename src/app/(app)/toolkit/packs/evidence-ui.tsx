/**
 * Reusable evidence attachments for any deal analysis. Server component: `<EvidenceList analysisId=… revalidate="/path" />`.
 * Lists items with verification labels + a conflicting-information flag, lets editors change verification, and
 * includes an upload form (file to storage <ws>/evidence/…, or a link / note).
 */
import { Card, Help, StaleBanner } from "@/components/ui";
import { Field, Status, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { addEvidenceAction, setEvidenceVerificationAction } from "@/modules/toolkit/actions-extras";
import { EVIDENCE_KINDS, evidenceLink, evidenceSummary, listEvidence } from "@/modules/toolkit/evidence";
import { WorkspaceFileInput } from "../quotes/file-upload";

const VER = { verified: { s: "approved", l: "Verified" }, unverified: { s: "unconfirmed", l: "Unverified" }, conflicting: { s: "expired", l: "Conflicting" } } as const;

export async function EvidenceList({ analysisId, revalidate }: { analysisId: string; revalidate: string }) {
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const rows = await listEvidence(ctx, analysisId);
  const links = await Promise.all(rows.map((r) => evidenceLink(ctx, r)));
  const sum = evidenceSummary(rows);
  return (
    <Card title={<span>Evidence <span className="text-sm font-normal text-ink-soft">({sum.total})</span></span>} help={<Help>Brochures, floor plans, photos, emails and quotes behind this analysis. Mark items verified, or conflicting when sources disagree.</Help>}>
      {sum.hasConflict ? <StaleBanner>Conflicting information: {sum.conflicting} item(s) disagree with other sources. Resolve before sharing figures.</StaleBanner> : null}
      {rows.length === 0 ? <p className="text-sm text-ink-soft">No evidence attached yet. Add the quote, brochure or floor plan you relied on.</p> : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r, i) => (
            <li key={r.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{links[i] ? <a className={btn.link} href={links[i]!} target="_blank" rel="noreferrer">{r.title}</a> : r.title} <span className="text-xs text-ink-soft">· {r.kind.replace("_", " ")}{r.source_date ? ` · ${r.source_date}` : ""}</span></span>
                <Status s={VER[r.verification as keyof typeof VER]?.s ?? r.verification} label={VER[r.verification as keyof typeof VER]?.l} />
              </div>
              {r.note ? <p className="text-xs text-ink-soft">{r.note}</p> : null}
              <ActionForm action={setEvidenceVerificationAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="revalidate" value={revalidate} />
                <label className="sr-only" htmlFor={`ev-v-${r.id}`}>Verification</label><select id={`ev-v-${r.id}`} name="verification" defaultValue={r.verification} className={`${inputCls} w-40`}><option value="verified">Verified</option><option value="unverified">Unverified</option><option value="conflicting">Conflicting</option></select>
                <label className="sr-only" htmlFor={`ev-n-${r.id}`}>Note</label><input id={`ev-n-${r.id}`} name="note" placeholder="✎ What conflicts / how verified" className={`${inputCls} min-w-40 flex-1`} />
                <Submit variant="secondary">Update</Submit>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <details className="mt-4"><summary className={`${btn.secondary} cursor-pointer list-none`}>+ Add evidence</summary>
        <ActionForm action={addEvidenceAction} className="mt-2 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="analysis_id" value={analysisId} /><input type="hidden" name="revalidate" value={revalidate} />
          <Field label="Title" htmlFor="ev-title" required><input id="ev-title" name="title" required className={inputCls} /></Field>
          <Field label="Kind" htmlFor="ev-kind" required><select id="ev-kind" name="kind" defaultValue="brochure" className={inputCls}>{EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select></Field>
          <Field label="File" hint="Upload a file, or give a link instead."><WorkspaceFileInput workspaceId={app.workspaceId} folder="evidence" accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.eml,.txt" exts={["pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "eml", "txt"]} /></Field>
          <Field label="…or link" htmlFor="ev-url"><input id="ev-url" name="url" type="url" placeholder="https://" className={inputCls} /></Field>
          <Field label="Source date" htmlFor="ev-date"><input id="ev-date" name="source_date" type="date" className={inputCls} /></Field>
          <Field label="Verification" htmlFor="ev-ver" required><select id="ev-ver" name="verification" defaultValue="unverified" className={inputCls}><option value="unverified">Unverified</option><option value="verified">Verified</option><option value="conflicting">Conflicting</option></select></Field>
          <div className="sm:col-span-2"><Field label="Note" htmlFor="ev-note"><input id="ev-note" name="note" className={inputCls} /></Field></div>
          <div className="sm:col-span-2"><Submit>Attach</Submit></div>
        </ActionForm>
      </details>
    </Card>
  );
}
