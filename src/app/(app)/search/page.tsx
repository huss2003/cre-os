import { Suspense } from "react";
import Link from "next/link";
import { Badge, ButtonLink, EmptyState, FactBadge, Input, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole, type AppContext } from "@/lib/auth/context";
import { ClassBadge, Loading, fmtDate } from "@/modules/admin/ui/parts";
import {
  AREA_BASES, EVENT_LABEL, EVENT_TYPES, REQ_STATUSES, SCORE_BANDS, decodeFilter, dropChip, encodeFilter, filterChips,
  filterFromForm, isEmptyFilter, type AccountFilter,
} from "@/modules/search/filter";
import { findAccounts, loadPlaces, nlToFilter, resolvePlaceIds } from "@/modules/search/finder";
import { EVERYTHING_LABEL, EVERYTHING_TYPES, hasEverythingCriteria, parseEverythingQuery, searchEverything } from "@/modules/search/everything";

export const metadata = { title: "Search" };

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => { const v = sp[k]; return Array.isArray(v) ? v[0] : v; };
const sel = "min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-sm";
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();

function Tabs({ mode }: { mode: "everything" | "accounts" }) {
  const cls = (on: boolean) => `flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium ${on ? "bg-brand text-white" : "border border-line bg-surface"}`;
  return (
    <nav className="flex gap-2" aria-label="Search mode">
      <Link href="/search" className={cls(mode === "everything")}>Search everything</Link>
      <Link href="/search?mode=accounts" className={cls(mode === "accounts")}>Find accounts</Link>
    </nav>
  );
}

