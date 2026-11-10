import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, PageHeader } from "@/components/ui";
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
    <div className="space-y-5">
      <PageHeader title={a.title} subtitle={<>Renewal vs relocation · v{viewing} of {a.current_version} · {formula} {reproducible === true ? <Badge tone="ok">reproduced</Badge> : reproducible === false ? <Badge tone="bad">does not reproduce</Badge> : null}</>}
        actions={<ButtonLink variant="secondary" href="/toolkit/renewal">All analyses</ButtonLink>} />
      {ver ? <p className="text-sm text-warn">You are viewing an older version. Saving below creates a new version from these inputs.</p> : null}
      <RenewalResults r={outputs} />
      <Card title="Edit inputs"><RenewalForm id={id} title={a.title} inputs={inputs} /></Card>
      <VersionList base="/toolkit/renewal" id={id} versions={a.versions} current={a.current_version} viewing={viewing} />
    </div>
  );
}
