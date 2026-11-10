import { notFound } from "next/navigation";
import { Legend, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";
import { Panel } from "@/modules/toolkit/ui/options/parts";
import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis, getVersion } from "@/modules/toolkit/store";
import { stableStringify } from "@/modules/deals/finance/engine";
import { compareConventionalManaged, type CvmInput, type CvmResult } from "@/modules/toolkit/calc/managed";
import { ManagedForm } from "../_parts/form";
import { ManagedResults } from "../_parts/results";
import { VersionList, type StoredAnalysis } from "../_parts/shared";

export default async function ManagedView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const { id } = await params; const { v } = await searchParams;
  const ctx = await requirePageContext();
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as StoredAnalysis | null;
  if (!a || a.kind !== "conventional_vs_managed") notFound();
  const viewing = v ? Number(v) : a.current_version;
  const ver = viewing !== a.current_version ? await getVersion(ctx.db, ctx.workspaceId, id, viewing) : null;
  const inputs = (ver?.inputs ?? a.inputs) as CvmInput; const outputs = (ver?.outputs ?? a.outputs) as CvmResult;
  const formula = ver?.formula_version ?? a.formula_version;
  const reproducible = formula === "cvm-1.0" ? stableStringify(compareConventionalManaged(inputs)) === stableStringify(outputs) : null;
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow={`Conventional vs managed · version ${viewing} of ${a.current_version}`} title={a.title}
        purpose="Read the answer first, then the numbers behind it. Change any input below and compare again — that saves a new version."
        back={{ href: "/toolkit/managed", label: "All comparisons" }} steps={["Describe the lease option", "Describe the managed option", "Compare", "Read the recommendation"]} current={3}
        action={<span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">Formula {formula} {reproducible === true ? <Status s="approved" label="Reproduced" /> : reproducible === false ? <Status s="expired" label="Does not reproduce" /> : null}</span>} />
      {ver ? <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">! You are viewing an older version. Comparing again below creates a new version from these inputs. <Link className={btn.link} href={`/toolkit/managed/${id}`}>Back to current</Link></div> : null}
      <Legend />
      <ManagedResults r={outputs} />
      <Panel title="Change the inputs" desc="Edit either option, then press Compare again."><ManagedForm id={id} title={a.title} inputs={inputs} /></Panel>
      <VersionList base="/toolkit/managed" id={id} versions={a.versions} current={a.current_version} viewing={viewing} />
    </div>
  );
}
