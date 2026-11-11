import { Suspense } from "react";
import Link from "next/link";
import { Badge, Button, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { EntityPicker } from "@/components/ui/entity-picker";
import { requirePageContext } from "@/lib/auth/context";
import { getTimeline } from "@/modules/intelligence/memory/context/timeline";
import { labels } from "@/modules/intelligence/memory/data";
import { TIMELINE_TYPES, TIMELINE_TYPE_LABEL, type TimelineEventType, type TimelineFilters } from "@/modules/intelligence/memory/types";
import { Src, VBadge } from "@/modules/intelligence/memory/ui/panels";

export const metadata = { title: "Intelligence timeline" };
type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);

async function Body({ sp }: { sp: SP }) {
  const ctx = await requirePageContext();
  const type = typeof sp.type === "string" && (TIMELINE_TYPES as string[]).includes(sp.type) ? (sp.type as TimelineEventType) : undefined;
  const f: TimelineFilters = { orgId: one(sp.org, UUID), personId: one(sp.person, UUID), assetId: one(sp.asset, UUID), requirementId: one(sp.requirement, UUID),
    opportunityId: one(sp.opportunity, UUID), from: one(sp.from, DATE), to: one(sp.to, DATE), types: type ? [type] : undefined, limit: 300 };
  let events: Awaited<ReturnType<typeof getTimeline>> | null = null; let err: string | null = null;
  try { events = await getTimeline(ctx, f); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const [orgL, perL, assL] = await Promise.all([labels(ctx, "organisation", f.orgId ? [f.orgId] : []), labels(ctx, "person", f.personId ? [f.personId] : []), labels(ctx, "asset", f.assetId ? [f.assetId] : [])]);
  const chips = [
    f.orgId && ["org", `Company: ${orgL.get(f.orgId) ?? "selected"}`], f.personId && ["person", `Contact: ${perL.get(f.personId) ?? "selected"}`],
    f.assetId && ["asset", `Building: ${assL.get(f.assetId) ?? "selected"}`], f.requirementId && ["requirement", "Requirement"], f.opportunityId && ["opportunity", "Deal"],
  ].filter(Boolean) as [string, string][];
  const without = (k: string) => { const p = new URLSearchParams(); for (const [a, b] of Object.entries(sp)) if (a !== k && typeof b === "string" && b) p.set(a, b); return `?${p}`; };
  return (
    <div className="space-y-4">
      <PageHeader title="Intelligence timeline" subtitle="Meaningful changes and conversations, newest first. Every line links to where it came from." />
      <form method="get" className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        <EntityPicker name="org" kind="company" label="Company" defaultValue={f.orgId ? { id: f.orgId, label: orgL.get(f.orgId) ?? "Company" } : null} />
        <EntityPicker name="person" kind="person" label="Contact" defaultValue={f.personId ? { id: f.personId, label: perL.get(f.personId) ?? "Contact" } : null} />
        {f.assetId ? <input type="hidden" name="asset" value={f.assetId} /> : null}
        {f.requirementId ? <input type="hidden" name="requirement" value={f.requirementId} /> : null}
        {f.opportunityId ? <input type="hidden" name="opportunity" value={f.opportunityId} /> : null}
        <Field label="Event type"><Select name="type" defaultValue={type ?? ""}><option value="">All</option>{TIMELINE_TYPES.map((t) => <option key={t} value={t}>{TIMELINE_TYPE_LABEL[t]}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-2"><Field label="From"><Input type="date" name="from" defaultValue={f.from} /></Field><Field label="To"><Input type="date" name="to" defaultValue={f.to} /></Field></div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4"><Button type="submit">Apply</Button><Link className="text-sm text-ink-soft underline" href="/intelligence/timeline">Clear all</Link></div>
      </form>
      {chips.length ? <div className="flex flex-wrap gap-2">{chips.map(([k, l]) => <Link key={k} href={without(k)} className="rounded-md border border-line px-2 py-1 text-xs">{l} ✕</Link>)}</div> : null}
      <p className="text-xs text-ink-soft">Building, requirement and deal filters are set from their pages (“Full timeline”).</p>
      {err ? <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">The timeline couldn&apos;t load ({err}). Nothing is missing from your records — retry in a moment.</p>
        : !events?.length ? <EmptyState title="Nothing on the timeline yet">Log a conversation, add a meeting, or record a requirement — they appear here automatically. Try clearing filters if you set any.</EmptyState>
        : (
          <ol className="space-y-2">{events.map((e) => (
            <li key={e.id} className="min-w-0 rounded-lg border border-line bg-surface px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft"><span className="tabular-nums">{e.at.slice(0, 10)}</span><Badge>{TIMELINE_TYPE_LABEL[e.type]}</Badge><VBadge v={e.verification} /></div>
              <p className="mt-0.5 break-words text-sm font-medium">{e.title}</p>
              {e.detail ? <p className="break-words text-sm text-ink-soft">{e.detail}</p> : null}
              <Src s={e.sourceRef} />
            </li>))}</ol>
        )}
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return <Suspense fallback={<p className="text-sm text-ink-soft">Loading timeline…</p>}><Body sp={sp} /></Suspense>;
}