// ------------------------------------------------------------------------------------------- search everything
async function Everything({ ctx, sp }: { ctx: AppContext; sp: SP }) {
  const params = parseEverythingQuery(sp);
  const place = one(sp, "place")?.slice(0, 80) ?? "";
  let unresolvedPlace = false;
  if (place) {
    const r = resolvePlaceIds([place], await loadPlaces(ctx.db, ctx.workspaceId));
    if (r.ids.length) params.geographyIds = r.ids; else unresolvedPlace = true;
  }
  const active = hasEverythingCriteria(params) && !unresolvedPlace;
  const hits = active ? await searchEverything(ctx.db, ctx.workspaceId, params) : [];
  const typeSel = params.types?.length === 1 ? params.types[0] : "";
  return (
    <div className="space-y-4">
      <form action="/search" data-tour="search-form" className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <Input name="q" defaultValue={params.q} placeholder="Company, person, building, lease, task, document…" autoFocus aria-label="Search" />
          <select name="type" defaultValue={typeSel} className={sel} aria-label="Type">
            <option value="">All types</option>
            {EVERYTHING_TYPES.map((t) => <option key={t} value={t}>{EVERYTHING_LABEL[t]}</option>)}
          </select>
          <button className="min-h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white">Search</button>
        </div>
        <details className="rounded-lg border border-line bg-surface p-2 text-sm" open={!!(params.from || params.to || params.statuses || params.source || place)}>
          <summary className="cursor-pointer text-ink-soft">More filters — place, date, status, source</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-5">
            <Input name="place" defaultValue={place} placeholder="Place (e.g. Kharadi)" aria-label="Place" />
            <input type="date" name="from" defaultValue={params.from ?? ""} className={sel} aria-label="From date" />
            <input type="date" name="to" defaultValue={params.to ?? ""} className={sel} aria-label="To date" />
            <Input name="status" defaultValue={params.statuses?.join(",") ?? ""} placeholder="Status (open, done…)" aria-label="Status" />
            <Input name="source" defaultValue={params.source ?? ""} placeholder="Source (signal, upload…)" aria-label="Source" />
          </div>
          <p className="mt-1 text-xs text-ink-soft">Place filters records that have a location (buildings, floors, leases, quotes, companies with a lease or location there). Dates use each record&apos;s key date: lease expiry, meeting start, task due, signal detected, last update.</p>
        </details>
      </form>
      <p className="text-xs text-ink-soft">Results are filtered by your access. Facts keep their status — reported, confirmed and AI inference are never blended.</p>

      {unresolvedPlace ? (
        <EmptyState title={`“${place}” is not in your place list`}>Add it under Geography, or check the spelling. Nothing was searched so results aren&apos;t silently widened.</EmptyState>
      ) : !active ? (
        <EmptyState title="Search across everything you can access"
          action={hasRole(ctx, "editor") ? <div className="flex flex-wrap justify-center gap-2"><ButtonLink variant="secondary" href="/companies/new">Add company</ButtonLink><ButtonLink variant="secondary" href="/buildings/new">Add building</ButtonLink></div> : undefined}>
          Companies, people, buildings, floors, leases, requirements, deals, quotes, meetings, tasks, signals, documents and assistant chats. Type a name, or pick a type and a date range to list records. To find accounts by area, lease event or relationship, use <Link className="text-brand" href="/search?mode=accounts">Find accounts</Link>.
        </EmptyState>
      ) : hits.length === 0 ? (
        <EmptyState title="Nothing found">Check the spelling or loosen a filter. Records you don&apos;t have access to never appear here.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {hits.map((h) => (
            <li key={`${h.entity_type}:${h.id}`} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">{EVERYTHING_LABEL[h.entity_type] ?? h.entity_type}</Badge>
                <Link href={h.href} className="font-medium text-brand">{h.title}</Link>
              </div>
              {h.subtitle ? <p className="mt-0.5 text-sm">{h.subtitle}</p> : null}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                {h.fact_status ? <FactBadge status={h.fact_status} /> : null}
                {h.status_label ? <span>{h.status_label}</span> : null}
                {h.location ? <span>{h.location}</span> : null}
                {h.source ? <span>source: {h.source}</span> : null}
                <ClassBadge value={h.classification} />
                {h.occurred_on ? <span>{fmtDate(h.occurred_on)}</span> : null}
              </div>
            </li>
          ))}
          {hits.length >= params.limit ? <li className="text-xs text-ink-soft">Showing the top {params.limit}. Refine your query or filter by type.</li> : null}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- find accounts
function EditForm({ f, nl }: { f: AccountFilter; nl: string }) {
  const w = f.eventWindow;
  return (
    <details className="rounded-lg border border-line bg-surface p-2 text-sm">
      <summary className="cursor-pointer text-ink-soft">Edit filters</summary>
      <form action="/search" className="mt-2 grid gap-2 sm:grid-cols-3">
        <input type="hidden" name="mode" value="accounts" /><input type="hidden" name="edit" value="1" /><input type="hidden" name="nl" value={nl} />
        <Input name="amin" defaultValue={f.areaMinSf ?? ""} inputMode="numeric" placeholder="Min SF" aria-label="Minimum area SF" />
        <Input name="amax" defaultValue={f.areaMaxSf ?? ""} inputMode="numeric" placeholder="Max SF" aria-label="Maximum area SF" />
        <select name="basis" defaultValue={f.areaBasis ?? "any"} className={sel} aria-label="Area basis">
          {AREA_BASES.map((b) => <option key={b} value={b}>{b === "any" ? "Any basis" : b.replace("_", " ")}</option>)}
        </select>
        <Input name="places" defaultValue={f.places?.join(", ") ?? ""} placeholder="Places (comma separated)" aria-label="Places" />
        <Input name="grades" defaultValue={f.grades?.join(",") ?? ""} placeholder="Grade (A, A+)" aria-label="Building grade" />
        <Input name="sectors" defaultValue={f.sectors?.join(", ") ?? ""} placeholder="Sector" aria-label="Sector" />
        <select name="ev" defaultValue={f.eventTypes?.length === 1 ? f.eventTypes[0] : ""} className={sel} aria-label="Lease event">
          <option value="">Any lease event</option>
          {EVENT_TYPES.map((e) => <option key={e} value={e}>{EVENT_LABEL[e]}</option>)}
        </select>
        <select name="win" defaultValue={!w ? "" : w.kind === "next_calendar_year" ? "next_year" : w.kind === "this_calendar_year" ? "this_year" : w.kind === "within_months" ? "months" : ""} className={sel} aria-label="Event window">
          <option value="">No lease-event filter</option><option value="months">Within N months</option>
          <option value="next_year">Next calendar year</option><option value="this_year">Rest of this year</option>
        </select>
        <Input name="months" defaultValue={w?.kind === "within_months" ? w.months : ""} inputMode="numeric" placeholder="N months" aria-label="Months" />
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" name="known" value="1" defaultChecked={!!f.knownContact} /> Contact I already know</label>
        <Input name="sig" defaultValue={f.signalKinds?.join(", ") ?? ""} placeholder="Signal kind (expansion…)" aria-label="Signal kind" />
        <input type="date" name="since" defaultValue={f.signalSince ?? ""} className={sel} aria-label="Signal since" />
        <select name="bands" defaultValue={f.scoreBands?.join(",") ?? ""} className={sel} aria-label="Lead priority">
          <option value="">Any lead priority</option>
          {SCORE_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          <option value="Very High,High">High or above</option>
        </select>
        <select name="req" defaultValue={f.requirementStatuses?.join(",") ?? ""} className={sel} aria-label="Requirement status">
          <option value="">Any requirement</option>
          <option value="draft,estimated,client_confirmed">Open requirement</option>
          {REQ_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <select name="opp" defaultValue={f.hasOpenOpportunity === undefined ? "" : f.hasOpenOpportunity ? "1" : "0"} className={sel} aria-label="Open deal">
          <option value="">Deal: any</option><option value="1">Has open deal</option><option value="0">No open deal</option>
        </select>
        <button className="min-h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white sm:col-span-3">Apply filters</button>
      </form>
    </details>
  );
}

async function Accounts({ ctx, sp }: { ctx: AppContext; sp: SP }) {
  const nl = (one(sp, "nl") ?? "").slice(0, 500);
  let filter: AccountFilter | null = decodeFilter(one(sp, "f"));
  let understood: string[] = []; let modelFilled: string[] = [];
  if (!filter && one(sp, "edit") === "1") filter = filterFromForm((k) => one(sp, k));
  if (!filter && nl.trim()) {
    const r = await nlToFilter(ctx.db, ctx.workspaceId, nl);
    filter = r.filter; understood = r.understood; modelFilled = r.modelFilled;
  }
  const f = filter ?? {};
  const empty = isEmptyFilter(f);
  const res = empty ? null : await findAccounts(ctx.db, ctx.workspaceId, f);
  const chips = filterChips(f);
  const prompt = nl.trim() || chips.map((c) => c.label).join("; ");
  const cov = res?.coverage;

  return (
    <div className="space-y-4">
      <form action="/search" className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input type="hidden" name="mode" value="accounts" />
        <Input name="nl" defaultValue={nl} placeholder="e.g. companies occupying 15,000–40,000 SF in Kharadi with a lease event next year and a contact I already know" aria-label="Describe the accounts you want" autoFocus />
        <button className="min-h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white">Find</button>
      </form>

      {chips.length ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Filters in use">
          {chips.map((c) => {
            const next = dropChip(f, c.key);
            return (
              <Link key={c.key} href={`/search?${qs({ mode: "accounts", nl, f: isEmptyFilter(next) ? undefined : encodeFilter(next) })}`}
                className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-surface px-3 text-xs" title="Remove this filter">
                {c.label}<span aria-hidden>×</span><span className="sr-only">remove</span>
              </Link>
            );
          })}
          {modelFilled.length ? <span className="text-xs text-ink-soft">(AI filled: {modelFilled.join(", ")})</span> : null}
        </div>
      ) : nl.trim() ? (
        <p className="text-sm text-warn">Couldn&apos;t turn that into filters. Try naming an area range (15k–40k SF), a place, a lease event (expiry next year), or “contact I already know” — or use Edit filters.</p>
      ) : null}
      {understood.length ? <p className="text-xs text-ink-soft">Understood: {understood.map((u) => `“${u}”`).join(", ")}</p> : null}
      <EditForm f={f} nl={nl} />

      {empty ? (
        <EmptyState title="Find accounts by occupancy, lease events and relationships">
          Describe what you want in plain words, or open Edit filters. Every match shows the lease, contact and signal behind it, and we tell you how many companies couldn&apos;t be checked because their lease area or dates are unknown.
        </EmptyState>
      ) : (
        <>
          <div className="rounded-xl border border-line bg-surface p-3 text-sm">
            <p><strong>{cov!.matched}</strong> match{cov!.matched === 1 ? "" : "es"} of {cov!.companiesChecked} compan{cov!.companiesChecked === 1 ? "y" : "ies"} you can see{res!.window ? ` · lease events ${res!.window.from} → ${res!.window.to}` : ""}.</p>
            {cov!.areaUnknown ? <p className="text-warn">{cov!.areaUnknown} otherwise-matching compan{cov!.areaUnknown === 1 ? "y has" : "ies have"} no lease area{f.areaBasis && f.areaBasis !== "any" ? ` on a ${f.areaBasis} basis` : ""} — not evaluated, not excluded as “too small”.</p> : null}
            {cov!.eventsUnknown ? <p className="text-warn">{cov!.eventsUnknown} otherwise-matching compan{cov!.eventsUnknown === 1 ? "y has" : "ies have"} no lease dates — lease events couldn&apos;t be checked.</p> : null}
            {cov!.unresolvedPlaces.length ? <p className="text-warn">Not in your place list: {cov!.unresolvedPlaces.join(", ")} — matched on company location text only.</p> : null}
            {cov!.truncated ? <p className="text-ink-soft">Showing the top 50.</p> : null}
            <Link className="mt-1 inline-block text-brand" href={`/assistant/commands?${qs({ new: "1", prompt: `Find accounts: ${prompt}` })}`}>Save as command</Link>
          </div>
          {res!.results.length === 0 ? (
            <EmptyState title="No accounts match all filters">Remove a filter chip to widen the search. Companies with unknown lease data are counted above, never treated as zero.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {res!.results.map((h) => (
                <li key={h.orgId} className="rounded-xl border border-line bg-surface p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/companies/${h.orgId}`} className="font-medium text-brand">{h.name}</Link>
                    {h.sector ? <span className="text-xs text-ink-soft">{h.sector}</span> : null}
                    {h.scoreBand ? <Badge tone="brand">{h.scoreBand}{h.score !== null ? ` · ${h.score}` : ""}</Badge> : null}
                  </div>
                  {h.areaSf !== null ? <p className="mt-1">Occupies {Math.round(h.areaSf).toLocaleString("en-IN")} SF {h.areaBasis ?? ""} across {h.leasesWithArea} lease{h.leasesWithArea === 1 ? "" : "s"}{h.leasesInScope && h.leasesWithArea !== null && h.leasesInScope > h.leasesWithArea ? ` (${h.leasesInScope - h.leasesWithArea} more with unknown area)` : ""}</p> : null}
                  {h.leases?.length ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {h.leases.slice(0, 3).map((l) => (
                        <li key={l.id} className="flex flex-wrap items-center gap-1">
                          {l.assetId ? <Link className="text-brand" href={`/buildings/${l.assetId}`}>{l.building}</Link> : <span>{l.building ?? "Building unknown"}</span>}
                          <span>{l.areaSf !== null ? `${Math.round(Number(l.areaSf)).toLocaleString("en-IN")} SF ${l.areaBasis ?? "(basis unknown)"}` : "area unknown"}</span>
                          {l.grade ? <span>· Grade {l.grade}</span> : null}
                          {l.expiry ? <span>· expires {l.expiry}</span> : null}
                          {l.factStatus ? <FactBadge status={l.factStatus} /> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {h.events?.length ? <p className="mt-1 text-xs">Lease events: {h.events.slice(0, 3).map((e) => `${EVENT_LABEL[e.type as keyof typeof EVENT_LABEL] ?? e.type} ${e.date}${e.confirmed ? " (confirmed)" : ""}`).join(" · ")}</p> : null}
                  {h.contacts?.length ? (
                    <p className="mt-1 text-xs">Known: {h.contacts.slice(0, 3).map((c, n) => <span key={c.personId}>{n ? ", " : ""}<Link className="text-brand" href={`/people/${c.personId}`}>{c.name}</Link>{c.title ? ` (${c.title})` : ""} — {c.basis}</span>)}</p>
                  ) : null}
                  {h.signals?.length ? <p className="mt-1 text-xs">Signal: {h.signals.slice(0, 2).map((s, n) => <span key={s.id}>{n ? " · " : ""}<Link className="text-brand" href={`/signals/${s.id}`}>{s.title}</Link> ({s.detectedAt})</span>)}</p> : null}
                  {h.requirements?.length ? <p className="mt-1 text-xs">Requirement: {h.requirements.slice(0, 2).map((r, n) => <span key={r.id}>{n ? " · " : ""}<Link className="text-brand" href={`/requirements/${r.id}`}>{r.title}</Link> ({r.status})</span>)}</p> : null}
                  {h.opportunities?.length ? <p className="mt-1 text-xs">Open deal: {h.opportunities.slice(0, 2).map((o, n) => <span key={o.id}>{n ? " · " : ""}<Link className="text-brand" href={`/deals/${o.id}`}>{o.name}</Link> ({o.stage.replace(/_/g, " ")})</span>)}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

async function Body({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const mode = one(sp, "mode") === "accounts" ? "accounts" : "everything";
  return (
    <div className="space-y-4">
      <Tabs mode={mode} />
      {mode === "accounts" ? <Accounts ctx={ctx} sp={sp} /> : <Everything ctx={ctx} sp={sp} />}
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<SP> }) {
  return (
    <>
      <PageHeader title="Search" />
      <Suspense fallback={<Loading label="Searching…" />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
