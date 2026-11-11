import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { ToolHeader, btn } from "@/modules/toolkit/ui/kit";
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
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <ToolHeader back={{ href: "/toolkit/packs", label: "All packs" }} eyebrow={`${a.requirement?.title ?? "—"} · version ${a.current_version}`} title={a.title}
        purpose="Download the files and share them yourself — nothing is sent from here. Attach the evidence you relied on below."
        steps={["Choose the requirement", "Tick the buildings", "Generate the files", "Download"]} current={3} />
      <Card title="Downloads">
        <ul className="space-y-3 text-sm">
          {files.map((f, i) => <li key={f.path} className="flex items-center justify-between gap-2">{links[i] ? <a className={btn.primary} href={links[i]!}>↓ {f.label} (.{f.kind})</a> : <span className="text-ink-soft">{f.label} — file unavailable</span>}<span className="text-xs text-ink-soft">{Math.round(f.bytes / 1024)} KB</span></li>)}
        </ul>
        <p className="mt-2 text-xs text-ink-soft">Links expire after 10 minutes — reload the page for fresh ones. Nothing is sent: share the files yourself.</p>
      </Card>
      <Card title="Built from">
        <ul className="space-y-1 text-sm">
          {refs.length ? refs.map((r) => <li key={r.id}>{r.kind.replace("_", " ")} · version {r.version}</li>) : <li className="text-ink-soft">No saved comparison or lease analysis was available — the deck has no comparison figures.</li>}
          {((a.outputs?.sources ?? []) as string[]).map((s) => <li key={s} className="text-xs text-ink-soft">{s}</li>)}
        </ul>
      </Card>
      <EvidenceList analysisId={a.id} revalidate={`/toolkit/packs/${a.id}`} />
    </div>
  );
}
