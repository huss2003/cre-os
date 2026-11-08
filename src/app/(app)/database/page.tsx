import { Suspense } from "react";
import Link from "next/link";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { databaseOverview, recentChanges, reviewQueue, type ReviewItem } from "@/modules/admin/database";
import { memberDirectory } from "@/modules/admin/entities";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Database" };

const TONE: Record<ReviewItem["kind"], "warn" | "bad" | "brand" | "accent"> = { identity: "accent", exception: "warn", conflict: "bad", change: "brand" };
const KIND: Record<ReviewItem["kind"], string> = { identity: "Duplicate?", exception: "Import issue", conflict: "Contradiction", change: "Change" };
const show = (v: unknown) => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return "(details)";
  const t = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  return t.length > 60 ? t.slice(0, 57) + "…" : t;
};
const TECH = new Set(["finished_at", "processing_started_at", "attempt", "counts", "extraction", "lease_until", "transcript_confidence", "related_entities", "depends_on", "meta"]);
/** Same issue many times (e.g. 400 person proposals from one file) → one row with a count. */
function group(items: ReviewItem[]) {
  const m = new Map<string, { it: ReviewItem; n: number }>();
  for (const it of items) { const k = `${it.kind}|${it.label}|${it.href}`; const g = m.get(k); if (g) g.n++; else m.set(k, { it, n: 1 }); }
  return [...m.values()];
}

function Tile({ label, value, href }: { label: string; value: number | undefined; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-line bg-surface p-3 hover:border-brand">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? "—"}</div>
    </Link>
  );
}

async function Body() {
  const ctx = await requirePageContext("editor");
  const [ov, queue, audit, members] = await Promise.all([
    databaseOverview(ctx.db, ctx.workspaceId),
    reviewQueue(ctx.db, ctx.workspaceId),
    recentChanges(ctx.db, ctx.workspaceId),
    memberDirectory(ctx.db, ctx.workspaceId),
  ]);
  const o = ov.data;
  const who = (id: string | null, kind: string) => (id ? members.find((m) => m.user_id === id)?.display_name ?? "former member" : kind);
  const reviewTotal = o ? o.identity_reviews + o.import_exceptions + o.conflicts + o.change_reviews : undefined;

  return (
    <div className="space-y-4">
      {ov.error ? <StaleBanner>Counts could not be loaded ({ov.error}). The numbers below are unknown, not zero.</StaleBanner> : null}

      <section aria-label="Records" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Companies" value={o?.organisations} href="/companies" />
        <Tile label="People" value={o?.people} href="/people" />
        <Tile label="Buildings" value={o?.buildings} href="/buildings" />
        <Tile label="Spaces (floors/units)" value={o?.spaces} href="/buildings" />
        <Tile label="Requirements" value={o?.requirements} href="/requirements" />
        <Tile label="Opportunities" value={o?.opportunities} href="/deals" />
        <Tile label="Leases" value={o?.leases} href="/buildings" />
        <Tile label="Interactions" value={o?.interactions} href="/search" />
        <Tile label="Source files" value={o?.sources} href="/imports" />
        <Tile label="Imports in progress" value={o?.pending_imports} href="/imports" />
      </section>

      <Card title={<span>Needs review {reviewTotal !== undefined ? <Badge tone={reviewTotal ? "warn" : "ok"}>{reviewTotal}</Badge> : null}</span>}
        actions={<ButtonLink variant="secondary" href="/imports">Upload a file</ButtonLink>}>
        {o ? (
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Badge tone="accent">{o.identity_reviews} possible duplicates</Badge>
            <Badge tone="warn">{o.import_exceptions} import issues</Badge>
            <Badge tone="bad">{o.conflicts} contradictory values</Badge>
            <Badge tone="brand">{o.change_reviews} proposed changes</Badge>
          </div>
        ) : null}
        {queue.failed.length ? <StaleBanner>Could not load: {queue.failed.join(", ")}. The queue may be incomplete.</StaleBanner> : null}
        {queue.items.length === 0 ? (
          <p className="text-sm text-ink-soft">Nothing waiting. Uncertain company/person/building matches, missing required fields, invalid dates or units, and
            contradictory values from imports appear here. Nothing is merged or overwritten until you decide.</p>
        ) : (
          <ul className="divide-y divide-line">
            {group(queue.items).map(({ it, n }, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5"><Badge tone={TONE[it.kind]}>{KIND[it.kind]}</Badge><span className="font-medium">{it.label}</span>{n > 1 ? <Badge>×{n}{n >= 25 ? "+" : ""}</Badge> : null}</div>
                  <div className="truncate text-xs text-ink-soft">{it.detail}</div>
                </div>
                <Link href={it.href} className="shrink-0 text-brand">Review</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent changes" actions={ctx.role === "admin" || ctx.role === "owner" ? <Link className="text-sm text-brand" href="/admin/audit">Full audit log</Link> : null}>
        {audit.error ? <StaleBanner>Audit history could not be loaded ({audit.error}).</StaleBanner> : audit.rows.length === 0 ? (
          <EmptyState title="No changes yet">Every create, edit, approval and archive is recorded here with the old and new value, who did it and why.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {audit.rows.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-ink-soft">{fmtDate(r.occurred_at, true)}</span>
                  <Badge tone="brand">{r.action}</Badge><span>{r.entity_type.replace(/_/g, " ")}</span>
                  <Badge>{who(r.actor_user_id, r.actor_kind)}</Badge>
                  {r.change_proposal_id ? <Badge tone="ok">approved change</Badge> : null}
                </div>
                {r.changes.length ? (
                  <table className="mt-1 w-full text-xs"><tbody>
                    {r.changes.filter((c) => !TECH.has(c.field)).slice(0, 4).map((c) => (
                      <tr key={c.field} className="align-top"><td className="w-1/4 pr-2 text-ink-soft">{c.field.replace(/_/g, " ")}</td>
                        <td className="w-3/8 pr-2 break-all line-through decoration-bad/60">{show(c.before)}</td><td className="break-all">{show(c.after)}</td></tr>
                    ))}
                  </tbody></table>
                ) : null}
                {r.reason || r.evidence ? <div className="mt-1 text-xs text-ink-soft">Why: {r.reason ?? "—"}{r.evidence ? ` · Evidence: ${r.evidence}` : ""}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Database" subtitle="Everything stored for this workspace, what needs checking, and what changed." />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}
