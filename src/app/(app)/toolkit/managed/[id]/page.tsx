import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, PageHeader } from "@/components/ui";
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
    <div className="space-y-5">
      <PageHeader title={a.title} subtitle={<>Conventional vs managed · v{viewing} of {a.current_version} · {formula} {reproducible === true ? <Badge tone="ok">reproduced</Badge> : reproducible === false ? <Badge tone="bad">does not reproduce</Badge> : null}</>}
        actions={<ButtonLink variant="secondary" href="/toolkit/managed">All comparisons</ButtonLink>} />
      {ver ? <p className="text-sm text-warn">You are viewing an older version. Saving below creates a new version from these inputs.</p> : null}
      <ManagedResults r={outputs} />
      <Card title="Edit inputs"><ManagedForm id={id} title={a.title} inputs={inputs} /></Card>
      <VersionList base="/toolkit/managed" id={id} versions={a.versions} current={a.current_version} viewing={viewing} />
    </div>
  );
}
