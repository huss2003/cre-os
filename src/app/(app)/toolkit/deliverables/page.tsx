import Link from "next/link";
import { HelpFor, Input, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { generateDeliverablesAction } from "@/modules/toolkit/actions-core";
import { KIND_LABEL, type DeliverableFile } from "@/modules/toolkit/deliverables";

type Row = Record<string, any>;
function H({ children }: { children: string }) {
  return <h2 className="flex items-center border-b border-ink pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-ink">{children}<HelpFor k={children} /></h2>;
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
      <header>
        <Link href="/toolkit" className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">← Deal toolkit</Link>
        <h1 className="mt-2 font-serif text-3xl text-ink">Client deliverables</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">Choose a requirement and the analyses to include. You get an editable proposal (Word), a workbook with one sheet per analysis (Excel) and a decision summary (Word). Figures from analyses that are missing information, not approved or based on estimates are labelled in every file.</p>
      </header>

      <section>
        <H>Generate deliverables</H>
        {rq.length === 0 ? <p className="py-4 text-sm text-ink-soft">No requirements yet. Create one under <Link className="text-brand underline" href="/requirements">Deals → Requirements</Link> first.</p> : (
          <>
            <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-sm"><span className="text-ink-soft">Requirement</span>
                <Select name="requirement" defaultValue={requirementId} className="min-w-64"><option value="">— choose —</option>{rq.map((r) => <option key={r.id} value={r.id}>{r.title}{r.organisation?.display_name ? ` · ${r.organisation.display_name}` : ""}</option>)}</Select></label>
              <button type="submit" className="rounded-lg border border-line px-3 py-2 text-sm hover:border-brand">Show analyses</button>
            </form>
            {requirementId && app.role !== "viewer" && (
              <ActionForm action={generateDeliverablesAction} className="mt-6 space-y-4">
                <input type="hidden" name="requirement_id" value={requirementId} />
                {an.length === 0 ? <p className="text-sm text-ink-soft">No saved analyses for this requirement yet — the files will contain the requirement brief only. Save analyses from the toolkit sections to include them.</p> : (
                  <fieldset className="divide-y divide-line border-y border-line">
                    <legend className="sr-only">Analyses to include</legend>
                    {an.map((a) => (
                      <label key={a.id} className="flex cursor-pointer items-start gap-3 py-3 text-sm">
                        <input type="checkbox" name="analysis_id" value={a.id} defaultChecked={a.status === "approved" || a.status === "ready"} className="mt-1" />
                        <span><span className="font-medium">{a.title}</span>
                          <span className="block text-xs text-ink-soft">{KIND_LABEL[a.kind] ?? a.kind} · v{a.current_version} · {a.formula_version ?? "—"} · {String(a.status).replace(/_/g, " ")}</span>
                          {(a.missing ?? []).length > 0 && <span className="block text-xs text-bad">Will be labelled: missing {(a.missing as string[]).join(", ")}</span>}
                          {a.status !== "approved" && !(a.missing ?? []).length && <span className="block text-xs text-warn">Will be labelled: not approved</span>}
                        </span>
                      </label>))}
                  </fieldset>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input name="title" placeholder="Title (default: Proposal — requirement)" aria-label="Title" />
                  <Input name="prepared_for" placeholder="Prepared for (recipient name)" aria-label="Prepared for" />
                </div>
                <Submit>Generate 3 files</Submit>
              </ActionForm>
            )}
          </>
        )}
      </section>

      <section>
        <H>Generated deliverables</H>
        {gen.length === 0 ? <p className="py-4 text-sm text-ink-soft">Nothing generated yet.</p> : (
          <ul className="divide-y divide-line">{gen.map((d) => {
            const files = (d.outputs?.files ?? []) as DeliverableFile[];
            const used = (d.inputs?.analyses ?? []) as Row[];
            return (
              <li key={d.id} className="py-4 text-sm">
                <p className="font-medium">{d.title}</p>
                <p className="text-xs text-ink-soft">{d.requirement?.title ?? "—"} · {String(d.updated_at).slice(0, 16).replace("T", " ")} · built from {used.length ? used.map((u) => `${u.title} v${u.version}`).join(", ") : "the brief only"}</p>
                {(d.missing ?? []).length > 0 && <p className="text-xs text-bad">Labelled incomplete: {(d.missing as string[]).join("; ")}</p>}
                <p className="mt-2 flex flex-wrap gap-4">{files.map((f) => <a key={f.name} className="text-brand underline-offset-2 hover:underline" href={`/toolkit/deliverables/${d.id}/${encodeURIComponent(f.name)}`}>{f.label} ({f.kind.toUpperCase()}) ↓</a>)}</p>
              </li>);
          })}</ul>
        )}
      </section>
    </div>
  );
}
