import { Suspense } from "react";
import { CompanyIntelligence } from "@/modules/intelligence/memory/ui/panels";
import { ProvenanceLinks } from "@/modules/imports/provenance-links";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, FactBadge, PageHeader, StaleBanner, inr, sf } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { getCompany, memberDirectory } from "@/modules/admin/entities";
import { ArchiveCard, ShareCard } from "@/modules/admin/ui/entity";
import { RecordTrust } from "@/modules/admin/ui/trust";
import { LinkedAdd, LinkedRows } from "@/modules/admin/ui/linked";
import { CompanyLocations } from "@/modules/assistant/data/ui";
import { loadAccount } from "@/modules/accounts/service";
import * as A from "@/modules/accounts/ui";

const INVERSE: Record<string, string> = { parent_of: "subsidiary of", subsidiary_of: "parent of", owner_of: "owned by", developer_of: "developed by", operator_of: "operated by", acquired: "acquired by", affiliate: "affiliate of" };
import { AsOfForm, ClassBadge, EvidenceTrail, Facts, Loading, Section, TierBadge, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Company" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function Body({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const asOf = typeof sp.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of) ? sp.as_of : null;
  const ctx = await requirePageContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = await getCompany(ctx.db, ctx.workspaceId, id, asOf);
  if (!c) notFound(); // invisible and nonexistent look the same (no existence oracle)
  const o = c.org;
  const members = await memberDirectory(ctx.db, ctx.workspaceId);
  const ownerName = members.find((m) => m.user_id === o.owner_user_id)?.display_name ?? null;
  const base = `/companies/${id}`;
  const tab: A.Tab = (A.TABS as readonly string[]).includes(String(sp.tab)) ? (sp.tab as A.Tab) : "overview";
  const acct = await loadAccount(ctx.db, ctx.workspaceId, ctx.userId, id);
  const canEdit = hasRole(ctx, "editor") && !o.archived_at;

  return (
    <div className="space-y-4">
      <PageHeader title={o.display_name}
        subtitle={<span className="flex flex-wrap items-center gap-1.5"><ClassBadge value={o.classification} />{o.sector ? <Badge>{o.sector}</Badge> : null}{o.is_gcc ? <Badge tone="brand">GCC</Badge> : null}{o.archived_at ? <Badge tone="bad">Archived</Badge> : null}<RecordTrust db={ctx.db} workspaceId={ctx.workspaceId} type="organisation" id={o.id} /></span>}
        actions={<>{hasRole(ctx, "editor") && !o.archived_at ? <ButtonLink variant="secondary" href={`${base}/edit`}>Edit</ButtonLink> : null}<AsOfForm asOf={asOf} action={base} /></>} />
      <ProvenanceLinks db={ctx.db} workspaceId={ctx.workspaceId} entityId={id} />
      <Suspense fallback={null}><CompanyIntelligence ctx={ctx} orgId={id} /></Suspense>

      {asOf ? <StaleBanner>Showing evidence recorded on or before {fmtDate(asOf)}. Employment and signals are filtered to that date; identity fields show the current record{c.snapshot ? " (an audited snapshot from that date is listed in the trail)" : ""}.</StaleBanner> : null}
      {o.contact_restrictions ? <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad"><strong>Contact restriction:</strong> {o.contact_restrictions}</div> : null}

      <A.ChangedStrip a={acct} base={base} />
      <A.TabBar base={base} tab={tab} c={A.counts(acct)} asOf={asOf} />

      {tab === "occupancy" ? <div className="space-y-4"><A.Occupancy a={acct} />
        {c.assets.length ? <Section title="Buildings this company owns, develops or operates"><ul className="space-y-1 text-sm">{c.assets.map((a) => <li key={a.id}><Link className="text-brand" href={`/buildings/${a.id}`}>{a.name}</Link> <span className="text-ink-soft">({a.owner_org_id === id ? "owner" : a.developer_org_id === id ? "developer" : "operator"})</span></li>)}</ul></Section> : null}</div> : null}
      {tab === "people" ? <div className="space-y-4"><A.StakeholderMap a={acct} orgId={id} />
        <Section title="People (all roles, incl. as-of view)" empty="No people linked yet." footer={<LinkedAdd kind="org_employment" hostId={id} backPath={`/companies/${id}`} />}>
          {c.people.length ? (
            <ul className="space-y-1 text-sm">{c.people.map((e) => (
              <li key={e.id} className={e.current_at_as_of ? "" : "text-ink-soft"}>
                <Link className="text-brand" href={`/people/${e.person_id}`}>{e.person_name ?? "Person"}</Link>{e.title ? ` · ${e.title}` : ""} <FactBadge status={e.fact_status} />
                {!e.current_at_as_of ? <span className="text-xs"> (past{e.end_date ? `, left ${fmtDate(e.end_date)}` : ""})</span> : null}
              </li>))}</ul>
          ) : null}
        </Section>
        <Section title="Stakeholders" empty="No stakeholders mapped on requirements.">
          {c.stakeholders.length ? (
            <ul className="space-y-1 text-sm">{c.stakeholders.map((s) => <li key={s.id}><Link className="text-brand" href={`/people/${s.person_id}`}>{s.person_name ?? "Person"}</Link> · {s.role}{s.requirement_title ? <span className="text-ink-soft"> ({s.requirement_title})</span> : null}</li>)}</ul>
          ) : null}
        </Section></div> : null}
      {tab === "requirements" ? <A.Requirements a={acct} orgId={id} canEdit={canEdit} /> : null}
      {tab === "signals" ? <div className="space-y-4"><A.Signals a={acct} />
        <Section title="Signal claims (evidence atoms)" empty="No claims recorded.">
          {c.signals.length ? (
            <ul className="space-y-2">{c.signals.map((s) => (
              <li key={s.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{s.claim_type}{s.predicate ? ` — ${s.predicate}` : ""}</span><FactBadge status={s.status} /><TierBadge tier={s.evidence_tier} />
                  {s.expires_on && s.expires_on < new Date().toISOString().slice(0, 10) ? <Badge tone="warn">expired {fmtDate(s.expires_on)}</Badge> : null}</div>
                {s.evidence_excerpt ? <p className="text-ink-soft">“{s.evidence_excerpt}”</p> : null}
                <p className="text-xs text-ink-soft">{fmtDate(s.effective_on ?? s.observed_on ?? s.published_on)}{s.source_url ? <> · <a className="underline" href={s.source_url} target="_blank" rel="noreferrer noopener">source</a></> : null}</p>
              </li>))}</ul>
          ) : null}
        </Section></div> : null}
      {tab === "scores" ? <A.Scores a={acct} /> : null}
      {tab === "timeline" ? <A.Timeline a={acct} /> : null}
      {tab === "meetings" ? <A.Meetings r={acct.meetings} /> : null}
      {tab === "deals" ? <A.Deals a={acct} /> : null}
      {tab === "documents" ? <A.Documents a={acct} /> : null}
      {tab === "actions" ? <A.NextActions a={acct} /> : null}

      {tab === "overview" ? <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title="Identity">
            <Facts items={[
              ["Legal name", o.legal_name], ["Industry", o.sector],
              ["Website", o.domain ? <a className="break-all text-brand underline" href={`https://${String(o.domain).replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer noopener">{o.domain}</a> : null],
              ["CIN", o.cin], ["GSTIN", o.gstin], ["HQ city", o.hq_city], ["HQ country", o.hq_country],
              ["Headcount", o.headcount_min || o.headcount_max ? `${o.headcount_min ?? "?"}–${o.headcount_max ?? "?"}` : null],
              ["CRM reference", o.crm_external_id], ["Source confidence", o.source_confidence],
              ["Owner", ownerName], ["Account owner note", o.account_owner_note],
            ]} />
          </Section>

          <Section title="Next actions" empty="Nothing pending.">{acct.actions.length ? <><ul className="space-y-1 text-sm">{acct.actions.slice(0, 3).map((x) => <li key={x.key}><Link className="text-brand" href={x.href}>{x.text}</Link> <span className="text-xs text-ink-soft">{x.why}</span></li>)}</ul>{acct.actions.length > 3 ? <Link className="mt-2 inline-block text-sm text-brand" href={`${base}?tab=actions`}>All {acct.actions.length} actions</Link> : null}</> : null}</Section>

          <Section title="Locations (HQ, offices, factories)"><CompanyLocations ctx={{ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId }} orgId={id} canEdit={canEdit} /></Section>

          <A.PastTransactions a={acct} />

          <Section title="Evidence trail"><EvidenceTrail items={c.trail} asOf={asOf} /></Section>
        </div>

        <div className="space-y-4">
          <Section title="Group structure & brands" empty="No parent, subsidiary, brand or affiliate links. Separate legal entities stay separate." footer={<><LinkedAdd kind="org_relation" hostId={id} backPath={`/companies/${id}`} /><div className="mt-3"><LinkedRows table="entity_alias" hostColumn="entity_id" hostId={id} backPath={`/companies/${id}`} filter={{ entity_type: "organisation" }} cols={[{ key: "raw_alias", label: "alias / brand" }]} /></div><LinkedAdd kind="org_alias" hostId={id} backPath={`/companies/${id}`} /></>}>
            {c.relations.length ? (
              <ul className="space-y-1 text-sm">{c.relations.map((r) => <li key={r.id}>{r.direction === "from" ? r.relation_type.replace(/_/g, " ") : INVERSE[r.relation_type] ?? r.relation_type} <Link className="text-brand" href={`/companies/${r.other_id}`}>{r.other_name ?? "hidden organisation"}</Link></li>)}</ul>
            ) : null}
          </Section>

          {hasRole(ctx, "admin") ? <Section title="Shared with"><ShareCard ctx={ctx} table="organisation" id={id} shares={c.shares} /></Section> : null}
          {hasRole(ctx, "editor") ? <Section title="Archive"><ArchiveCard ctx={ctx} table="organisation" row={o} /></Section> : null}
          <p className="text-xs text-ink-soft">Created {fmtDate(o.created_at)} · updated {fmtDate(o.updated_at, true)} · version {o.row_version}</p>
        </div>
      </div> : null}
    </div>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<Loading />}><Body {...props} /></Suspense>;
}
