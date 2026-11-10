import Link from "next/link";
import { notFound } from "next/navigation";
import { Legend, MissingNote, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";
import { Panel } from "@/modules/toolkit/ui/options/parts";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis, getVersion } from "@/modules/toolkit/store";
import type { FitoutPayload } from "@/modules/toolkit/actions-fitout";
import type { FitoutResult, QuoteCompareResult } from "@/modules/toolkit/calc/fitout";
import { FitoutEditor } from "../editor";
import { FitoutResults } from "../results";
import { loadPartners } from "../data";

export default async function FitoutView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const ctx = await requirePageContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as (Record<string, any> & { versions: Record<string, any>[] }) | null;
  if (!a || a.kind !== "fitout") notFound();
  const vNum = sp.v ? Number(sp.v) : null;
  const ver = vNum && vNum !== a.current_version ? await getVersion(ctx.db, ctx.workspaceId, id, vNum) : null;
  const src = ver ?? a;
  const inputs = src.inputs as FitoutPayload;
  const outputs = src.outputs as { budget: FitoutResult; quotes: QuoteCompareResult; asOf: string };
  const partners = await loadPartners(ctx.db, ctx.workspaceId);
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow={`Fit-out budget · version ${ver ? ver.version : a.current_version} · formula ${src.formula_version}`} title={a.title}
        purpose={`Totals and partner ranking first; edit below to save a new version.${outputs.asOf ? ` Quote validity checked against ${outputs.asOf}.` : ""}`}
        back={{ href: "/toolkit/fitout", label: "All budgets" }} steps={["Add budget lines", "Add partner quotes", "Compare"]} current={2} />
      {ver ? <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">! Viewing older version {ver.version}. <Link className={btn.link} href={`/toolkit/fitout/${id}`}>Back to current</Link></div> : null}
      {!ver ? <MissingNote items={(a.missing ?? []) as string[]} /> : null}
      <Legend />
      <FitoutResults budget={outputs.budget} quotes={outputs.quotes} inputs={inputs} />
      <Panel title="Change the budget or quotes" desc="Saving creates a new version; older versions stay below."><FitoutEditor id={id} title={a.title} initial={inputs} partners={partners} /></Panel>
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2 font-medium">Earlier versions ({a.versions.length}) <span aria-hidden className="transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
        <ul className="space-y-1 border-t border-line px-4 py-3 text-sm">{a.versions.map((v) => <li key={v.version} className="flex flex-wrap items-center gap-2"><Link className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4" href={`/toolkit/fitout/${id}?v=${v.version}`}>Version {v.version}</Link> <span className="text-xs text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}{v.note ? ` — ${v.note}` : ""}</span>{v.version === a.current_version ? <Status s="approved" label="Current" /> : null}</li>)}</ul>
      </details>
    </div>
  );
}
