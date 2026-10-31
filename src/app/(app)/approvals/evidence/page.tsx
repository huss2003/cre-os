import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { ChangeError } from "@/lib/services/changes";
import { fmt } from "@/lib/util/time";
import { recordProvenance } from "@/modules/changes/steward";
import { markVerifiedAction } from "@/modules/changes/steward-actions";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { FreshnessBadge, StewardNav, show } from "@/modules/changes/ui/steward-ui";

export const metadata = { title: "Why do we believe this?" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

async function Body({ searchParams }: Props) {
  const sp = await searchParams;
  const type = String(sp.type ?? ""), id = String(sp.id ?? "");
  if (!/^[a-z_]+$/.test(type) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  let p: Awaited<ReturnType<typeof recordProvenance>>;
  try { p = await recordProvenance(ctx.db, ctx.workspaceId, type, id); }
  catch (e) { if (e instanceof ChangeError && ["not_found", "invalid_parameter"].includes(e.code)) notFound(); throw e; }
  const canVerify = hasRole(ctx, "editor") && ["organisation", "person", "asset", "availability"].includes(type);
  return (
    <div className="space-y-4">
      <PageHeader title={`Why do we believe this? — ${p.record.label ?? type}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge>{type}</Badge>created {fmt(p.record.created_at)} · updated {fmt(p.record.updated_at)}{p.freshness !== undefined && ["organisation", "person", "asset", "availability"].includes(type) ? <FreshnessBadge f={p.freshness} /> : null}</span>} />
      <StewardNav current="" />
      {p.untraceableMaterial.length ? <StaleBanner>No evidence is recorded for these material fields: {p.untraceableMaterial.join(", ")}. Treat them as unverified until confirmed.</StaleBanner> : null}
      {canVerify ? (
        <Card>
          <ActionForm action={markVerifiedAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={id} /><input type="hidden" name="type" value={type} />
            <input name="note" placeholder="How did you verify the key facts? (optional)" className="min-h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm" maxLength={500} />
            <Submit variant="secondary">Mark verified</Submit>
          </ActionForm>
        </Card>
      ) : null}
      <div className="space-y-3">
        {p.fields.map((f) => (
          <Card key={f.field}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs">{f.field}</span>{f.material ? <Badge tone="warn">material</Badge> : null}
              {f.conflicts.length ? <Link href="/approvals/conflicts"><Badge tone="bad">{f.conflicts.length} conflicting source{f.conflicts.length > 1 ? "s" : ""}</Badge></Link> : null}
            </div>
            <p className="mt-1 break-words text-sm">{show(f.value)}</p>
            {f.changes.length ? (
              <ul className="mt-2 space-y-2 text-sm">
                {f.changes.map((c) => (
                  <li key={c.proposal_id} className="rounded-lg border border-line p-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft"><Badge tone={c.state === "applied" ? "ok" : "brand"}>{c.state}</Badge>{c.operation} · {c.proposed_by_kind} · {fmt(c.at)}</div>
                    <p className="text-sm">{c.reason}</p>
                    {c.evidence.length ? <Evidence items={c.evidence} /> : <p className="text-xs text-warn">No evidence attached to this change.</p>}
                  </li>
                ))}
              </ul>
            ) : null}
            {f.origin.length ? <div className="mt-2"><p className="text-xs text-ink-soft">Recorded from:</p><Evidence items={f.origin} /></div> : null}
            {!f.changes.length && !f.origin.length && f.value !== null && f.value !== undefined ? <p className="mt-1 text-xs text-ink-soft">Entered directly; no source document recorded.</p> : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

function Evidence({ items }: { items: { id: string; label: string; locator: string | null; excerpt: string | null; at: string | null; href: string | null }[] }) {
  return (
    <ul className="mt-1 space-y-1 text-xs">
      {items.map((e) => (
        <li key={e.id} className="break-words">
          {e.href ? <Link className="text-brand underline" href={e.href}>{e.label}</Link> : <span className="font-medium">{e.label}</span>}
          {e.at ? <span className="text-ink-soft"> · {fmt(e.at)}</span> : null}
          {e.excerpt ? <span className="block text-ink-soft">“{e.excerpt}”</span> : null}
        </li>
      ))}
    </ul>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body {...props} /></Suspense>;
}
