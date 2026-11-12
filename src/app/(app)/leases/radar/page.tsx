import { Suspense } from "react";
import Link from "next/link";
import clsx from "clsx";
import { requirePageContext } from "@/lib/auth/context";
import { Badge, ButtonLink, Card, EmptyState, Input, PageHeader, Table, Td, sf, Skeleton } from "@/components/ui";
import { todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";
import { inWindow, landlordConcentration, WINDOW_LABEL, type DatedFact, type RadarItem, type RadarWindow } from "@/modules/brief/lease-radar";
import { loadRadar } from "@/modules/brief/radar-data";
import { LeaseTabs } from "@/modules/leases/ui";
import { STATUS_LABEL as LEASE_STATUS_LABEL, isLeaseStatus } from "@/modules/leases/status";

type SP = Promise<Record<string, string | string[] | undefined>>;

const WINDOWS: RadarWindow[] = ["notice-90", "0-3", "3-12", "12-24", "expired", "unknown", "all"];
const STATUS_LABEL: Record<RadarItem["status"], [string, "ok" | "warn" | "neutral" | "bad"]> = {
  active: ["Dates current", "ok"], expired_needs_confirmation: ["Expired — confirm status", "warn"], dates_unknown: ["Dates unknown", "neutral"], quarantined: ["Quarantined (fractional tenure)", "bad"],
};

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Skeleton variant="list" />}><Body searchParams={searchParams} /></Suspense>;
}

