import { notFound } from "next/navigation";
import Link from "next/link";
import { Legend, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";
import { Panel } from "@/modules/toolkit/ui/options/parts";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis, getVersion } from "@/modules/toolkit/store";
import { stableStringify } from "@/modules/deals/finance/engine";
import { compareRenewalRelocation, type RvrInput, type RvrResult } from "@/modules/toolkit/calc/renewal";
import { RenewalForm } from "../_parts/form";
import { RenewalResults } from "../_parts/results";
import { VersionList, type StoredAnalysis } from "../../managed/_parts/shared";

export default async function RenewalView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const { id } = await params; const { v } = await searchParams;
  const ctx = await requirePageContext();
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as StoredAnalysis | null;
  if (!a || a.kind !== "renewal_vs_relocation") notFound();
  const viewing = v ? Number(v) : a.current_version;
  const ver = viewing !== a.current_version ? await getVersion(ctx.db, ctx.workspaceId, id, viewing) : null;
  const inputs = (ver?.inputs ?? a.inputs) as RvrInput; const outputs = (ver?.outputs ?? a.outputs) as RvrResult;
  const formula = ver?.formula_version ?? a.formula_version;
  const reproducible = formula === "rvr-1.0" ? stableStringify(compareRenewalRelocation(inputs)) === stableStringify(outputs) : null;
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow={`Renewal vs relocation · version ${viewing} of ${a.current_version}`} title={a.title}
        purpose="Read the answer first, then the numbers behind it. Change any input below and compare again — that saves a new version."
        back={{ href: "/toolkit/renewal", label: "All analyses" }} steps={["Stay option", "Move option", "Compare", "Decide"]} current={3}
        action={<span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">Formula {formula} {reproducible === true ? <Status s="approved" label="Reproduced" /> : reproducible === false ? <Status s="expired" label="Does not reproduce" /> : null}</span>} />
      {ver ? <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">! You are viewing an older version. Comparing again below creates a new version from these inputs. <Link className={btn.link} href={`/toolkit/renewal/${id}`}>Back to current</Link></div> : null}
      <Legend />
      <RenewalResults r={outputs} />
      <Panel title="Change the inputs" desc="Edit Stay or Move, then press Compare again."><RenewalForm id={id} title={a.title} inputs={inputs} /></Panel>
      <VersionList base="/toolkit/renewal" id={id} versions={a.versions} current={a.current_version} viewing={viewing} />
    </div>
  );
}
