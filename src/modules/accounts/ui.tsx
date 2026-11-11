import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, FactBadge, inr, sf } from "@/components/ui";
import { Section, fmtDate } from "@/modules/admin/ui/parts";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { setLevelAction } from "./actions";
import * as R from "./rules";
import { MODEL_LABEL, type Account } from "./service";

/* Account & contact workspace UI. Server components; mobile-first (single column at 375px, tab bar scrolls sideways). */
type Row = Record<string, any>;

export function CouldNotLoad({ what, error }: { what: string; error: string }) {
  return <div role="alert" className="rounded-2xl border border-bad/30 bg-bad/5 px-4 py-3 text-sm text-bad"><strong>Couldn&apos;t load {what}.</strong> {error}. Reload the page to try again; other sections are unaffected.</div>;
}
function Guard<T>({ r, what, children }: { r: R.Loaded<T>; what: string; children: (d: T) => ReactNode }) {
  return r.ok ? <>{children(r.data)}</> : <CouldNotLoad what={what} error={r.error} />;
}

export const TABS = ["overview", "occupancy", "people", "requirements", "signals", "scores", "timeline", "meetings", "deals", "documents", "actions"] as const;
export type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", occupancy: "Occupancy", people: "People", requirements: "Requirements", signals: "Signals", scores: "Scores", timeline: "Timeline", meetings: "Meetings", deals: "Deals", documents: "Documents", actions: "Next actions" };

export function counts(a: Account): Partial<Record<Tab, number | null>> {
  const n = <T,>(r: R.Loaded<T[]>) => (r.ok ? r.data.length : null);
  return {
    occupancy: n(a.leases), people: a.people.ok ? a.people.data.groups.reduce((x, g) => x + g.people.length, 0) : null, requirements: n(a.reqs), signals: n(a.signals),
    scores: a.scores.ok ? a.scores.data.filter((s) => s.is_current).length : null, timeline: a.timeline.ok ? a.timeline.data.interactions.length + a.timeline.data.outreach.length : null,
    meetings: n(a.meetings), deals: n(a.opps), documents: n(a.documents), actions: a.actions.length,
  };
}

export function TabBar({ base, tab, c, asOf }: { base: string; tab: Tab; c: Partial<Record<Tab, number | null>>; asOf?: string | null }) {
  return (
    <nav aria-label="Account sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {TABS.map((t) => {
          const on = t === tab; const v = c[t];
          return <li key={t}><Link href={`${base}?tab=${t}${asOf ? `&as_of=${asOf}` : ""}`} aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm ${on ? "border-brand font-semibold text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
            {TAB_LABEL[t]}{v === null ? <span className="text-xs text-bad" title="Couldn't load">!</span> : v !== undefined ? <span className={`rounded-full px-1.5 text-xs tabular-nums ${on ? "bg-brand-soft text-brand" : "bg-canvas"}`}>{v}</span> : null}
          </Link></li>;
        })}
      </ul>
    </nav>
  );
}

const KIND_LABEL: Record<R.ChangeKind, string> = { signal: "Signals", score: "Scores", interaction: "Interactions", requirement: "Requirements", lease: "Leases" };
const KIND_TAB: Record<R.ChangeKind, Tab> = { signal: "signals", score: "scores", interaction: "timeline", requirement: "requirements", lease: "occupancy" };

/** The one prominent element: what moved since this user last opened the account. */
export function ChangedStrip({ a, base }: { a: Account; base: string }) {
  if (!a.sinceOk) return <CouldNotLoad what="your last visit" error="Changes since your last look are unavailable" />;
  if (!a.viewedAt) return <p className="rounded-2xl border-l-4 border-brand bg-brand-soft px-4 py-3 text-sm text-ink">First time you&apos;re opening this account here. Next time, this strip lists what changed in between.</p>;
  const by = new Map<R.ChangeKind, R.Change[]>();
  for (const c of a.changes) by.set(c.kind, [...(by.get(c.kind) ?? []), c]);
  return (
    <section aria-label="What changed since you last looked" className="rounded-2xl border-l-4 border-brand bg-brand-soft px-4 py-3">
      <p className="text-sm font-semibold text-ink">Since you last looked <span className="font-normal text-ink-soft">({fmtDate(a.viewedAt, true)})</span></p>
      {a.changes.length ? (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {[...by.entries()].map(([k, xs]) => (
            <li key={k} className="text-sm">
              <Link className="font-medium text-brand" href={`${base}?tab=${KIND_TAB[k]}`}>{KIND_LABEL[k]}: {xs.length}</Link>
              <ul className="text-ink-soft">{xs.slice(0, 3).map((x) => <li key={x.id} className="truncate">{x.what === "new" ? "New" : "Updated"} · {x.label}</li>)}</ul>
            </li>))}
        </ul>
      ) : <p className="mt-1 text-sm text-ink-soft">Nothing new in signals, scores, interactions, requirements or leases.</p>}
    </section>
  );
}

