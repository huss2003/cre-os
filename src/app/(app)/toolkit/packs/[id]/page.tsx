import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis } from "@/modules/toolkit/store";
import { PACK_BUCKET, PACKS_FORMULA } from "@/modules/toolkit/packs";
import { EvidenceList } from "../evidence-ui";

type Row = Record<string, any>;

export default async function PackView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext();
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as Row | null;
  if (!a || a.kind !== "deliverable" || a.formula_version !== PACKS_FORMULA) notFound();
  const files = (a.outputs?.files ?? []) as { label: string; kind: string; path: string; bytes: number }[];
  const links = await Promise.all(files.map(async (f) => (await ctx.db.storage.from(PACK_BUCKET).createSignedUrl(f.path, 600, { download: true })).data?.signedUrl ?? null));
  const refs = (a.inputs?.analysisRefs ?? []) as { id: string; kind: string; version: number }[];
  return (
    <div className="space-y-5">
      <PageHeader title={a.title} subtitle={<>{a.requirement?.title ?? "—"} · v{a.current_version} · <Link className="text-brand" href="/toolkit/packs">all packs</Link></>} />
      <Card title="Downloads">
        <ul className="space-y-2 text-sm">
          {files.map((f, i) => <li key={f.path} className="flex items-center justify-between gap-2">{links[i] ? <a className="text-brand" href={links[i]!}>{f.label} (.{f.kind})</a> : <span>{f.label} — file unavailable</span>}<span className="text-xs text-ink-soft">{Math.round(f.bytes / 1024)} KB</span></li>)}
        </ul>
        <p className="mt-2 text-xs text-ink-soft">Links expire after 10 minutes — reload the page for fresh ones. Nothing is sent: share the files yourself.</p>
      </Card>
      <Card title="Built from">
        <ul className="space-y-1 text-sm">
          {refs.length ? refs.map((r) => <li key={r.id}>{r.kind.replace("_", " ")} <Badge>v{r.version}</Badge></li>) : <li className="text-ink-soft">No saved comparison or lease analysis was available — the deck has no comparison figures.</li>}
          {((a.outputs?.sources ?? []) as string[]).map((s) => <li key={s} className="text-xs text-ink-soft">{s}</li>)}
        </ul>
      </Card>
      <EvidenceList analysisId={a.id} revalidate={`/toolkit/packs/${a.id}`} />
    </div>
  );
}
