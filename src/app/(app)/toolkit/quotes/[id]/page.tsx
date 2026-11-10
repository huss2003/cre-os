import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Help, StaleBanner } from "@/components/ui";
import { Certainty, Field, MissingNote, Status, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { discardQuoteIntakeAction, saveQuoteIntakeAction } from "@/modules/toolkit/actions-extras";
import { TERM_FIELDS, diffTerms, isExpired, loadIntake, termsFromQuote, type QuoteTerms } from "@/modules/toolkit/quote-intake";

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
const DIFF = { changed: { s: "pending", l: "Changed" }, added: { s: "eligible", l: "New" }, removed: { s: "expired", l: "Removed" }, missing: { s: "needs_info", l: "Missing" }, same: { s: "", l: "" } } as const;

export default async function IntakeReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await requirePageContext();
  const loaded = await loadIntake(toDealsCtx(app), id);
  if (!loaded) notFound();
  const { intake, latest } = loaded;
  const extracted = intake.extracted as QuoteTerms;
  const before = latest ? termsFromQuote(latest) : null;
  const { rows, changed, missing } = diffTerms(before, extracted);
  const asOf = localDate();
  const editable = intake.status === "review";
  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <ToolHeader back={{ href: "/toolkit/quotes", label: "All quotes" }} eyebrow={`${intake.requirement?.title ?? "—"} · ${intake.file_name ?? "pasted text"}`}
        title="Check the quote terms" purpose="We read these terms from the quote. Compare them with the last saved version, correct anything wrong, then save."
        steps={["Add the quote", "Check the extracted terms", "Save as a new version"]} current={editable ? 1 : 2} />
      {(intake.notes as string[]).map((n, i) => <StaleBanner key={i}>{n}</StaleBanner>)}
      {isExpired(extracted.valid_until, asOf) ? <StaleBanner>This quote&apos;s validity ({extracted.valid_until}) has already passed.</StaleBanner> : null}
      {latest?.approved_at ? <StaleBanner>The latest version (v{latest.version}) is approved: saving sends the new version for review instead of saving it directly.</StaleBanner> : null}

      <Card title={<span className="flex flex-wrap items-center gap-2">Compare with {latest ? `saved version ${latest.version}` : "— new quote"} {changed.length ? <Status s="pending" label={`${changed.length} changed`} /> : null}</span>}
        help={<Help>Changed values are highlighted. Missing essential terms are listed below — ask the provider rather than assuming.</Help>}>
        {missing.length ? <div className="mb-3"><MissingNote items={missing} what="ask the provider rather than assuming" /></div> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-soft"><th className="py-1.5 pr-2">Term</th><th className="pr-2">Saved before</th><th className="pr-2">Read from this quote</th><th>What changed</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.key} className={r.status === "changed" || r.status === "removed" ? "bg-warn/10" : r.status === "added" ? "bg-ok/5" : ""}>
                  <td className="py-1.5 pr-2 font-medium">{r.label}</td><td className="pr-2 text-ink-soft">{show(r.before)}</td><td className="pr-2">{r.after === null || r.after === undefined || r.after === "" ? <Certainty c="missing" /> : show(r.after)}</td>
                  <td>{r.status !== "same" ? <Status s={DIFF[r.status].s} label={DIFF[r.status].l} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {editable ? (
        <Card title="✎ Correct and save" help={<Help>Blank stays unknown — it is never saved as zero. Saving creates a new version; the old one is kept and anything built on it is marked stale.</Help>}>
          <ActionForm action={saveQuoteIntakeAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intake_id" value={intake.id} />
            {TERM_FIELDS.map((f) => {
              const v = extracted[f.key];
              const dv = v === null || v === undefined ? "" : String(v);
              return (
                <Field key={f.key} label={f.label} htmlFor={`t_${f.key}`} required={!!f.essential} hint={f.essential ? "Essential — leave blank if unknown, never 0." : undefined}>
                  {f.kind === "enum" || f.kind === "bool" ? (
                    <select id={`t_${f.key}`} name={`t_${f.key}`} defaultValue={dv} className={inputCls}><option value="">Unknown</option>{(f.kind === "bool" ? ["true", "false"] : f.options!).map((o) => <option key={o} value={o}>{o === "true" ? "Yes" : o === "false" ? "No" : o}</option>)}</select>
                  ) : <input id={`t_${f.key}`} name={`t_${f.key}`} defaultValue={dv} placeholder="Unknown" className={inputCls} type={f.kind === "date" ? "date" : "text"} inputMode={f.kind === "number" ? "decimal" : undefined} />}
                </Field>
              );
            })}
            <div className="sticky bottom-0 -mx-4 flex flex-wrap gap-2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:col-span-2 sm:m-0 sm:border-0 sm:bg-transparent sm:p-0"><Submit className="w-full sm:w-auto">{latest?.approved_at ? "Send new version for review" : latest ? `Save as v${latest.version + 1}` : "Save as new quote"}</Submit></div>
          </ActionForm>
          <ActionForm action={discardQuoteIntakeAction} className="mt-2"><input type="hidden" name="intake_id" value={intake.id} /><Submit variant="ghost" confirm="Discard this intake?">Discard this quote</Submit></ActionForm>
        </Card>
      ) : <Card><p className="flex flex-wrap items-center gap-2 text-sm">This quote is {intake.status === "saved" ? <Status s="approved" label="Saved" /> : <Status s={String(intake.status)} />} <Link className={btn.link} href="/toolkit/quotes">Back to all quotes</Link></p></Card>}

      <Card title="Original quote text"><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-ink-soft">{intake.source_text || "—"}</pre></Card>
    </div>
  );
}