export function NextActions({ a }: { a: Account }) {
  return (
    <Section title="Next actions" empty="Nothing pending. Actions appear here from open deals, lease events, missing requirement details and contact gaps.">
      {a.actions.length ? <ul className="divide-y divide-line">{a.actions.map((x) => (
        <li key={x.key} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
          <div className="min-w-0"><Link href={x.href} className="font-medium text-brand">{x.text}</Link><p className="text-xs text-ink-soft">{x.why}</p></div>
          {x.due ? <Badge tone="warn">due {fmtDate(x.due)}</Badge> : null}
        </li>))}</ul> : null}
      {a.tasks.ok && a.tasks.data.length ? <ul className="mt-3 space-y-1 text-sm">{a.tasks.data.map((t: Row) => <li key={t.id}>Task: {t.title} <span className="text-ink-soft">{t.due_at ? `due ${fmtDate(t.due_at)}` : "no due date"}</span></li>)}</ul> : null}
      {!a.tasks.ok ? <CouldNotLoad what="tasks" error={a.tasks.error} /> : null}
    </Section>
  );
}

const area = (v: unknown, basis?: string | null) => (v == null ? "unknown" : `${sf(v as number)}${basis ? ` ${basis}` : ""}`);
const months = (v: unknown) => (v == null ? "unknown" : `${v} months`);

export function Occupancy({ a }: { a: Account }) {
  return <Guard r={a.leases} what="occupancy">{(ls) => {
    const cur = ls.filter((l) => !l.historical), past = ls.filter((l) => l.historical);
    const Item = ({ l }: { l: Row }) => {
      const ev = (t: string) => l.events.find((e: Row) => e.event_type === t);
      const notice = ev("notice_deadline");
      return (
        <li className="py-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            {l.asset ? <Link className="font-medium text-brand" href={`/buildings/${l.asset.id}`}>{l.asset.name}</Link> : <span className="font-medium">{l.tenant_name_raw ?? "Unlinked site"}</span>}
            {l.space ? <span className="text-ink-soft">{[l.space.floor_text && `floor ${l.space.floor_text}`, l.space.unit && `unit ${l.space.unit}`].filter(Boolean).join(", ") || "floor/unit unknown"}</span> : <span className="text-ink-soft">floor/unit unknown</span>}
            <FactBadge status={l.fact_status} />
          </div>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-3">
            <div><dt className="inline text-ink-soft">Leased area </dt><dd className="inline">{area(l.area_sf, l.area_basis)}</dd></div>
            <div><dt className="inline text-ink-soft">Carpet </dt><dd className="inline">{area(l.space?.carpet_sf)}</dd></div>
            <div><dt className="inline text-ink-soft">Chargeable </dt><dd className="inline">{area(l.space?.chargeable_sf)}</dd></div>
            <div><dt className="inline text-ink-soft">Seats </dt><dd className="inline">{l.space?.seats ?? "unknown"}</dd></div>
            <div><dt className="inline text-ink-soft">Start </dt><dd className="inline">{l.start_date ? fmtDate(l.start_date) : "unknown"}</dd></div>
            <div><dt className="inline text-ink-soft">Expiry </dt><dd className="inline">{l.contractual_expiry ? fmtDate(l.contractual_expiry) : "unknown"}</dd></div>
            <div><dt className="inline text-ink-soft">Tenure </dt><dd className="inline">{months(l.tenure_months_raw)}</dd></div>
            <div><dt className="inline text-ink-soft">Lock-in </dt><dd className="inline">{months(l.lockin_months_raw)}{ev("lockin_end") ? ` (ends ${fmtDate(ev("lockin_end").event_date)})` : ""}</dd></div>
            <div><dt className="inline text-ink-soft">Notice </dt><dd className="inline">{notice ? `${notice.notice_days ?? "?"} days, by ${fmtDate(notice.event_date)}` : "unknown"}</dd></div>
            <div><dt className="inline text-ink-soft">Break </dt><dd className="inline">{ev("break_option") ? fmtDate(ev("break_option").event_date) : "none recorded"}</dd></div>
          </dl>
          <p className="mt-1 text-xs text-ink-soft">Source: {l.registration_ref ? `registration ${l.registration_ref}` : l.source_object_id ? "imported document" : "not recorded"}{l.events.some((e: Row) => e.needs_review) ? " · some dates need review" : ""}</p>
        </li>);
    };
    return (
      <div className="space-y-4">
        <Section title="Current occupancy" empty="No current lease recorded. Lease imports and registrations add occupancy here.">
          {cur.length ? <ul className="divide-y divide-line">{cur.map((l) => <Item key={l.id} l={l} />)}</ul> : null}
        </Section>
        <Section title="Historical occupancy" empty="No past leases recorded.">
          {past.length ? <ul className="divide-y divide-line">{past.map((l) => <Item key={l.id} l={l} />)}</ul> : null}
        </Section>
      </div>);
  }}</Guard>;
}

