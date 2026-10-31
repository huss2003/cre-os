import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Textarea, Table, Td, Stat, sf } from "@/components/ui";
import { insightsOverview } from "@/modules/intelligence/insights/service";
import { Flash, Bars, Sev, fmtDay, label } from "@/modules/intelligence/ui";
import { playbookAction, experimentAction } from "./actions";

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const d = await insightsOverview(ctx.db, ctx.workspaceId);
  const f = d.funnel;
  const latest = f.cohorts[0];
  const last6 = [...f.cohorts].slice(0, 6).reverse();

  return (
    <div>
      <PageHeader title="Insights" subtitle="Descriptive cohort reporting — no predictive scores. Targets are your planning assumptions, not forecasts." />
      <Flash sp={sp} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Approaches ${latest?.month ?? ""}`} value={latest?.approaches ?? 0} hint={`Target ${f.targets.base.approaches} (${f.targets.base.label}) / ${f.targets.pace.approaches}`} />
        <Stat label="Discussions (cohort)" value={latest?.discussions ?? 0} hint={`Target ${f.targets.base.discussions} / ${f.targets.pace.discussions} per month`} />
        <Stat label="Open deals" value={d.openOpps.length} />
        <Stat label="Drafts not counted" value={f.draftsExcluded} hint="Drafts and follow-ups are never approaches" />
      </div>

      <Card title="Cohort funnel — approaches by first-approach month" className="mb-4">
        {f.cohorts.length === 0 ? <EmptyState title="No outreach recorded yet">An approach is the first outbound interaction actually made to a distinct company. Log calls/emails in Capture or connect your mailbox; drafts don&apos;t count.</EmptyState> : (
          <>
            <Bars rows={last6.map((c) => ({ label: c.month, value: c.approaches }))} target={{ value: f.targets.base.approaches, label: `${f.targets.base.approaches}/month (1 closure/month); pace target ${f.targets.pace.approaches}` }} />
            <div className="mt-3"><Table head={["Cohort", "Approaches", "Inbound-first", "People", "Touches", "Discussions", "Closures", "vs 120", "vs 170"]}>
              {f.cohorts.slice(0, 12).map((c) => <tr key={c.month}><Td>{c.month}</Td><Td>{c.approaches}</Td><Td>{c.inbound_first}</Td><Td>{c.people_touched}</Td><Td>{c.total_touches}</Td><Td>{c.discussions}</Td><Td>{c.closures}</Td><Td>{c.vs_base}%</Td><Td>{c.vs_pace}%</Td></tr>)}
            </Table></div>
            <p className="mt-1 text-xs text-ink-soft">Discussions/closures are counted once per company in the month it was first approached. Inbound/referral companies are a separate channel. {f.unlinkedInteractions > 0 ? `${f.unlinkedInteractions} interaction(s) aren't linked to a company and can't be counted.` : ""}</p>
          </>
        )}
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Stage conversion">
          {f.opps.length === 0 ? <p className="text-sm text-ink-soft">No opportunities yet.</p> : <Bars rows={f.conversion.filter((c) => c.reached > 0).map((c) => ({ label: label(c.stage), value: c.reached, note: c.conversion_from_previous !== null ? `${c.conversion_from_previous}% of previous` : undefined }))} />}
        </Card>
        <Card title="Time to stage (days from creation)">
          {f.opps.length === 0 ? <p className="text-sm text-ink-soft">No opportunities yet.</p> : (
            <ul className="space-y-1 text-sm">{f.timeToStage.map((t) => <li key={t.stage}>{label(t.stage)}: median {t.median_days ?? "—"} · P75 {t.p75_days ?? "—"} <span className="text-xs text-ink-soft">(n={t.n}; {t.censored_open} open, not yet reached)</span></li>)}</ul>
          )}
        </Card>
        <Card title="Lost / no-decision learning">
          {f.lost.length === 0 ? <p className="text-sm text-ink-soft">No lost, dormant or disqualified deals recorded.</p> : <ul className="space-y-1 text-sm">{f.lost.map((l, i) => <li key={i}><Badge>{l.outcome}</Badge> {l.reason} — {l.count}</li>)}</ul>}
        </Card>
        <Card title="Freshness">
          <ul className="space-y-1 text-sm">{d.freshness.map((x) => <li key={x.label}>{x.label}: <span className={x.stale ? "font-medium text-warn" : ""}>{x.stale}</span>{x.total !== null ? ` / ${x.total}` : ""}</li>)}</ul>
          <p className="mt-2 text-xs"><Link className="text-brand" href="/research">Open the evidence patrol →</Link></p>
        </Card>
      </div>

      <Card title="Deal health" className="mb-4">
        {d.openOpps.length === 0 ? <p className="text-sm text-ink-soft">No open deals.</p> : (
          <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">{d.openOpps.slice(0, 40).map((o) => <li key={o.id}><Link className="text-brand" href={`/insights/deals/${o.id}`}>Strategist view</Link> · <Badge>{label(o.stage)}</Badge> <span className="text-xs text-ink-soft">since {fmtDay(o.stage_entered_at ?? o.created_at)}</span></li>)}</ul>
        )}
      </Card>

      <Card title="Procurement-cycle map (requirement confirmed onward)" className="mb-4">
        {d.procurement.length === 0 ? <p className="text-sm text-ink-soft">No open deals at requirement-confirmed or later.</p> : (
          <div className="space-y-3">{d.procurement.map((p) => (
            <div key={p.opportunity_id} className="text-sm"><Link className="font-medium text-brand" href={`/insights/deals/${p.opportunity_id}`}>{p.name}</Link> <Badge>{label(p.stage)}</Badge>
              <span className="text-xs text-ink-soft"> · decision {p.decision_date ?? "unknown"} · lead time {p.total_lead_days} days{p.latest_start ? ` · latest start ${p.latest_start}` : ""}</span>
              <div className="mt-1 flex flex-wrap gap-1">{p.steps.map((s) => <Badge key={s.key} tone={s.owner_involved ? "ok" : "warn"} title={s.basis}>{s.label}: {s.lead_days}d{s.basis !== "recorded" ? "*" : ""}{s.owner_involved ? "" : " · owner not mapped"}</Badge>)}</div></div>
          ))}<p className="text-xs text-ink-soft">* operating default — confirm the real lead time with the client.</p></div>
        )}
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Client portfolio view">
          {d.leases.portfolio.length === 0 ? <EmptyState title="No leases on file">Import lease data to see expiry ladders by client.</EmptyState> : (
            <ul className="space-y-2 text-sm">{d.leases.portfolio.slice(0, 15).map((p) => (
              <li key={p.key}><span className="font-medium">{p.tenant}</span> · {p.sites} site(s) · {p.total_area_sf !== null ? sf(p.total_area_sf) : "area unknown"}{p.area_unknown_sites ? ` (+${p.area_unknown_sites} unknown)` : ""}
                <div className="text-xs text-ink-soft">{p.ladder.map((l) => `${l.building}: ${l.expiry ?? "expiry unknown"}`).join(" · ")}</div>{p.consolidation_hint && <div className="text-xs text-accent">{p.consolidation_hint}</div>}</li>
            ))}</ul>
          )}
        </Card>
        <Card title="Landlord retention / expiry concentration (next 3 years)">
          {d.leases.concentration.length === 0 ? <p className="text-sm text-ink-soft">No dated lease events in the next three years.</p> : (
            <ul className="space-y-2 text-sm">{d.leases.concentration.slice(0, 15).map((c) => (
              <li key={`${c.landlord}|${c.building}`}><span className="font-medium">{c.landlord}</span> · {c.building} — {c.total_events} event(s)
                <div className="text-xs text-ink-soft">{c.quarters.map((q) => `${q.quarter}: ${q.events}${q.area_sf ? ` (${sf(q.area_sf)}${q.area_unknown ? ` + ${q.area_unknown} unknown` : ""})` : ""}`).join(" · ")}</div></li>
            ))}</ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Experiments">
          {d.experiments.length === 0 ? <p className="mb-3 text-sm text-ink-soft">No experiments yet. Compare triggers or personas with enough samples and identical outcome windows.</p> : (
            <ul className="mb-3 space-y-3 text-sm">{d.experiments.map(({ experiment: e, summary: s }) => (
              <li key={String(e.id)}><span className="font-medium">{String(e.name)}</span> <Badge>{String(e.status)}</Badge><div className="text-xs text-ink-soft">{String(e.hypothesis)}</div>
                <ul className="text-xs">{s.variants.map((v) => <li key={v.key}>{v.label}: {v.outcomes}/{v.matured} matured{v.rate !== null ? ` (${v.rate}%)` : ""} · {v.pending} pending</li>)}</ul>
                {s.warnings.map((w, i) => <div key={i} className="text-xs text-warn">{w}</div>)}<div className="text-xs text-ink-soft">{s.note}</div></li>
            ))}</ul>
          )}
          {canEdit && (
            <form action={experimentAction} className="space-y-2">
              <Field label="Name"><Input name="name" required minLength={2} maxLength={160} /></Field>
              <Field label="Hypothesis"><Input name="hypothesis" required minLength={5} maxLength={1000} /></Field>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Field label="Compare"><Select name="dimension"><option value="trigger">Trigger</option><option value="persona">Persona</option><option value="channel">Channel</option><option value="message">Message</option><option value="cohort">Cohort</option></Select></Field>
                <Field label="Variants" hint="comma-separated"><Input name="variants" required placeholder="Lease event, Hiring" /></Field>
                <Field label="Window (days)"><Input name="window" type="number" min={1} max={365} defaultValue={60} /></Field>
                <Field label="Min sample"><Input name="min_sample" type="number" min={1} defaultValue={30} /></Field>
              </div>
              <Button variant="secondary" type="submit">Design experiment</Button>
            </form>
          )}
        </Card>
        <Card title="Knowledge capture — playbook">
          {d.playbook.length === 0 ? <p className="mb-3 text-sm text-ink-soft">No playbook items yet. Save anonymised questions, objections and answers that worked.</p> : (
            <ul className="mb-3 space-y-2 text-sm">{d.playbook.map((p) => <li key={String(p.id)}><Badge>{String(p.kind)}</Badge> {String(p.prompt_text)}{p.response_text ? <div className="text-xs text-ink-soft">→ {String(p.response_text)}</div> : null}<div className="text-xs text-ink-soft">{label(String(p.source_rights))}{p.persona ? ` · ${String(p.persona)}` : ""}</div></li>)}</ul>
          )}
          {canEdit && (
            <form action={playbookAction} className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Kind"><Select name="kind"><option value="question">Question</option><option value="objection">Objection</option><option value="answer">Answer</option><option value="talk_track">Talk track</option></Select></Field>
                <Field label="Source rights"><Select name="source_rights"><option value="own_experience">Own experience</option><option value="client_permitted">Client permitted</option><option value="public_source">Public source</option><option value="internal_only">Internal only</option></Select></Field>
              </div>
              <Field label="Prompt / objection"><Textarea name="prompt" required minLength={3} maxLength={2000} /></Field>
              <Field label="Response (optional)"><Textarea name="response" maxLength={4000} /></Field>
              <div className="grid grid-cols-2 gap-2"><Field label="Persona"><Input name="persona" maxLength={80} /></Field><Field label="Tags"><Input name="tags" placeholder="cfo, renewal" /></Field></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="anonymised" required /> No client, person or price details (anonymised)</label>
              <Button variant="secondary" type="submit">Save</Button>
            </form>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-ink-soft"><Sev s="low" /> Descriptive patterns only. The historical deal lists are selected observed transactions without a non-mover universe, so no next-mover probabilities are shown.</p>
    </div>
  );
}