async function Body({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const today = todayFor(ctx);
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const { items } = await loadRadar(ctx.db, ctx.workspaceId, today, settings); // RLS-scoped
  // B9: show the lease's recorded lifecycle status (executed ≠ active); the radar's own state only describes the dates.
  const ids = [...new Set(items.map((it) => it.leaseId))].slice(0, 1000);
  const life = new Map<string, string>();
  if (ids.length) for (const l of (await ctx.db.from("lease").select("id, lifecycle_status").eq("workspace_id", ctx.workspaceId).in("id", ids)).data ?? []) life.set(l.id, l.lifecycle_status);
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const w = (WINDOWS as string[]).includes(str("window")) ? (str("window") as RadarWindow) : "all";
  const q = str("q").trim().toLowerCase();
  const focus = str("lease");
  const reviewOnly = str("review") === "1";
  const reviewCount = items.filter((it) => it.reviewFlags.length).length;
  const filtered = items
    .filter((it) => inWindow(it, w, today))
    .filter((it) => !reviewOnly || it.reviewFlags.length > 0)
    .filter((it) => !q || `${it.tenantName ?? ""} ${it.assetName ?? ""} ${it.landlordName ?? ""}`.toLowerCase().includes(q))
    .filter((it) => !focus || it.leaseId === focus)
    .sort((a, b) => (a.nextKeyDate ?? "9999") < (b.nextKeyDate ?? "9999") ? -1 : (a.nextKeyDate ?? "9999") > (b.nextKeyDate ?? "9999") ? 1 : (a.tenantName ?? "").localeCompare(b.tenantName ?? ""));
  const counts = Object.fromEntries(WINDOWS.map((x) => [x, items.filter((it) => inWindow(it, x, today)).length]));
  const conc = landlordConcentration(items, today).slice(0, 15);
  const href = (patch: Record<string, string>) => {
    const u = new URLSearchParams({ ...(w !== "all" ? { window: w } : {}), ...(q ? { q } : {}), ...patch });
    return `/leases/radar?${u.toString()}`;
  };

  return (
    <div className="space-y-4">
      <LeaseTabs active="radar" />
      <PageHeader title="Leases — radar" subtitle={`${items.length} leases · expiry, lock-in, notice, break, rent escalation and options are separate event types · dates as of ${today}`} />
      <p className="text-xs text-ink-soft">
        <Badge tone="ok">Contractual / confirmed</Badge> dates are verified; <Badge tone="neutral">Calculated by radar</Badge> dates are reproducible calculations
        (formula on hover, stored as separate calculated events) and never replace a verified date. Re-calculated automatically when a lease, lease event or lease document changes.
      </p>
      {items.length === 0 ? (
        <EmptyState title="No leases yet" action={<ButtonLink href="/imports">Import a lease schedule</ButtonLink>}>
          Import a lease/transaction export (or add leases on a company) and the radar computes expiry with EDATE, notice deadlines only
          when the notice clause is known, reverse plans from occupation and call windows. Missing dates become enrichment tasks — never guesses.
        </EmptyState>
      ) : (
        <>
          <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1 text-sm">
            <Link href={reviewOnly ? "/leases/radar" : "/leases/radar?review=1"}
              className={clsx("whitespace-nowrap rounded-full border px-3 py-1.5", reviewOnly ? "border-bad bg-bad text-white" : "border-line bg-surface")}>
              Needs review ({reviewCount})
            </Link>
            {WINDOWS.map((x) => (
              <Link key={x} href={`/leases/radar?${new URLSearchParams({ ...(x !== "all" ? { window: x } : {}), ...(q ? { q } : {}) }).toString()}`}
                className={clsx("whitespace-nowrap rounded-full border px-3 py-1.5", w === x ? "border-brand bg-brand text-white" : "border-line bg-surface")}>
                {WINDOW_LABEL[x]} ({counts[x]})
              </Link>
            ))}
          </nav>
          <form action="/leases/radar" className="flex gap-2">
            {w !== "all" ? <input type="hidden" name="window" value={w} /> : null}
            <Input name="q" aria-label="Search leases" defaultValue={q} placeholder="Tenant, building or landlord" />
          </form>
          {focus ? <p className="text-sm"><Link href={href({})} className="text-brand">← Show all leases</Link></p> : null}

          {filtered.length === 0 ? <EmptyState title="No leases in this view">Try another window or clear the search.</EmptyState> : (
            <ul className="space-y-3">
              {filtered.slice(0, 200).map((it) => <LeaseCard key={it.leaseId} it={it} highlight={it.leaseId === focus} lifecycle={life.get(it.leaseId) ?? null} />)}
            </ul>
          )}
          {filtered.length > 200 ? <p className="text-xs text-ink-soft">Showing the first 200 of {filtered.length}. Narrow with a window or search.</p> : null}

          <Card title="Landlord / building expiry concentration (24 months)">
            {conc.length ? (
              <Table head={["Building", "Landlord", "Quarter", "Leases", "Area", "Tenants"]}>
                {conc.map((r) => (
                  <tr key={r.key}><Td>{r.building}</Td><Td>{r.landlord ?? "—"}</Td><Td>{r.quarter}</Td><Td>{r.leases}</Td><Td>{sf(r.areaSf || null)}</Td><Td className="text-xs">{r.tenants.slice(0, 4).join(", ")}{r.tenants.length > 4 ? "…" : ""}</Td></tr>
                ))}
              </Table>
            ) : <p className="text-sm text-ink-soft">No documented expiries in the next 24 months.</p>}
          </Card>
        </>
      )}
    </div>
  );
}

function DateRow({ label, f, extra }: { label: string; f: DatedFact | null; extra?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-ink-soft">{label}</span>
      {f ? (
        <>
          <span className="tabular-nums">{f.date}</span>
          <Badge tone={f.verified ? "ok" : "neutral"} title={f.formula}>{f.basisLabel}{f.source === "radar" ? " · not verified" : ""}</Badge>
          {f.detail ? <span className={clsx("text-xs", /review/.test(f.detail) ? "text-bad" : "text-ink-soft")}>{f.detail}</span> : null}
          {f.source === "radar" && f.formula ? <span className="text-xs text-ink-soft break-all">= {f.formula}</span> : null}
          {extra ? <span className="text-xs text-ink-soft">{extra}</span> : null}
        </>
      ) : <span className="text-ink-soft">Unknown</span>}
    </div>
  );
}

function LeaseCard({ it, highlight, lifecycle }: { it: RadarItem; highlight: boolean; lifecycle: string | null }) {
  const [label, tone] = STATUS_LABEL[it.status];
  const lifeLabel = lifecycle && isLeaseStatus(lifecycle) ? LEASE_STATUS_LABEL[lifecycle] : null;
  return (
    <li className={clsx("rounded-xl border bg-surface p-3", highlight ? "border-brand" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{it.tenantOrgId ? <Link href={`/companies/${it.tenantOrgId}`} className="hover:underline">{it.tenantName ?? "Unknown tenant"}</Link> : it.tenantName ?? "Unknown tenant"}</span>
        {lifeLabel ? <Badge tone={lifecycle === "active" ? "ok" : "neutral"} title="Lease lifecycle status">{lifeLabel}</Badge> : null}
        {it.status !== "active" || !lifeLabel ? <Badge tone={tone}>{label}</Badge> : null}
        {it.callWindow ? <Badge tone={it.callWindow.state === "open" || it.callWindow.state === "closing" ? "bad" : it.callWindow.state === "missed" ? "warn" : "neutral"}>Call window {it.callWindow.state}</Badge> : null}
      </div>
      <div className="mt-0.5 text-xs text-ink-soft">{it.assetName ?? "Unknown building"}{it.landlordName ? ` · landlord ${it.landlordName}` : ""} · {sf(it.areaSf)}</div>
      <div className="mt-2 space-y-1 text-sm">
        <DateRow label="Expiry" f={it.expiry} extra={it.daysToExpiry != null ? `${it.daysToExpiry} days` : undefined} />
        <DateRow label="Lock-in end" f={it.lockinEnd} />
        <DateRow label="Notice by" f={it.noticeDeadline} extra={it.daysToNotice != null ? `${it.daysToNotice} days` : "needs notice clause"} />
        {it.breaks.map((b) => <DateRow key={b.date} label="Break" f={b} />)}
        {it.options.map((o) => <DateRow key={`o${o.date}`} label="Option" f={o} />)}
        <EscalationRows list={it.escalations} />
      </div>
      {it.reviewFlags.length ? (
        <ul className="mt-2 space-y-1 rounded-lg border border-bad/30 bg-bad/5 p-2 text-xs text-bad">
          {it.reviewFlags.map((r) => <li key={r.key}><span className="font-semibold">Needs review — {r.eventType.replace(/_/g, " ")}{r.date ? ` ${r.date}` : ""}:</span> {r.reason}</li>)}
          <li><Link className="underline" href={`/tasks?source=workflow&q=${encodeURIComponent("Review lease clause")}`}>Review tasks</Link></li>
        </ul>
      ) : null}
      {it.plan ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-brand">Reverse plan from occupation {it.plan.occupation} {it.plan.viable ? "" : "· decision date passed"}</summary>
          <ul className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
            <li>Calls open: {it.callWindow?.opens}</li>
            <li>Options/visits start: {it.plan.optionsStart}</li>
            <li>Site decision by: {it.plan.decisionBy}</li>
            <li>LOI/docs start: {it.plan.procurementStart}</li>
            <li>Fit-out start ({it.plan.fitoutMonths} mo): {it.plan.fitoutStart}</li>
            <li>Move by: {it.plan.moveBy}</li>
            <li className="sm:col-span-2 font-medium">Last decision: {it.plan.lastDecision}{it.plan.noticeDeadline ? ` (notice ${it.plan.noticeDeadline})` : ""}</li>
            <li className="sm:col-span-2 text-ink-soft">Milestones within 90 days become dated tasks — <Link className="text-brand" href={`/tasks?source=workflow&q=${encodeURIComponent(it.tenantName ?? "")}`}>see tasks</Link></li>
          </ul>
        </details>
      ) : null}
      {it.issues.length ? <ul className="mt-2 list-disc pl-5 text-xs text-warn">{it.issues.map((x) => <li key={x}>{x}</li>)}</ul> : null}
      {it.enrichment.length ? <p className="mt-1 text-xs"><Link className="text-brand" href={`/tasks?source=workflow&q=${encodeURIComponent((it.tenantName ?? "").slice(0, 40))}`}>Enrichment task raised</Link>: {it.enrichment.map((e) => e.reason).join("; ")}</p> : null}
    </li>
  );
}

function EscalationRows({ list }: { list: DatedFact[] }) {
  if (!list.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = list.filter((e) => e.date >= today);
  const shown = (upcoming.length ? upcoming : list).slice(0, 2);
  return (
    <>
      {shown.map((e) => <DateRow key={`e${e.date}`} label="Escalation" f={e} />)}
      {list.length > shown.length ? (
        <details className="text-xs"><summary className="cursor-pointer text-ink-soft">All {list.length} rent escalation dates</summary>
          <ul className="ml-4 mt-1 list-disc">{list.map((e) => <li key={e.date}>{e.date} · {e.basisLabel}{e.detail ? ` · ${e.detail}` : ""}{e.formula ? ` · ${e.formula}` : ""}</li>)}</ul>
        </details>
      ) : null}
    </>
  );
}