export function LevelBadge({ level }: { level: string | null | undefined }) {
  if (!level || !R.isLevel(level)) return <Badge>Level not set</Badge>;
  return <Badge tone={R.LEVEL_TONE[level]}>{R.LEVEL_LABEL[level]}</Badge>;
}

export function StakeholderMap({ a, orgId }: { a: Account; orgId: string }) {
  return (
    <div className="space-y-4">
      <Guard r={a.people} what="people">{(p) => (
        <Section title="Stakeholder map" empty={<>No current contacts at this company. <Link className="text-brand" href={`/contacts/company/${orgId}`}>Find the buying group</Link>.</>}>
          {p.groups.length ? <div className="grid gap-4 sm:grid-cols-2">{p.groups.map((g) => (
            <div key={g.fn}>
              <h3 className="mb-1 text-sm font-semibold">{g.label} <span className="font-normal text-ink-soft">({g.people.length})</span></h3>
              <ul className="space-y-2">{g.people.map((x) => (
                <li key={x.personId} className="rounded-xl border border-line p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5"><Link className="font-medium text-brand" href={`/people/${x.personId}`}>{x.name}</Link><Badge tone={x.influence === "decides" ? "brand" : x.influence === "approves" ? "accent" : "neutral"}>{R.INFLUENCE_LABEL[x.influence]}</Badge></div>
                  <p className="text-xs text-ink-soft">{x.title ?? "Designation unknown"}{x.stakeholderRoles.length ? ` · ${x.stakeholderRoles.join(", ")}` : ""}</p>
                  <div className="mt-1 flex flex-wrap gap-1"><LevelBadge level={x.level} />{x.channel ? <Badge tone="ok">{x.channel.type}{x.channel.verifiedOn ? ` verified ${fmtDate(x.channel.verifiedOn)}` : " verified"}</Badge> : <Badge tone="warn">no verified channel</Badge>}</div>
                </li>))}</ul>
            </div>))}</div> : null}
        </Section>)}</Guard>
      <Guard r={a.warm} what="introduction paths">{(w) => (
        <Section title="Warm introduction paths" empty="No recorded introduction route to the decision-makers. Ask before assuming anyone will introduce you.">
          {w.length ? <ul className="space-y-2 text-sm">{w.map((x) => (
            <li key={x.target.personId}><span className="font-medium">{x.target.name}</span>
              <ul className="text-ink-soft">{x.paths.map((pp) => <li key={pp.personId}>via <Link className="text-brand" href={`/people/${pp.personId}`}>{pp.name}</Link> ({pp.theirLink}; you: {pp.yourLink}) {pp.introPermission ? <Badge tone="ok">intro permitted</Badge> : <Badge tone="warn">permission not recorded</Badge>}</li>)}</ul></li>))}</ul> : null}
        </Section>)}</Guard>
      <Guard r={a.people} what="past people">{(p) => (
        <Section title="Past people (history kept)" empty="No former employees recorded.">
          {p.past.length ? <ul className="space-y-1 text-sm">{p.past.map((e: Row) => <li key={e.id} className="text-ink-soft"><Link className="text-brand" href={`/people/${e.person_id}`}>{e.person?.full_name ?? "Contact"}</Link>{e.title ? ` · ${e.title}` : ""}{e.end_date ? ` · left ${fmtDate(e.end_date)}` : ""}</li>)}</ul> : null}
        </Section>)}</Guard>
    </div>);
}

