import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Help, Input, PageHeader, Select, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { toDealsCtx } from "@/modules/deals/api";
import { discardQuoteIntakeAction, saveQuoteIntakeAction } from "@/modules/toolkit/actions-extras";
import { TERM_FIELDS, diffTerms, isExpired, loadIntake, termsFromQuote, type QuoteTerms } from "@/modules/toolkit/quote-intake";

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
const TONE = { changed: "warn", added: "ok", removed: "bad", missing: "neutral", same: "neutral" } as const;

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
    <div className="space-y-5">
      <PageHeader title="Review extracted quote" subtitle={<>{intake.requirement?.title ?? "—"} · {intake.file_name ?? "pasted text"} · <Link className="text-brand" href="/toolkit/quotes">all quotes</Link></>} />
      {(intake.notes as string[]).map((n, i) => <StaleBanner key={i}>{n}</StaleBanner>)}
      {isExpired(extracted.valid_until, asOf) ? <StaleBanner>This quote&apos;s validity ({extracted.valid_until}) has already passed.</StaleBanner> : null}
      {latest?.approved_at ? <StaleBanner>The latest version (v{latest.version}) is approved: saving sends the new version for review instead of saving it directly.</StaleBanner> : null}

      <Card title={<span>Compare with {latest ? `saved v${latest.version}` : "— new quote"} {changed.length ? <Badge tone="warn">{changed.length} changed</Badge> : null}</span>}
        help={<Help>Changed values are highlighted. Missing essential terms are listed below — ask the provider rather than assuming.</Help>}>
        {missing.length ? <p className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">Missing: {missing.join(", ")}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-soft"><th className="py-1.5 pr-2">Term</th><th className="pr-2">Saved</th><th className="pr-2">Extracted</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.key} className={r.status === "changed" || r.status === "removed" ? "bg-warn/10" : r.status === "added" ? "bg-ok/5" : ""}>
                  <td className="py-1.5 pr-2 font-medium">{r.label}</td><td className="pr-2 text-ink-soft">{show(r.before)}</td><td className="pr-2">{show(r.after)}</td>
                  <td>{r.status !== "same" ? <Badge tone={TONE[r.status]}>{r.status}</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {editable ? (
        <Card title="Correct and save" help={<Help>Blank stays unknown — it is never saved as zero. Saving creates a new version; the old one is kept and anything built on it is marked stale.</Help>}>
          <ActionForm action={saveQuoteIntakeAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intake_id" value={intake.id} />
            {TERM_FIELDS.map((f) => {
              const v = extracted[f.key];
              const dv = v === null || v === undefined ? "" : String(v);
              return (
                <label key={f.key} className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">{f.label}{f.essential ? " *" : ""}</span>
                  {f.kind === "enum" || f.kind === "bool" ? (
                    <Select name={`t_${f.key}`} defaultValue={dv}><option value="">Unknown</option>{(f.kind === "bool" ? ["true", "false"] : f.options!).map((o) => <option key={o} value={o}>{o === "true" ? "Yes" : o === "false" ? "No" : o}</option>)}</Select>
                  ) : <Input name={`t_${f.key}`} defaultValue={dv} type={f.kind === "date" ? "date" : "text"} inputMode={f.kind === "number" ? "decimal" : undefined} />}
                </label>
              );
            })}
            <div className="flex flex-wrap gap-2 sm:col-span-2"><Submit>{latest?.approved_at ? "Send new version for review" : latest ? `Save as v${latest.version + 1}` : "Save as new quote"}</Submit></div>
          </ActionForm>
          <ActionForm action={discardQuoteIntakeAction} className="mt-2"><input type="hidden" name="intake_id" value={intake.id} /><Submit variant="ghost" confirm="Discard this intake?">Discard</Submit></ActionForm>
        </Card>
      ) : <Card><p className="text-sm">This intake is <Badge>{intake.status}</Badge>.</p></Card>}

      <Card title="Source text"><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-ink-soft">{intake.source_text || "—"}</pre></Card>
    </div>
  );
}
