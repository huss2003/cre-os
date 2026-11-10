import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader, StaleBanner } from "@/components/ui";
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
    <div className="space-y-5">
      <PageHeader title={a.title} subtitle={<>Fit-out budget · formula {src.formula_version} · version {ver ? ver.version : a.current_version}{outputs.asOf ? ` · quotes checked against ${outputs.asOf}` : ""} · <Link className="text-brand" href="/toolkit/fitout">all budgets</Link></>} />
      {ver ? <StaleBanner>Viewing older version {ver.version}. <Link className="underline" href={`/toolkit/fitout/${id}`}>Back to current</Link></StaleBanner> : null}
      {(a.missing ?? []).length && !ver ? <StaleBanner>Needs information: {(a.missing as string[]).join(" · ")}</StaleBanner> : null}
      <FitoutResults budget={outputs.budget} quotes={outputs.quotes} inputs={inputs} />
      <Card title="Versions">
        <ul className="space-y-1 text-sm">{a.versions.map((v) => <li key={v.version}><Link className="text-brand" href={`/toolkit/fitout/${id}?v=${v.version}`}>v{v.version}</Link> <span className="text-xs text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}{v.note ? ` — ${v.note}` : ""}</span>{v.version === a.current_version ? <span className="ml-1"><Badge tone="ok">current</Badge></span> : null}</li>)}</ul>
      </Card>
      <Card title="Edit — saves a new version">
        <FitoutEditor id={id} title={a.title} initial={inputs} partners={partners} />
      </Card>
    </div>
  );
}