export function Requirements({ a, orgId, canEdit }: { a: Account; orgId: string; canEdit: boolean }) {
  return <Guard r={a.reqs} what="requirements">{(rs) => (
    <Section title="Requirements (each kept separate)" empty="No requirements for this company." footer={canEdit ? <Link className="text-sm text-brand" href={`/requirements/new?org=${orgId}`}>+ New requirement</Link> : null}>
      {rs.length ? <ul className="divide-y divide-line">{rs.map((r) => (
        <li key={r.id} className="py-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5"><Link className="font-medium text-brand" href={`/requirements/${r.id}`}>{r.title}</Link><Badge>{String(r.status).replace(/_/g, " ")}</Badge>
            {r.score ? <Badge tone="brand">Readiness {r.score.score} · {r.score.band}</Badge> : <Badge>Readiness not scored</Badge>}</div>
          <p className="text-xs text-ink-soft">{r.area_min_sf || r.area_target_sf || r.area_max_sf ? `${r.area_min_sf ?? "?"}–${r.area_max_sf ?? "?"} sf${r.area_basis ? ` ${r.area_basis}` : ""}` : "Area unknown"} · {r.seats_target ? `${r.seats_target} seats` : "seats unknown"} · {r.budget_min || r.budget_max ? `budget ${inr(r.budget_min, { compact: true })}–${inr(r.budget_max, { compact: true })}${r.budget_basis ? ` ${r.budget_basis}` : ""}` : "budget unknown"} · move-in {r.occupation_date ? fmtDate(r.occupation_date) : "unknown"}</p>
          {r.score?.missing?.length ? <p className="mt-1 text-xs text-warn">Missing: {r.score.missing.join(", ")}</p> : null}
        </li>))}</ul> : null}
    </Section>)}</Guard>;
}

export function Signals({ a }: { a: Account }) {
  return <Guard r={a.signals} what="signals">{(ss) => (
    <Section title="Signals" empty="No signals yet. Research and public-signal jobs add them with evidence.">
      {ss.length ? <ul className="divide-y divide-line">{ss.map((s) => (
        <li key={s.id} className="py-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5"><Link className="font-medium text-brand" href={`/signals/${s.id}`}>{s.title}</Link><Badge tone={s.verification === "fact" ? "ok" : "warn"}>{s.verification === "fact" ? "Verified" : s.verification}</Badge>{s.confidence ? <Badge>{s.confidence} confidence</Badge> : null}{s.event_date ? <span className="text-xs text-ink-soft">{fmtDate(s.event_date)}</span> : null}</div>
          {s.support.length ? <ul className="mt-1 text-xs text-ink-soft">{s.support.slice(0, 2).map((e: Row, i: number) => <li key={i}>Evidence: {e.excerpt ? `“${e.excerpt}”` : e.source_name ?? "source"}{e.source_url ? <> · <a className="underline" href={e.source_url} target="_blank" rel="noreferrer noopener">source</a></> : null}</li>)}</ul> : <p className="text-xs text-ink-soft">No evidence attached.</p>}
          {s.counter.length ? <ul className="mt-1 text-xs text-bad">{s.counter.map((e: Row, i: number) => <li key={i}>Counter-evidence: {e.excerpt ?? e.note ?? e.source_name ?? "recorded"}</li>)}</ul> : null}
          {s.missing_info?.length ? <p className="mt-1 text-xs text-warn">To verify: {s.missing_info.join(", ")}</p> : null}
        </li>))}</ul> : null}
    </Section>)}</Guard>;
}

export function Scores({ a }: { a: Account }) {
  return <Guard r={a.scores} what="scores">{(rows) => {
    const cur = rows.filter((s) => s.is_current && ["lead", "requirement", "opportunity", "relationship", "company"].includes(s.model_key));
    return (
      <Section title="Separate assessments" empty="Not scored yet. Scores are calculated from recorded data; missing data lowers completeness rather than being guessed.">
        {cur.length ? <ul className="grid gap-3 sm:grid-cols-2">{cur.map((s) => {
          const d = R.scoreDelta(s.score, s.previous_score);
          const why = ((s.factors ?? []) as Row[]).filter((f) => f.points > 0).sort((x, y) => y.points - x.points).slice(0, 3);
          return (
            <li key={s.id} className="rounded-xl border border-line p-3 text-sm">
              <div className="flex items-baseline justify-between gap-2"><span className="font-medium">{MODEL_LABEL[s.model_key] ?? s.model_key}</span><span className="text-xl font-semibold tabular-nums">{s.score}</span></div>
              <p className="text-xs text-ink-soft">{s.band}{s.confidence ? ` · ${s.confidence} confidence` : ""} · evidence completeness {s.completeness ?? "unknown"}%</p>
              <p className="mt-1 text-xs">{d === null ? "First calculation" : d === 0 ? "No change" : <span className={d > 0 ? "text-ok" : "text-bad"}>{d > 0 ? "+" : ""}{d} since last</span>}{s.change_reason ? <span className="text-ink-soft"> · {s.change_reason}</span> : null}</p>
              {why.length ? <ul className="mt-1 text-xs text-ink-soft">{why.map((f) => <li key={f.key}>Why: {f.label} — {f.explanation}</li>)}</ul> : null}
              {s.missing?.length ? <p className="mt-1 text-xs text-warn">Missing: {s.missing.join(", ")}</p> : null}
            </li>);
        })}</ul> : null}
      </Section>);
  }}</Guard>;
}

