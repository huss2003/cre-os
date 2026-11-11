import Link from "next/link";
import { PageHeader, Stat } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listChanges, listRecommendations, memCtxFromTool, qualityReport } from "@/modules/intelligence/memory/integrate";

export const metadata = { title: "Intelligence" };

/** Module 13 landing: one place for recommendations, detected changes, the timeline and memory quality. Read-only. */
export default async function IntelligencePage() {
  const ctx = await requirePageContext();
  const mc = memCtxFromTool(ctx);
  const [recs, changes, quality] = await Promise.all([
    listRecommendations(mc, { limit: 200 }).catch(() => null),
    listChanges(mc, { limit: 200 }).catch(() => null),
    qualityReport(mc).catch(() => null),
  ]);
  const cards: { href: string; title: string; text: string; value: string }[] = [
    { href: "/intelligence/recommendations", title: "Recommendations", text: "Suggested next actions with the reason, evidence and sources. Nothing runs by itself.", value: recs ? String(recs.length) : "—" },
    { href: "/intelligence/changes", title: "Changes", text: "Important changes detected in your records: previous → latest value, when, and from where.", value: changes ? String(changes.length) : "—" },
    { href: "/intelligence/timeline", title: "Timeline", text: "Conversations and changes for a company, contact, building, requirement or deal, newest first.", value: "" },
    { href: "/intelligence/quality", title: "Memory quality", text: "What is outdated, missing, contradictory, unverified or unsourced — and a scan for new changes.", value: quality ? String(quality.total) : "—" },
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Intelligence" subtitle="What CRE OS has learned from your records. Every item links to its source; unknown stays unknown." />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Open recommendations" value={recs ? recs.length : "—"} hint={recs ? undefined : "Couldn't load"} />
        <Stat label="Open changes" value={changes ? changes.length : "—"} hint={changes ? undefined : "Couldn't load"} />
        <Stat label="Quality items" value={quality ? quality.total : "—"} hint={quality ? undefined : "Couldn't load"} />
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <li key={c.href}><Link href={c.href} className="block min-h-11 rounded-xl border border-line bg-surface p-4 hover:bg-canvas">
            <p className="flex items-center justify-between font-semibold"><span>{c.title}</span>{c.value ? <span className="text-sm font-normal text-ink-soft">{c.value}</span> : null}</p>
            <p className="mt-1 text-sm text-ink-soft">{c.text}</p>
          </Link></li>
        ))}
      </ul>
      {recs && !recs.length && changes && !changes.length ? <p className="text-sm text-ink-soft">Nothing yet. Add companies, contacts and requirements (or import a spreadsheet), then run <Link className="text-brand underline" href="/intelligence/quality">Scan for changes</Link>.</p> : null}
    </div>
  );
}
