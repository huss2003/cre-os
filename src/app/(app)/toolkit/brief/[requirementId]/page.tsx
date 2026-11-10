import Link from "next/link";
import { notFound } from "next/navigation";
import { HelpFor, Input, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { approveAnalysisAction, saveBriefSnapshotAction, updateBriefFieldAction } from "@/modules/toolkit/actions-core";
import type { BriefLabel } from "@/modules/toolkit/brief";
import { loadBriefFor } from "@/modules/toolkit/deliverables";
import { getAnalysis } from "@/modules/toolkit/store";

const TONE: Record<BriefLabel, string> = {
  Confirmed: "text-ok border-ok/40", Estimated: "text-accent border-accent/40", Assumption: "text-warn border-warn/40", Missing: "text-bad border-bad/40", "Not applicable": "text-ink-soft border-line",
};
const Label = ({ s }: { s: BriefLabel }) => <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[s]}`}>{s}</span>;
function H({ children }: { children: string }) {
  return <h2 className="flex items-center border-b border-ink pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-ink">{children}<HelpFor k={children} /></h2>;
}

export default async function BriefPage({ params }: { params: Promise<{ requirementId: string }> }) {
  const { requirementId } = await params;
  const app = await requirePageContext();
  let brief;
  try { brief = await loadBriefFor(app.db, app.workspaceId, requirementId); } catch { notFound(); }
  const snap = (await app.db.from("deal_analysis").select("id").eq("workspace_id", app.workspaceId).eq("kind", "brief").eq("requirement_id", requirementId).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data as { id: string } | null;
  const analysis = snap ? (await getAnalysis(app.db, app.workspaceId, snap.id)) as (Record<string, any> & { versions: Record<string, any>[] }) | null : null;
  const canEdit = app.role !== "viewer";
  const back = `/toolkit/brief/${requirementId}`;
  return (
    <div className="mx-auto max-w-4xl space-y-10 pb-16">
      <header>
        <Link href="/toolkit/brief" className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">← Requirement briefs</Link>
        <h1 className="mt-2 font-serif text-3xl leading-tight text-ink">{brief.title}</h1>
        <p className="mt-1 text-sm text-ink-soft">{brief.organisation ?? "No organisation linked"} · <Link className="underline" href={`/requirements/${requirementId}`}>open requirement</Link></p>
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {(Object.keys(brief.counts) as BriefLabel[]).map((k) => <span key={k}><span className="font-semibold tabular-nums">{brief.counts[k]}</span> <span className="text-ink-soft">{k.toLowerCase()}</span></span>)}
        </p>
      </header>

      {brief.sections.map((s) => (
        <section key={s.id}>
          <H>{s.title}</H>
          {s.notes?.map((n) => <p key={n} className="mt-2 text-xs text-ink-soft">{n}</p>)}
          <dl className="divide-y divide-line">
            {s.fields.map((f) => (
              <div key={f.key} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-sm text-ink-soft">{f.label}</dt>
                  <Label s={f.status} />
                </div>
                <dd className={`mt-0.5 text-[15px] ${f.value ? "text-ink" : "italic text-ink-soft"}`}>{f.value ?? "Not known yet"}</dd>
                {canEdit && (
                  <details className="mt-1 text-sm">
                    <summary className="cursor-pointer text-xs text-brand">Edit</summary>
                    <ActionForm action={updateBriefFieldAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_12rem]">
                      <input type="hidden" name="requirement_id" value={requirementId} />
                      <input type="hidden" name="row_version" value={brief.rowVersion} />
                      <input type="hidden" name="key" value={f.key} />
                      <Input name="value" defaultValue={f.value ?? ""} placeholder={f.key === "area" || f.key === "seats" ? "min, target, max" : f.key === "budget" ? "min, max" : ""} aria-label={f.label} />
                      <Select name="status" defaultValue={f.status === "Assumption" ? "reported" : "estimated"} aria-label="How sure">
                        <option value="estimated">Estimated (our estimate)</option>
                        <option value="reported">Assumption (heard second-hand)</option>
                        <option value="client_confirmed">Confirmed by client — needs approval</option>
                      </Select>
                      <Input name="evidence" placeholder="If confirmed: how (meeting date, email reference)" className="sm:col-span-2" />
                      <div><Submit variant="secondary">Save</Submit></div>
                    </ActionForm>
                  </details>
                )}
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section>
        <H>Brief stakeholders</H>
        <dl className="divide-y divide-line">
          {brief.stakeholders.map((s) => (
            <div key={s.slot} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
              <dt className="text-sm text-ink-soft">{s.slot}</dt>
              <dd className="text-sm">{s.people.length ? s.people.join(", ") : <Label s="Missing" />}</dd>
            </div>
          ))}
        </dl>
        {brief.stakeholderGaps.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-warn">{brief.stakeholderGaps.map((g) => <li key={g}>{g}</li>)}</ul>}
        <p className="mt-2 text-xs text-ink-soft">Add people and roles on the <Link className="underline" href={`/requirements/${requirementId}`}>requirement page</Link>.</p>
      </section>

      <section>
        <H>Meeting outcomes</H>
        {brief.meetings.length === 0 ? <p className="py-3 text-sm text-ink-soft">No meeting outcomes linked to this requirement yet. Record outcomes after meetings in Meetings.</p> : (
          <ul className="divide-y divide-line">{brief.meetings.map((m, i) => (
            <li key={i} className="py-3 text-sm">
              <p className="font-medium">{m.title} <span className="font-normal text-ink-soft">· {m.date ?? "no date"}{m.outcome ? ` · ${m.outcome}` : ""}</span></p>
              {m.summary && <p className="mt-1 text-ink-soft">{m.summary}</p>}
              {m.decisionProcess && <p className="mt-1 text-xs">Decision process: {m.decisionProcess}</p>}
              {m.commitments.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">{m.commitments.map((c) => <li key={c}>{c}</li>)}</ul>}
            </li>))}</ul>
        )}
      </section>

      <section>
        <H>Open questions</H>
        {brief.openQuestions.length === 0 ? <p className="py-3 text-sm text-ink-soft">Nothing left to ask.</p> : (
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">{brief.openQuestions.map((q) => (
            <li key={q.key}>{q.question} <span className="text-xs text-ink-soft">({q.priority}{q.reason === "estimated_needs_confirmation" ? ", needs client confirmation" : ""})</span></li>))}</ol>
        )}
      </section>

      <section>
        <H>Pending approvals</H>
        {brief.pendingApprovals.length === 0 ? <p className="py-3 text-sm text-ink-soft">No changes waiting for approval.</p> : (
          <ul className="divide-y divide-line">{brief.pendingApprovals.map((p) => (
            <li key={p.id} className="flex justify-between gap-3 py-3 text-sm"><span>{p.reason ?? "Requirement change"}</span><Link className="shrink-0 text-brand" href="/approvals">{p.state} →</Link></li>))}</ul>
        )}
      </section>

      <section>
        <H>Brief snapshots</H>
        <p className="mt-2 text-sm text-ink-soft">A snapshot freezes this brief (formula brief-1.0) so proposals can cite exactly what was known. It can be approved only when no mandatory item is missing.</p>
        {analysis && (
          <p className="mt-3 text-sm">Latest: version {analysis.current_version} · <span className="font-medium">{String(analysis.status).replace(/_/g, " ")}</span>{analysis.approved_at ? ` · approved ${String(analysis.approved_at).slice(0, 10)}` : ""}
            {(analysis.missing ?? []).length > 0 && <span className="block text-xs text-bad">Missing: {(analysis.missing as string[]).join(", ")}</span>}</p>
        )}
        {canEdit && (
          <div className="mt-4 flex flex-wrap gap-6">
            <ActionForm action={saveBriefSnapshotAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="requirement_id" value={requirementId} />
              <Input name="note" placeholder="Note (optional)" className="w-56" />
              <Submit>Save brief snapshot</Submit>
            </ActionForm>
            {analysis && analysis.status === "ready" && (
              <ActionForm action={approveAnalysisAction}>
                <input type="hidden" name="analysis_id" value={analysis.id} />
                <input type="hidden" name="back" value={back} />
                <Submit variant="secondary">Approve snapshot v{analysis.current_version}</Submit>
              </ActionForm>
            )}
          </div>
        )}
        {analysis && analysis.versions.length > 0 && (
          <ul className="mt-4 space-y-1 text-xs text-ink-soft">{analysis.versions.map((v: Record<string, any>) => <li key={v.version}>v{v.version} · {v.formula_version} · {String(v.created_at).slice(0, 16).replace("T", " ")}{v.note ? ` · ${v.note}` : ""}</li>)}</ul>
        )}
      </section>
    </div>
  );
}
