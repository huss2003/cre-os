import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Stat, StaleBanner, Select, Input, MoreFields } from "@/components/ui";
import { Flash } from "@/modules/intelligence/ui";
import { qualityReport, listChanges, listRecommendations, memCtxFromTool, LIFECYCLE_STATUSES } from "@/modules/intelligence/memory/integrate";
import { scanAction, changeStateAction, recStateAction, correctAction } from "./actions";

/** Module 13 §12 memory quality + §6 detected changes + §9 recommendations (one review page). Mobile-first. */
export default async function MemoryQualityPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const mc = memCtxFromTool(ctx);
  const [report, changes, recs] = await Promise.all([
    qualityReport(mc),
    listChanges(mc, { limit: 30 }).catch(() => null),
    listRecommendations(mc, { limit: 15 }).catch(() => null),
  ]);
  const tone = (c: string) => (c === "high" ? "ok" : c === "medium" ? "warn" : "neutral") as "ok" | "warn" | "neutral";

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Memory quality" subtitle="What CRE OS remembers that is outdated, missing, contradictory, unverified or unsourced — plus changes it detected and suggested next actions. Nothing here changes your records or sends anything."
        actions={canEdit ? <form action={scanAction}><Button type="submit" variant="secondary">Scan for changes</Button></form> : null} />
      <Flash sp={sp} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Items to look at" value={report.total} hint={report.unavailable ? `${report.unavailable} check(s) could not run` : "Across all checks"} />
        <Stat label="Open changes" value={changes ? changes.length : "—"} />
        <Stat label="Recommendations" value={recs ? recs.length : "—"} />
        <Stat label="Checks" value={report.checks.length} />
      </div>

      <Card title="Quality checks" className="mb-4" help="Counts are exact; each list shows up to 10 examples.">
        <ul className="-my-1 divide-y divide-line">
          {report.checks.map((c) => (
            <li key={c.key} id={`q-${c.key}`} className="py-3">
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 sm:min-h-0">
                  <span className="min-w-0"><span className="font-medium">{c.label}</span><span className="block text-xs text-ink-soft">{c.help}</span></span>
                  {c.error ? <Badge tone="bad">Unavailable</Badge> : <Badge tone={c.count ? "warn" : "ok"}>{c.count}</Badge>}
                </summary>
                {c.error ? <StaleBanner>This check could not run ({c.error}). The count is unknown, not zero.</StaleBanner> : c.items.length ? (
                  <ul className="mt-2 space-y-1 text-sm">
                    {c.items.map((it, i) => (
                      <li key={i} className="break-words">{it.href ? <Link href={it.href} className="text-brand">{it.label}</Link> : it.label}{it.detail ? <span className="text-ink-soft"> — {it.detail}</span> : null}</li>
                    ))}
                    {(c.count ?? 0) > c.items.length ? <li className="text-xs text-ink-soft">Showing {c.items.length} of {c.count}.</li> : null}
                  </ul>
                ) : <p className="mt-2 text-sm text-ink-soft">Nothing found.</p>}
              </details>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Detected changes" className="mb-4" help="Previous and latest values are both kept. Run a scan, or changes appear automatically when new records arrive.">
        {!changes ? <StaleBanner>Changes could not be loaded.</StaleBanner> : !changes.length ? (
          <EmptyState title="No open changes">When requirements, employment, leases, availability or quotes change, the difference shows here with its date and source. {canEdit ? "Use “Scan for changes” to check now." : null}</EmptyState>
        ) : (
          <ul className="-my-1 divide-y divide-line">
            {changes.map((c) => (
              <li key={c.id} id={`c-${c.id}`} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={c.material ? "warn" : "neutral"}>{c.label}</Badge><Badge>{c.verification}</Badge>{c.changedAt ? <span className="text-xs text-ink-soft">{String(c.changedAt).slice(0, 10)}</span> : <span className="text-xs text-ink-soft">date unknown</span>}</div>
                <p className="mt-1 break-words">{c.difference.text}</p>
                <p className="text-xs text-ink-soft">Source: {c.source?.href ? <Link className="text-brand" href={c.source.href}>{c.source.label ?? "record"}</Link> : c.source?.label ?? "not recorded"}{c.affectedOpportunityIds.length ? ` · ${c.affectedOpportunityIds.length} opportunit${c.affectedOpportunityIds.length === 1 ? "y" : "ies"} flagged for review` : ""}{c.modules.length ? ` · notifies ${c.modules.join(", ")}` : ""}</p>
                {Array.isArray(c.impact?.caveats) ? <p className="text-xs text-warn">{(c.impact.caveats as string[]).join(" ")}</p> : null}
                {canEdit ? (
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <form action={changeStateAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="state" value="acknowledged" /><Button type="submit" variant="secondary">Acknowledge</Button></form>
                    <form action={changeStateAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="state" value="dismissed" /><Button type="submit" variant="ghost">Dismiss</Button></form>
                    <MoreFields label="Correct status">
                      <form action={correctAction} className="flex flex-wrap gap-2">
                        <input type="hidden" name="entity_type" value={c.entityType} /><input type="hidden" name="entity_id" value={c.entityId} />
                        <input type="hidden" name="category" value={c.kind} /><input type="hidden" name="item_key" value={`change:${c.id}`} />
                        <Select name="status" defaultValue="unverified" aria-label="Status">{LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
                        <Input name="note" required placeholder="Why (kept in history)" aria-label="Reason" />
                        <Button type="submit" variant="secondary">Save</Button>
                      </form>
                    </MoreFields>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recommended next actions" help="Suggestions only — each shows why, the evidence and its sources. Nothing is executed for you.">
        {!recs ? <StaleBanner>Recommendations could not be loaded.</StaleBanner> : !recs.length ? (
          <EmptyState title="No recommendations right now">They appear when requirements go unreviewed, decision-makers change, quotes get old, deals go quiet or buildings are repeatedly rejected for the same reason.</EmptyState>
        ) : (
          <ul className="-my-1 divide-y divide-line">
            {recs.map((r) => (
              <li key={r.ref} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.href ? <Link className="text-brand" href={r.href}>{r.title}</Link> : r.title}</span><Badge tone={tone(r.confidence)}>{r.confidence} confidence</Badge></div>
                <p className="mt-1">{r.why}</p>
                {r.supporting.length ? <ul className="ml-4 list-disc text-xs text-ink-soft">{r.supporting.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
                <p className="mt-1"><span className="text-ink-soft">Next: </span>{r.nextAction}</p>
                {r.sourceRefs.length ? <p className="text-xs text-ink-soft">Sources: {r.sourceRefs.slice(0, 3).map((s, i) => <span key={i}>{i ? ", " : ""}{s.href ? <Link className="text-brand" href={s.href}>{s.label}</Link> : s.label}</span>)}</p> : null}
                {canEdit && r.persistedId ? (
                  <div className="mt-2 flex gap-2">
                    <form action={recStateAction}><input type="hidden" name="id" value={r.persistedId} /><input type="hidden" name="state" value="done" /><Button type="submit" variant="secondary">Done</Button></form>
                    <form action={recStateAction}><input type="hidden" name="id" value={r.persistedId} /><input type="hidden" name="state" value="dismissed" /><Button type="submit" variant="ghost">Dismiss</Button></form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