const promiseText = (p: unknown) => (typeof p === "string" ? p : String((p as Row)?.what ?? (p as Row)?.text ?? JSON.stringify(p)));
export function Timeline({ a }: { a: Account }) {
  return <Guard r={a.timeline} what="interactions">{(t) => (
    <div className="space-y-4">
      <Section title="Interactions" empty="No calls, emails, WhatsApp messages, meetings or visits logged yet.">
        {t.interactions.length ? <ol className="space-y-3 border-l border-line pl-4">{t.interactions.slice(0, 60).map((i) => (
          <li key={i.id} className="text-sm">
            <p className="text-xs text-ink-soft">{fmtDate(i.occurred_at, true)} · <Badge>{i.channel}</Badge>{i.direction ? ` ${i.direction}` : ""}</p>
            <p className="font-medium">{i.subject ?? "(no subject)"}</p>{i.summary ? <p className="text-ink-soft">{i.summary}</p> : null}
            {(i.promises ?? []).length ? <p className="text-xs text-ok">Promised: {(i.promises as unknown[]).map(promiseText).join("; ")}</p> : null}
            {(i.objections ?? []).length ? <p className="text-xs text-bad">Objection: {(i.objections as unknown[]).map(promiseText).join("; ")}</p> : null}
          </li>))}</ol> : null}
      </Section>
      <Section title="Outreach" empty="No outreach planned or sent to this company.">
        {t.outreach.length ? <ul className="space-y-1 text-sm">{t.outreach.map((o: Row) => <li key={o.id}><Link className="text-brand" href={`/outreach/${o.id}`}>{o.person?.full_name ?? "Contact"}</Link> · {o.channel} · <Badge>{o.status}</Badge> <span className="text-xs text-ink-soft">{o.sent_at ? `sent ${fmtDate(o.sent_at)}` : o.planned_on ? `planned ${fmtDate(o.planned_on)}` : ""}{o.responded_at ? ` · replied ${fmtDate(o.responded_at)}` : ""}</span></li>)}</ul> : null}
      </Section>
    </div>)}</Guard>;
}

export function Meetings({ r, addHref }: { r: R.Loaded<Row[]>; addHref?: string }) {
  return <Guard r={r} what="meetings">{(ms) => (
    <Section title="Meetings & visits" empty="No meetings or site visits recorded." footer={addHref ? <Link className="text-sm font-medium text-brand" href={addHref}>+ Log a meeting</Link> : undefined}>
      {ms.length ? <ul className="space-y-1 text-sm">{ms.map((m) => <li key={m.id}><span className="text-xs text-ink-soft">{fmtDate(m.start_at, true)}</span> {m.title ?? "Meeting"} <Badge>{m.kind ?? "meeting"}</Badge>{m.status ? <span className="text-xs text-ink-soft"> {m.status}</span> : null}{m.location ? <span className="text-xs text-ink-soft"> · {m.location}</span> : null}</li>)}</ul> : null}
    </Section>)}</Guard>;
}

export function Deals({ a }: { a: Account }) {
  return <Guard r={a.opps} what="opportunities">{(os) => (
    <Section title="Opportunities & deals" empty="No opportunity for this company yet.">
      {os.length ? <ul className="divide-y divide-line">{os.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center gap-1.5 py-2 text-sm"><Link className="font-medium text-brand" href={`/deals/${o.id}`}>{o.name}</Link><Badge tone="brand">{String(o.stage).replace(/_/g, " ")}</Badge>{o.outcome ? <Badge>{o.outcome}</Badge> : null}
          <span className="text-xs text-ink-soft">{o.expected_fee ? `fee ${inr(o.expected_fee, { compact: true })}` : "fee unknown"}{o.expected_close ? ` · close ${fmtDate(o.expected_close)}` : ""}</span></li>))}</ul> : null}
    </Section>)}</Guard>;
}

