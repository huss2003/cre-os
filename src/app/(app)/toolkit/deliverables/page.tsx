import Link from "next/link";
import { HelpFor } from "@/components/ui";
import { EmptyState, Field, MissingNote, Status, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { generateDeliverablesAction } from "@/modules/toolkit/actions-core";
import { KIND_LABEL, deliverableFileName, type DeliverableFile } from "@/modules/toolkit/deliverables";
import { fmt } from "@/lib/util/time";
import { ReassessBanner } from "@/modules/orchestrator/ui/components";

type Row = Record<string, any>;
function H({ children }: { children: string }) {
  return <h2 className="flex items-center text-lg font-semibold text-ink">{children}<HelpFor k={children} /></h2>;
}

export default async function DeliverablesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const db = app.db, ws = app.workspaceId;
  const requirementId = typeof sp.requirement === "string" ? sp.requirement : "";
  const [reqs, analyses, done] = await Promise.all([
    db.from("requirement").select("id, title, organisation:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null).order("updated_at", { ascending: false }).limit(200),
    requirementId ? db.from("deal_analysis").select("id, kind, title, status, current_version, formula_version, missing").eq("workspace_id", ws).eq("requirement_id", requirementId).neq("kind", "deliverable").is("archived_at", null).order("kind").order("updated_at", { ascending: false }) : Promise.resolve({ data: [] as Row[] }),
    db.from("deal_analysis").select("id, title, status, current_version, inputs, outputs, missing, updated_at, requirement:requirement_id(title)").eq("workspace_id", ws).eq("kind", "deliverable").is("archived_at", null).order("updated_at", { ascending: false }).limit(30),
  ]);
  const rq = (reqs.data ?? []) as Row[];
  const an = (analyses.data ?? []) as Row[];
  const gen = (done.data ?? []) as Row[];
  return (
    <div className="mx-auto max-w-4xl space-y-10 pb-16">
      <div data-tour="toolkit-deliverables">
        <ToolHeader title="Make client documents" purpose="Turn saved analyses into an editable proposal (Word), a workbook (Excel) and a decision summary (Word). Anything incomplete, unapproved or estimated is labelled in every file."
          steps={["Choose the requirement", "Tick the analyses to include", "Generate 3 files", "Download & send yourself"]} current={requirementId ? 1 : 0} />
      </div>

      <section>
        <H>Generate deliverables</H>
        {rq.length === 0 ? <div className="mt-4"><EmptyState title="No requirements yet" text="Documents are built for one client requirement. Create one first." action={<Link href="/requirements" className={btn.primary}>Create a requirement</Link>} /></div> : (
          <>
            <form method="get" data-tour="deliv-pick" className="mt-4 grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="1. Which requirement?" htmlFor="deliv-req" required>
                <select id="deliv-req" name="requirement" defaultValue={requirementId} className={inputCls}><option value="">Choose a requirement…</option>{rq.map((r) => <option key={r.id} value={r.id}>{r.title}{r.organisation?.display_name ? ` · ${r.organisation.display_name}` : ""}</option>)}</select>
              </Field>
              <button type="submit" className={btn.secondary}>Show its analyses</button>
            </form>
            {requirementId && app.role !== "viewer" && (
              <ActionForm action={generateDeliverablesAction} className="mt-6 space-y-4 rounded-xl border border-line bg-surface p-4" dataTour="deliv-generate">
                <input type="hidden" name="requirement_id" value={requirementId} />
                <p className="font-semibold">2. Tick the analyses to include</p>
                {an.length === 0 ? <MissingNote items={["No saved analyses for this requirement"]} what="the files will contain the requirement brief only. Save analyses from the toolkit to include them." /> : (
                  <fieldset className="min-w-0 space-y-2">
                    <legend className="sr-only">Analyses to include</legend>
                    {an.map((a) => (
                      <label key={a.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-3 text-sm hover:border-brand/50 has-[:checked]:border-brand has-[:checked]:bg-brand-soft/40">
                        <input type="checkbox" name="analysis_id" value={a.id} defaultChecked={a.status === "approved" || a.status === "ready"} className="mt-0.5 size-5 accent-[var(--color-brand)]" />
                        <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 font-medium">{a.title}<Status s={String(a.status)} /></span>
                          <span className="block text-xs text-ink-soft">{KIND_LABEL[a.kind] ?? a.kind} · version {a.current_version} · formula {a.formula_version ?? "—"}</span>
                          {(a.missing ?? []).length > 0 && <span className="mt-1 block text-xs text-rose-700">! Will be labelled: missing {(a.missing as string[]).join(", ")}</span>}
                          {a.status !== "approved" && !(a.missing ?? []).length && <span className="mt-1 block text-xs text-amber-800">! Will be labelled: not approved</span>}
                        </span>
                      </label>))}
                  </fieldset>
                )}
                <p className="pt-2 font-semibold">3. Cover details</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Title" htmlFor="deliv-title" hint="Leave blank for “Proposal — requirement”."><input id="deliv-title" name="title" placeholder="Proposal — requirement" className={inputCls} /></Field>
                  <Field label="Prepared for" htmlFor="deliv-for" hint="Recipient name on the cover."><input id="deliv-for" name="prepared_for" placeholder="e.g. Priya Shah, CFO" className={inputCls} /></Field>
                </div>
                <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0"><Submit className="w-full sm:w-auto">Generate 3 files</Submit></div>
              </ActionForm>
            )}
          </>
        )}
      </section>

      <section>
        <H>Generated deliverables</H>
        {gen.length === 0 ? <div className="mt-4"><EmptyState title="Nothing generated yet" text="Choose a requirement above and press “Generate 3 files”. Your documents will be listed here to download." /></div> : (
          <ul className="mt-4 space-y-3">{gen.map((d) => {
            const files = (d.outputs?.files ?? []) as DeliverableFile[];
            const used = (d.inputs?.analyses ?? []) as Row[];
            return (
              <li key={d.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-semibold">{d.title}{(d.missing ?? []).length > 0 ? <Status s="needs_info" label="Labelled incomplete" /> : null}</p>
                <p className="text-xs text-ink-soft">{d.requirement?.title ?? "—"} · {fmt(d.updated_at)} IST · built from {used.length ? used.map((u) => `${u.title} v${u.version}`).join(", ") : "the brief only"}</p>
                {(d.missing ?? []).length > 0 && <p className="mt-1 text-xs text-rose-700">Gaps: {(d.missing as string[]).join("; ")}</p>}
                <div className="mt-2"><ReassessBanner ctx={app} entityType="deal_analysis" entityId={d.id} /></div>
                <p className="mt-3 flex flex-wrap gap-2">{files.map((f, i) => { const n = deliverableFileName(f, i); return <a key={`${n}-${i}`} className={btn.secondary} href={`/toolkit/deliverables/${d.id}/${encodeURIComponent(n)}`}>↓ {f.label.replace(/\s*\(print\)$/, "")} ({f.kind.toUpperCase()})</a>; })}</p>
              </li>);
          })}</ul>
        )}
      </section>
    </div>
  );
}
