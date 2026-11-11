import "server-only";
/**
 * Intelligence panels (spec §14 A–D) — compact, collapsible, 375px-safe server components. Plain words; unknown shown as
 * "Unknown"; every line links its source where one exists. Read-only (RLS via ctx.db).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { getCompanyContext } from "../entity/company";
import { getPersonContext } from "../entity/person";
import { getPropertyContext } from "../entity/property";
import { getRequirementContext } from "../requirement/service";
import type { RequirementConfidence } from "../types";
import { listChanges, type ChangeRow } from "../changes/service";
import { listRecommendations, type RecFilter } from "../recommend/service";
import type { Recommendation } from "../recommend/rules";
import { summariseContext } from "../context/summary";
import { panelChangeStateAction, panelRecStateAction } from "./actions";
import { type MemCtx, type MemoryItem, type SourceRef, type Verification, UNKNOWN } from "../types";

const d = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : UNKNOWN);
type Tone = "neutral" | "brand" | "ok" | "warn" | "bad" | "accent";
const V: Record<Verification, [Tone, string]> = { verified: ["ok", "Verified"], reported: ["warn", "Reported"], estimated: ["neutral", "Estimate"], inferred: ["accent", "Inferred"], unverified: ["warn", "Unverified"], unknown: ["neutral", "Unknown"] };
const C: Record<RequirementConfidence, Tone> = { confirmed: "ok", indicative: "warn", estimated: "neutral", inferred: "accent", outdated: "bad", conflicting: "bad", unknown: "neutral" };
export const VBadge = ({ v }: { v: Verification }) => <Badge tone={V[v][0]}>{V[v][1]}</Badge>;
const StatusBadge = ({ s }: { s: MemoryItem["status"] }) => (s === "current" ? null : <Badge tone={s === "conflicting" ? "bad" : s === "unverified" ? "warn" : "neutral"}>{s === "historical" ? "Past" : s === "superseded" ? "Replaced" : s === "conflicting" ? "Conflicting" : "Unverified"}</Badge>);
export const Src = ({ s }: { s: SourceRef | null }) => (!s ? <span className="text-xs text-ink-soft">no source</span> : s.href ? <Link className="text-xs text-brand underline" href={s.href}>{s.label}</Link> : <span className="text-xs text-ink-soft">{s.label}</span>);

function Panel({ title, summary, children, open }: { title: string; summary?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group min-w-0 rounded-xl border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 text-sm font-semibold">
        <span className="min-w-0 truncate">Intelligence · {title}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-ink-soft">{summary}<span className="transition-transform group-open:rotate-90">›</span></span>
      </summary>
      <div className="space-y-2 border-t border-line px-4 py-3">{children}</div>
    </details>
  );
}
function Sec({ title, children, empty = "Nothing recorded yet.", count }: { title: string; children?: ReactNode; empty?: string; count?: number }) {
  const has = count === undefined ? !!children : count > 0;
  return (
    <details className="min-w-0" open={has && (count ?? 1) <= 5}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between text-xs font-semibold uppercase tracking-wide text-ink-soft">
        <span>{title}</span>{count !== undefined ? <span>{count}</span> : null}
      </summary>
      <div className="mt-1 text-sm">{has ? children : <p className="text-ink-soft">{empty}</p>}</div>
    </details>
  );
}
const Items = ({ xs }: { xs: MemoryItem[] }) => (
  <ul className="space-y-1">{xs.map((i, k) => (
    <li key={k} className="break-words"><span className={i.status === "current" ? "" : "text-ink-soft"}>{i.display}</span> <span className="inline-flex flex-wrap gap-1 align-middle"><VBadge v={i.verification} /><StatusBadge s={i.status} /></span> <Src s={i.sourceRef} /></li>))}</ul>
);
const Unknowns = ({ xs }: { xs: string[] }) => (xs.length ? <p className="text-xs text-ink-soft"><strong>Unknown:</strong> {xs.join(", ")}.</p> : null);
const Failed = ({ what }: { what: string }) => <p className="text-sm text-bad">Couldn&apos;t load {what} intelligence. The record itself is unaffected — reload to retry.</p>;


// ------------------------------------------------------------------ shared: changes, recommendations, AI summary
const val = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "unknown";
  if (Array.isArray(v)) return v.length ? v.map(val).join(", ") : "none";
  if (typeof v === "object") { const o = v as Record<string, unknown>; const pick = o.display ?? o.label ?? o.name ?? o.title ?? o.value; return pick !== undefined ? val(pick) : Object.entries(o).filter(([, x]) => x != null && typeof x !== "object").map(([k, x]) => `${k} ${x}`).join(", ") || "unknown"; }
  return String(v);
};
const VER: Record<string, Verification> = { verified: "verified", reported: "reported", estimated: "estimated", inferred: "inferred", unverified: "unverified" };
const asSrc = (s: Record<string, unknown> | null | undefined): SourceRef | null => (s && (s.label || s.href) ? { type: String(s.type ?? ""), id: String(s.id ?? ""), label: String(s.label ?? "source"), href: (s.href as string) ?? null } : null);
const impactText = (c: ChangeRow) => { const i = c.impact as Record<string, unknown>; const t = i?.summary ?? i?.text ?? i?.note; return typeof t === "string" ? t : c.affectedOpportunityIds.length ? `${c.affectedOpportunityIds.length} open deal(s) affected` : c.material ? "Material change" : null; };

export function Changes({ xs, back }: { xs: ChangeRow[]; back?: string }) {
  return (
    <ul className="space-y-1.5">{xs.map((c) => (
      <li key={c.id} className="break-words">
        <span className="font-medium">{c.label}</span>{c.field ? <span className="text-ink-soft"> · {c.field.replace(/_/g, " ")}</span> : null}: <span className="text-ink-soft line-through">{val(c.previous)}</span> → {val(c.latest)}
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-ink-soft">{d(c.changedAt ?? c.detectedAt)} <VBadge v={VER[c.verification] ?? "unknown"} /> <Src s={asSrc(c.source)} />{impactText(c) ? <span>· Impact: {impactText(c)}</span> : null}</span>
        {back && c.state === "open" ? (
          <span className="mt-1 flex gap-2">
            <form action={panelChangeStateAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="state" value="acknowledged" /><button className="min-h-9 rounded-lg border border-line px-3 text-xs" type="submit">Acknowledge</button></form>
            <form action={panelChangeStateAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="state" value="dismissed" /><button className="min-h-9 rounded-lg px-3 text-xs text-ink-soft" type="submit">Dismiss</button></form>
          </span>
        ) : null}
      </li>))}</ul>
  );
}

export function Recs({ xs, back }: { xs: Recommendation[]; back: string }) {
  const tone = { high: "ok", medium: "warn", low: "neutral" } as const;
  return (
    <ul className="space-y-2">{xs.map((r) => (
      <li key={r.ref} className="break-words rounded-lg border border-line p-2">
        <p className="font-medium">{r.href ? <Link className="text-brand" href={r.href}>{r.title}</Link> : r.title} <Badge tone={tone[r.confidence]}>{r.confidence} confidence</Badge></p>
        <p className="text-xs text-ink-soft">Why: {r.why}</p>
        {r.supporting.length ? <ul className="ml-4 list-disc text-xs text-ink-soft">{r.supporting.slice(0, 3).map((x, k) => <li key={k}>{x}</li>)}</ul> : null}
        {r.sourceRefs.length ? <p className="flex flex-wrap gap-2 text-xs">Sources: {r.sourceRefs.slice(0, 4).map((s, k) => <Src key={k} s={s} />)}</p> : <p className="text-xs text-ink-soft">Sources: none recorded</p>}
        <p className="text-xs"><strong>Next:</strong> {r.nextAction}</p>
        {r.persistedId ? (
          <div className="mt-1 flex gap-2">
            <form action={panelRecStateAction}><input type="hidden" name="id" value={r.persistedId} /><input type="hidden" name="back" value={back} /><input type="hidden" name="state" value="done" /><button className="min-h-9 rounded-lg border border-line px-3 text-xs" type="submit">Done</button></form>
            <form action={panelRecStateAction}><input type="hidden" name="id" value={r.persistedId} /><input type="hidden" name="back" value={back} /><input type="hidden" name="state" value="dismissed" /><button className="min-h-9 rounded-lg px-3 text-xs text-ink-soft" type="submit">Dismiss</button></form>
          </div>
        ) : <p className="text-xs text-ink-soft">Clears by itself once the underlying record is updated.</p>}
      </li>))}</ul>
  );
}

/** Important changes + recommendations + labelled AI summary for one entity. Each part fails independently and quietly. */
async function Extras({ ctx, entityType, entityId, rec, back, kind, facts, unknowns }: { ctx: MemCtx; entityType: string; entityId: string; rec: RecFilter; back: string; kind: "company" | "person" | "property" | "requirement"; facts: string[]; unknowns: string[] }) {
  const [changes, recs, summary] = await Promise.all([
    listChanges(ctx, { entityType, entityId, limit: 10 }).catch(() => null),
    listRecommendations(ctx, { ...rec, limit: 8 }).catch(() => null),
    facts.length ? summariseContext(ctx, kind, facts, unknowns).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <>
      {summary && !summary.error && summary.text ? (
        <div className="rounded-lg bg-canvas p-2 text-sm"><p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">AI summary{summary.mock ? " · rule-based (AI off)" : ""}</p><p className="break-words">{summary.text}</p><p className="text-xs text-ink-soft">Generated from the records below; check sources before relying on it.</p></div>
      ) : null}
      <Sec title="Important changes" count={changes?.length ?? 0} empty={changes === null ? "Couldn't load changes — reload to retry." : "No changes detected yet."}>{changes ? <Changes xs={changes} /> : null}</Sec>
      <Sec title="Recommendations" count={recs?.length ?? 0} empty={recs === null ? "Couldn't load recommendations — reload to retry." : "No recommendations right now."}>{recs ? <Recs xs={recs} back={back} /> : null}</Sec>
    </>
  );
}

// ------------------------------------------------------------------ A. Company
export async function CompanyIntelligence({ ctx, orgId }: { ctx: MemCtx; orgId: string }) {
  const c = await getCompanyContext(ctx, orgId).catch(() => undefined);
  if (c === undefined) return <Panel title="company"><Failed what="company" /></Panel>;
  if (!c) return null;
  const pending = c.commitments.filter((x) => x.pending);
  return (
    <Panel title="company" summary={<>{c.currentRequirements.length} live req · {c.activeOpportunities.length} deals{pending.length ? ` · ${pending.length} open promises` : ""}</>}>
      <Unknowns xs={c.unknowns} />
      <Extras ctx={ctx} entityType="organisation" entityId={orgId} rec={{ orgId }} back={`/companies/${orgId}`} kind="company" unknowns={c.unknowns}
        facts={[`${c.org.display_name ?? "Company"}: ${c.org.sector ?? "industry unknown"}, HQ ${c.org.hq_city ?? "unknown"}.`, ...c.currentRequirements.map((r) => `Live requirement: ${r.title} (${r.status}).`), ...c.activeOpportunities.map((o) => `Open deal: ${o.name}, stage ${o.stage}.`), ...pending.map((x) => `Pending commitment: ${x.text}.`), ...c.objections.slice(0, 3).map((x) => `Objection: ${x.text}.`)]} />
      <Sec title="Overview">
        <p>{c.org.sector ?? "Industry unknown"} · HQ {c.org.hq_city ?? UNKNOWN}{c.org.headcount_min || c.org.headcount_max ? ` · ${c.org.headcount_min ?? "?"}–${c.org.headcount_max ?? "?"} staff` : " · headcount unknown"}</p>
        {c.relatedOrgs.length ? <ul className="mt-1 text-xs">{c.relatedOrgs.map((r) => <li key={r.id + r.relation}>{r.relation.replace(/_/g, " ")}{r.direction === "to" ? " (inverse)" : ""}: <Link className="text-brand" href={`/companies/${r.id}`}>{r.name}</Link>{r.current ? "" : " (past)"}</li>)}</ul> : null}
      </Sec>
      <Sec title="Current requirements" count={c.currentRequirements.length} empty="No live requirement recorded.">
        <ul>{c.currentRequirements.map((r) => <li key={r.id}><Link className="text-brand" href={`/requirements/${r.id}`}>{r.title}</Link> <span className="text-ink-soft">· {r.area_target_sf ? `${r.area_target_sf} SF` : "area unknown"} · {r.status}</span></li>)}</ul>
      </Sec>
      <Sec title="Decision-makers & contacts" count={c.people.length} empty="No contacts linked.">
        <ul>{c.people.sort((a, b) => Number(b.current) - Number(a.current)).slice(0, 12).map((p) => <li key={p.personId} className={p.current ? "" : "text-ink-soft"}><Link className="text-brand" href={`/people/${p.personId}`}>{p.name}</Link>{p.title ? ` · ${p.title}` : ""}{p.decisionMaker ? <> <Badge tone="brand">decides/approves</Badge></> : null}{p.current ? "" : " (left)"}</li>)}</ul>
        {!c.decisionMakers.length ? <p className="text-xs text-ink-soft">Decision-maker: unknown.</p> : null}
      </Sec>
      <Sec title="Deals" count={c.activeOpportunities.length + c.previousOpportunities.length} empty="No deals yet.">
        <ul>{[...c.activeOpportunities, ...c.previousOpportunities].map((o) => <li key={o.id} className={o.outcome && o.outcome !== "open" ? "text-ink-soft" : ""}><Link className="text-brand" href={`/deals/${o.id}`}>{o.name}</Link> · {o.stage}{o.outcome && o.outcome !== "open" ? ` · ${o.outcome}${o.outcome_reason ? ` (${o.outcome_reason})` : ""}` : ""}</li>)}</ul>
      </Sec>
      <Sec title="Occupancy & rent history" count={c.rentHistory.length} empty="No leases recorded — occupancy unknown."><Items xs={c.rentHistory} /></Sec>
      <Sec title="Historical requirements" count={c.historicalRequirements.length}>
        <ul>{c.historicalRequirements.map((r) => <li key={r.id} className="text-ink-soft"><Link className="text-brand" href={`/requirements/${r.id}`}>{r.title}</Link> · {r.status}</li>)}</ul>
      </Sec>
      <Sec title="Relationship history" count={c.interactions.length} empty="No conversations recorded.">
        <ul>{c.interactions.slice(0, 6).map((i) => <li key={i.id}>{d(i.occurred_at)} · {i.channel}: {i.subject ?? i.summary ?? "(no subject)"}</li>)}</ul>
        <Link className="text-xs text-brand underline" href={`/intelligence/timeline?org=${orgId}`}>Full timeline</Link>
      </Sec>
      <Sec title="Outstanding commitments" count={pending.length}><ul>{pending.map((x, k) => <li key={k}>{x.text}{x.due ? ` · due ${x.due}` : ""}{x.overdue ? <> <Badge tone="bad">overdue</Badge></> : null} <Src s={x.source} /></li>)}</ul></Sec>
      <Sec title="Objections raised" count={c.objections.length}><ul>{c.objections.map((x, k) => <li key={k}>“{x.text}” <Src s={x.source} /></li>)}</ul></Sec>
      <Sec title="Recent developments" count={c.developments.length}><ul>{c.developments.map((s) => <li key={s.id}>{d(s.event_date ?? s.created_at)} · {s.title} {s.verification === "fact" ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>}</li>)}</ul></Sec>
      <Sec title="Unresolved questions" count={c.unresolvedQuestions.length}><ul>{c.unresolvedQuestions.slice(0, 10).map((x, k) => <li key={k}>{x.href ? <Link className="text-brand" href={x.href}>{x.text}</Link> : x.text}</li>)}</ul></Sec>
    </Panel>
  );
}

// ------------------------------------------------------------------ B. Contact
export async function PersonIntelligence({ ctx, personId }: { ctx: MemCtx; personId: string }) {
  const c = await getPersonContext(ctx, personId).catch(() => undefined);
  if (c === undefined) return <Panel title="contact"><Failed what="contact" /></Panel>;
  if (!c) return null;
  const r = c.relationship;
  const pending = c.commitments.filter((x) => x.pending);
  return (
    <Panel title="contact" summary={<>Relationship: {r.level}{r.score !== null ? ` (${r.score})` : ""}</>}>
      <Unknowns xs={c.unknowns} />
      <Extras ctx={ctx} entityType="person" entityId={personId} rec={{ personId }} back={`/people/${personId}`} kind="person" unknowns={c.unknowns}
        facts={[...c.currentEmployment.map((i) => `Current: ${i.display} (${i.verification}).`), ...c.previousEmployment.slice(0, 3).map((i) => `Previously: ${i.display}.`), `Relationship: ${r.level}.`, `Last interaction: ${d(c.lastInteractionAt)}.`, ...pending.map((x) => `Pending commitment: ${x.text}.`), ...c.opportunities.map((o) => `Deal: ${o.name} (${o.stage}).`)]} />
      <Sec title="Current employer"><Items xs={c.currentEmployment} />{!c.currentEmployment.length ? <p className="text-ink-soft">Unknown.</p> : null}<p className="text-xs text-ink-soft">Seniority: {c.seniority ?? UNKNOWN} · Department: {c.department ?? UNKNOWN}</p></Sec>
      <Sec title="Previous employers & designations" count={c.previousEmployment.length} empty="No earlier roles recorded."><Items xs={c.previousEmployment} /></Sec>
      <Sec title="Decision-making role" count={c.decisionRoles.length} empty="Unknown — not mapped on any requirement."><Items xs={c.decisionRoles} /></Sec>
      <Sec title="Relationship strength">
        <ul className="space-y-0.5">{r.explanation.map((x, k) => <li key={k}>{x}</li>)}</ul>
        {r.factors.length ? <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">{r.factors.map((f) => <li key={f.key}>{f.label}: {f.points}/{f.max} — {f.note}</li>)}</ul> : null}
        {r.caveats.map((x, k) => <p key={k} className="text-xs text-warn">{x}</p>)}
      </Sec>
      <Sec title="Interaction timeline" count={c.interactions.length} empty="No interactions recorded — we have not spoken to this person (as far as CRE OS knows).">
        <p className="text-xs text-ink-soft">Last: {d(c.lastInteractionAt)} · Next: {c.nextInteraction ? <Link className="text-brand" href={c.nextInteraction.href ?? "#"}>{d(c.nextInteraction.at)} {c.nextInteraction.title}</Link> : "none scheduled"}</p>
        <ul>{c.interactions.slice(0, 8).map((i) => <li key={i.id}>{d(i.occurred_at)} · {i.channel}{i.direction ? ` (${i.direction})` : ""}: {i.subject ?? i.summary ?? "(no subject)"}</li>)}</ul>
        <Link className="text-xs text-brand underline" href={`/intelligence/timeline?person=${personId}`}>Full timeline</Link>
      </Sec>
      <Sec title="Known preferences" count={c.preferences.length} empty="No preferences recorded."><Items xs={c.preferences} /></Sec>
      <Sec title="Commitments" count={pending.length} empty="No open commitments."><ul>{pending.map((x, k) => <li key={k}>{x.text}{x.due ? ` · due ${x.due}` : ""}{x.overdue ? <> <Badge tone="bad">overdue</Badge></> : null} <Src s={x.source} /></li>)}</ul></Sec>
      <Sec title="Objections" count={c.objections.length}><ul>{c.objections.map((x, k) => <li key={k}>“{x.text}” <Src s={x.source} /></li>)}</ul></Sec>
      <Sec title="Deals" count={c.opportunities.length + c.formerEmployerOpportunities.length} empty="No deals linked.">
        <ul>{c.opportunities.map((o) => <li key={o.id}><Link className="text-brand" href={`/deals/${o.id}`}>{o.name}</Link> · {o.stage}</li>)}
          {c.formerEmployerOpportunities.map((o) => <li key={o.id} className="text-ink-soft"><Link className="text-brand" href={`/deals/${o.id}`}>{o.name}</Link> — stays with {o.org_name ?? "the former employer"}</li>)}</ul>
      </Sec>
    </Panel>
  );
}

// ------------------------------------------------------------------ C. Property
export async function PropertyIntelligence({ ctx, assetId }: { ctx: MemCtx; assetId: string }) {
  const c = await getPropertyContext(ctx, assetId).catch(() => undefined);
  if (c === undefined) return <Panel title="property"><Failed what="property" /></Panel>;
  if (!c) return null;
  return (
    <Panel title="property" summary={<>{c.quotations.length} quotes · {c.clientInterest.length} client options</>}>
      <Unknowns xs={c.unknowns} />
      <Extras ctx={ctx} entityType="asset" entityId={assetId} rec={{ assetId }} back={`/buildings/${assetId}`} kind="property" unknowns={c.unknowns}
        facts={[`Developer ${c.developer ?? "unknown"}, landlord ${c.landlord ?? "unknown"}.`, c.latestKnownTerms ? `Latest known terms (historical): ${c.latestKnownTerms.display}.` : "No quotation recorded.", ...c.clientInterest.slice(0, 4).map((x) => `Option for ${x.requirementTitle}: ${x.status}.`), ...c.rejections.slice(0, 3).map((x) => `Rejected by ${x.orgName ?? "a client"}: ${x.reason}.`)]} />
      <Sec title="Overview">
        <p>Also known as: {c.alternateNames.length ? c.alternateNames.join(", ") : "no other names recorded"}</p>
        <p className="text-xs text-ink-soft">Developer: {c.developer ?? UNKNOWN} · Landlord: {c.landlord ?? UNKNOWN} · Manager: {c.propertyManager ?? UNKNOWN}</p>
      </Sec>
      <Sec title="Latest known commercial terms">{c.latestKnownTerms ? <Items xs={[c.latestKnownTerms]} /> : <p className="text-ink-soft">No quotation recorded — current pricing unknown.</p>}</Sec>
      <Sec title="Historical quotations" count={c.quotations.length} empty="None."><p className="text-xs text-warn">Old quotes are history, not current pricing or availability.</p><Items xs={c.quotations} /></Sec>
      <Sec title="Availability observations" count={c.availabilityHistory.length} empty="No availability observed."><Items xs={c.availabilityHistory.slice(0, 12)} /></Sec>
      <Sec title="Rent / CAM changes" count={c.valueChanges.length}><ul>{c.valueChanges.map((v, k) => <li key={k}>{v.spaceLabel}: {v.field.toUpperCase()} {v.from} → {v.to} ({v.fromAsOf} → {v.toAsOf})</li>)}</ul></Sec>
      <Sec title="Client interest & related requirements" count={c.clientInterest.length}><ul>{c.clientInterest.map((x, k) => <li key={k}><Link className="text-brand" href={`/requirements/${x.requirementId}`}>{x.requirementTitle}</Link>{x.orgName ? ` (${x.orgName})` : ""} · {x.status}</li>)}</ul></Sec>
      <Sec title="Rejections & reasons" count={c.rejections.length}><ul>{c.rejections.map((x, k) => <li key={k}>{x.orgName ?? x.requirementTitle ?? "Client"}: {x.reason} <Badge tone={x.explicit ? "bad" : "neutral"}>{x.explicit ? "client said no" : "did not fit"}</Badge> <span className="text-xs text-ink-soft">{d(x.at)} · {x.source}</span></li>)}</ul></Sec>
      <Link className="text-xs text-brand underline" href={`/intelligence/timeline?asset=${assetId}`}>Full timeline</Link>
    </Panel>
  );
}

// ------------------------------------------------------------------ D. Requirement (also used on deal pages)
export async function RequirementIntelligence({ ctx, requirementId, opportunityId }: { ctx: MemCtx; requirementId: string; opportunityId?: string }) {
  const c = await getRequirementContext(ctx, requirementId).catch(() => undefined);
  if (c === undefined) return <Panel title="requirement"><Failed what="requirement" /></Panel>;
  if (!c) return null;
  const key = c.current.filter((f) => ["area", "seats", "budget", "budget_basis", "preferred_locations", "occupation_date", "decision_date", "objective", "fitout_standard", "parking"].includes(f.category.split(".")[1]));
  return (
    <Panel title="requirement" summary={<>{c.changes.length} changes{c.stale ? " · stale" : ""}{c.isHistorical ? " · closed" : ""}</>}>
      <Extras ctx={ctx} entityType="requirement" entityId={requirementId} rec={opportunityId ? { opportunityId } : { requirementId }} back={opportunityId ? `/deals/${opportunityId}` : `/requirements/${requirementId}`} kind="requirement" unknowns={key.filter((f) => f.display === UNKNOWN).map((f) => f.label)}
        facts={[...key.filter((f) => f.display !== UNKNOWN).map((f) => `${f.label}: ${f.display} (${f.confidenceLabel}).`), ...c.changes.slice(0, 3).map((x) => `${x.label} changed from ${fmt(x.from)} to ${fmt(x.to)}.`), ...c.decisionMakers.map((p) => `Decision-maker: ${p.name} (${p.role}).`)]} />
      {c.stale ? <p className="text-xs text-warn">Not updated for over 6 months — treat as possibly outdated.</p> : null}
      <Sec title="Current requirement">
        <ul className="space-y-0.5">{key.map((f) => <li key={f.category} className="break-words">{f.label}: <span className={f.display === UNKNOWN ? "text-ink-soft" : ""}>{f.display}</span> <Badge tone={C[f.confidenceClass]}>{f.confidenceLabel}</Badge></li>)}</ul>
      </Sec>
      <Sec title="What changed" count={c.changes.length} empty="No changes since it was first recorded.">
        <ul>{c.changes.map((x, k) => <li key={k}>{d(x.at)} · {x.label}: <span className="text-ink-soft line-through">{fmt(x.from)}</span> → {fmt(x.to)} <span className="text-xs text-ink-soft">(v{x.fromVersion}→v{x.toVersion}{x.reason ? `, ${x.reason}` : ""})</span></li>)}</ul>
      </Sec>
      <Sec title="Decision-makers" count={c.decisionMakers.length} empty="Unknown — nobody mapped."><ul>{c.decisionMakers.map((p) => <li key={p.personId}><Link className="text-brand" href={`/people/${p.personId}`}>{p.name}</Link> · {p.role}{p.stillAtCompany ? "" : <> <Badge tone="warn">no longer at company</Badge></>}</li>)}</ul></Sec>
      <Sec title="Previous property options" count={c.options.length}><ul>{c.options.map((o) => <li key={o.id}>{o.assetId ? <Link className="text-brand" href={`/buildings/${o.assetId}`}>{o.assetName ?? "Building"}</Link> : "Building"} · {o.status}</li>)}</ul></Sec>
      <Sec title="Rejection reasons" count={c.rejections.length}><ul>{c.rejections.map((x, k) => <li key={k}>{x.assetName ?? "Building"}: {x.reason} <Badge tone={x.explicit ? "bad" : "neutral"}>{x.explicit ? "client said no" : "did not fit"}</Badge></li>)}</ul></Sec>
      <Sec title="Outstanding questions" count={c.outstandingQuestions.length}><ul>{c.outstandingQuestions.slice(0, 10).map((x) => <li key={x.key}>{x.question}{x.priority === "mandatory" ? " *" : ""}</li>)}</ul></Sec>
      <Link className="text-xs text-brand underline" href={`/intelligence/timeline?requirement=${requirementId}`}>Full timeline</Link>
    </Panel>
  );
}
const fmt = (v: unknown) => (v === null || v === undefined || (Array.isArray(v) && v.every((x) => x == null)) ? "unknown" : Array.isArray(v) ? v.map((x) => x ?? "?").join("–") : String(v));