export function Documents({ a }: { a: Account }) {
  return <Guard r={a.documents} what="documents">{(ds) => (
    <Section title="Documents" empty="No documents generated for this company, its requirements or deals.">
      {ds.length ? <ul className="space-y-1 text-sm">{ds.map((d) => <li key={d.id}><Link className="text-brand" href="/documents">{d.purpose ?? d.kind}</Link> <span className="text-xs text-ink-soft">v{d.version_no ?? 1} · {d.status} · {d.linked_entity_type} · {fmtDate(d.created_at)}</span>{d.stale_at ? <Badge tone="warn">stale</Badge> : null}</li>)}</ul> : null}
    </Section>)}</Guard>;
}

// ---------------------------------------------------------------- contact workspace pieces
export function RelationshipLevelCard({ personId, current, ok, suggestion, history, canEdit }: { personId: string; current: Row | null; ok: boolean; suggestion: R.Suggestion | null; history: R.Loaded<Row[]>; canEdit: boolean }) {
  return (
    <Section title="Relationship level">
      {!ok ? <CouldNotLoad what="relationship level" error="Level unavailable" /> : <div className="flex flex-wrap items-center gap-2"><LevelBadge level={current?.level} />{current ? <span className="text-xs text-ink-soft">set {fmtDate(current.set_at)}{current.reason ? ` · ${current.reason}` : ""}</span> : null}</div>}
      {suggestion && suggestion.level !== current?.level ? (
        <div className="mt-3 rounded-xl bg-canvas p-3 text-sm">
          <p>Suggested from interactions: <strong>{R.LEVEL_LABEL[suggestion.level]}</strong></p><p className="text-xs text-ink-soft">{suggestion.reason} Suggestions never set “Good relationship”; only you can.</p>
          {canEdit ? <ActionForm action={setLevelAction.bind(null, personId)} className="mt-2"><input type="hidden" name="level" value={suggestion.level} /><input type="hidden" name="accepted" value="1" /><input type="hidden" name="reason" value={suggestion.reason} /><Submit variant="secondary">Use suggestion</Submit></ActionForm> : null}
        </div>) : null}
      {canEdit ? (
        <ActionForm action={setLevelAction.bind(null, personId)} className="mt-3 space-y-2">
          <select name="level" defaultValue={current?.level ?? ""} aria-label="Relationship level" className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm"><option value="" disabled>Choose a level</option>{R.LEVELS.map((l) => <option key={l} value={l}>{R.LEVEL_LABEL[l]}</option>)}</select>
          <input name="reason" placeholder="Why? (optional)" aria-label="Reason" className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm" />
          <Submit variant="secondary">Save level</Submit>
        </ActionForm>) : null}
      {history.ok && history.data.length > 1 ? <details className="mt-3 text-sm"><summary className="cursor-pointer text-ink-soft">History ({history.data.length})</summary><ul className="mt-1 space-y-0.5 text-xs">{history.data.map((h) => <li key={h.id}>{fmtDate(h.set_at, true)} · {R.isLevel(h.level) ? R.LEVEL_LABEL[h.level] : h.level}{h.basis === "accepted_suggestion" ? " (accepted suggestion)" : ""}{h.reason ? ` · ${h.reason}` : ""}</li>)}</ul></details> : null}
      {!history.ok ? <CouldNotLoad what="level history" error={history.error} /> : null}
    </Section>);
}

export function PastTransactions({ a }: { a: Account }) {
  return <Guard r={a.transactions} what="previous transactions">{(ts) => (
    <Section title="Previous CRE transactions & brokers" empty="No previous transactions recorded. Market imports add them, with the broker where known.">
      {ts.length ? <ul className="space-y-1 text-sm">{ts.map((t: Row) => <li key={t.id}>{t.deal_type ?? "Transaction"}{t.asset ? <> at <Link className="text-brand" href={`/buildings/${t.asset.id}`}>{t.asset.name}</Link></> : null} <span className="text-xs text-ink-soft">{t.period_start ? fmtDate(t.period_start) : "date unknown"} · {t.area_sf ? sf(t.area_sf) : "area unknown"} · broker {t.broker?.display_name ?? t.broker_name_raw ?? "not recorded"}</span></li>)}</ul> : null}
    </Section>)}</Guard>;
}

export { Guard };
