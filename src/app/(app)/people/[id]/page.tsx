import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, FactBadge, PageHeader, StaleBanner } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { getPerson } from "@/modules/admin/entities";
import { ArchiveCard, ShareCard } from "@/modules/admin/ui/entity";
import { RecordTrust } from "@/modules/admin/ui/trust";
import { EndRole, LinkedAdd, LinkedRows } from "@/modules/admin/ui/linked";
import { AsOfForm, ClassBadge, EvidenceTrail, Facts, Loading, Section, TierBadge, fmtDate } from "@/modules/admin/ui/parts";
import { RelationshipPanel } from "@/modules/intelligence/network/ui";
import { Flash } from "@/modules/intelligence/ui";

export const metadata = { title: "Person" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function Body({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const asOf = typeof sp.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of) ? sp.as_of : null;
  const ctx = await requirePageContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const p = await getPerson(ctx.db, ctx.workspaceId, id, asOf);
  if (!p) notFound();
  const person = p.person;
  const base = `/people/${id}`;
  const current = p.employment.filter((e) => e.current_at_as_of);
  const anySuppressed = p.contacts.some((c) => c.effectively_suppressed) || p.consents.some((c) => c.suppressed || c.revoked_at);

  return (
    <div className="space-y-4">
      <PageHeader title={person.full_name}
        subtitle={<span className="flex flex-wrap items-center gap-1.5"><ClassBadge value={person.classification} />
          {current.length ? current.map((e) => <span key={e.id}>{e.title ?? "Role unknown"} @ {e.org_name ?? "hidden organisation"}</span>) : <span>No current role on record{asOf ? ` on ${fmtDate(asOf)}` : ""}</span>}
          {person.archived_at ? <Badge tone="bad">Archived</Badge> : null}<RecordTrust db={ctx.db} workspaceId={ctx.workspaceId} type="person" id={person.id} /></span>}
        actions={<>{hasRole(ctx, "editor") && !person.archived_at ? <ButtonLink variant="secondary" href={`${base}/edit`}>Edit</ButtonLink> : null}<AsOfForm asOf={asOf} action={base} /></>} />

      <Flash sp={{ notice: typeof sp.notice === "string" ? sp.notice : undefined, error: typeof sp.error === "string" ? sp.error : undefined }} />
      {typeof sp.draft === "string" ? <p className="text-sm"><ButtonLink variant="secondary" href="/drafts">Open Drafts</ButtonLink></p> : null}
      {asOf ? <StaleBanner>Showing the role valid on {fmtDate(asOf)} and evidence recorded on or before that date. Past roles stay on the person.</StaleBanner> : null}
      {anySuppressed ? <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad"><strong>Suppressed:</strong> do not contact through suppressed channels. Suppression survives imports and restores.</div> : null}
      {person.contact_restrictions ? <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"><strong>Contact restriction:</strong> {person.contact_restrictions}</div> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title="Employment timeline" empty="No employment recorded. Imports, captures or research add roles with a fact status." footer={<LinkedAdd kind="employment" hostId={id} backPath={`/people/${id}`} />}>
            {p.employment.length ? (
              <ol className="space-y-2">{p.employment.map((e) => (
                <li key={e.id} className={`text-sm ${e.current_at_as_of ? "" : "text-ink-soft"}`}>
                  <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{e.title ?? "Role unknown"}</span> at <Link className="text-brand" href={`/companies/${e.org_id}`}>{e.org_name ?? "hidden organisation"}</Link> <FactBadge status={e.fact_status} />{e.current_at_as_of ? <Badge tone="ok">{asOf ? "valid then" : "current"}</Badge> : null}</div>
                  <div className="text-xs text-ink-soft">{e.start_date ? fmtDate(e.start_date) : "start unknown"} – {e.end_date ? fmtDate(e.end_date) : e.is_current ? "present" : "end unknown"}{e.function ? ` · ${e.function}` : ""}{e.seniority ? ` · ${e.seniority}` : ""}</div>
                  {e.is_current && !e.end_date && !asOf ? <EndRole id={e.id} backPath={`/people/${id}`} /> : null}
                </li>))}</ol>
            ) : null}
          </Section>

          <Section title="Relationship context" empty="No relationships recorded." footer={<><LinkedRows table="relationship_context" hostColumn="person_id" hostId={id} backPath={`/people/${id}`} cols={[{ key: "strength" }, { key: "org_id" }, { key: "context" }, { key: "last_verified_on", label: "verified", fmt: "date" }]} joins={{ org_id: { table: "organisation", label: "display_name" } }} /><LinkedAdd kind="relationship_context" hostId={id} backPath={`/people/${id}`} /><LinkedAdd kind="relationship_edge" hostId={id} backPath={`/people/${id}`} /><LinkedRows table="entity_alias" hostColumn="entity_id" hostId={id} backPath={`/people/${id}`} filter={{ entity_type: "person" }} cols={[{ key: "raw_alias", label: "also known as" }]} /><LinkedAdd kind="person_alias" hostId={id} backPath={`/people/${id}`} /></>}>
            {p.relationships.length ? (
              <ul className="space-y-1 text-sm">{p.relationships.map((r) => (
                <li key={r.id}>{r.direction === "in" ? <>{r.counterpart_person_id ? <Link className="text-brand" href={`/people/${r.counterpart_person_id}`}>{r.counterpart ?? "Contact"}</Link> : r.counterpart ?? "Team member"} → this person</> : <>this person → {r.counterpart_person_id ? <Link className="text-brand" href={`/people/${r.counterpart_person_id}`}>{r.counterpart ?? "Contact"}</Link> : "Contact"}</>}
                  <span className="text-ink-soft"> · {r.edge_type.replace(/_/g, " ")}{r.warmth ? ` · ${r.warmth}` : ""}{r.last_meaningful_contact ? ` · last ${fmtDate(r.last_meaningful_contact)}` : ""}</span>
                  {r.intro_permission ? <Badge tone="ok">intro permitted</Badge> : null}</li>))}</ul>
            ) : null}
          </Section>

          <RelationshipPanel ctx={ctx} personId={id} personName={person.full_name} />

          <Section title="Intro paths" empty="No known path from your team. Ask before assuming anyone will introduce you.">
            {p.introPaths.length ? (
              <ul className="space-y-1 text-sm">{p.introPaths.map((ip, i) => (
                <li key={i}>{ip.from ?? "Team member"} {ip.via ? <>→ <Link className="text-brand" href={`/people/${ip.viaId}`}>{ip.via}</Link> </> : null}→ {person.full_name}
                  {ip.edge.intro_permission ? <Badge tone="ok">permission recorded</Badge> : <Badge tone="warn">permission not recorded</Badge>}</li>))}</ul>
            ) : null}
          </Section>

          <Section title="Interactions" empty="No interactions logged yet.">
            {p.interactions.length ? (
              <ul className="space-y-2 text-sm">{p.interactions.slice(0, 25).map((i) => (
                <li key={i.id}><span className="text-xs text-ink-soft">{fmtDate(i.occurred_at, true)}</span> <Badge>{i.channel}</Badge> {i.subject ?? "(no subject)"}{i.summary ? <p className="text-ink-soft">{i.summary}</p> : null}</li>))}</ul>
            ) : null}
          </Section>

          <Section title="Signals" empty="No signals recorded for this person.">
            {p.signals.length ? (
              <ul className="space-y-1 text-sm">{p.signals.map((s) => <li key={s.id}>{s.claim_type}{s.predicate ? ` — ${s.predicate}` : ""} <FactBadge status={s.status} /> <TierBadge tier={s.evidence_tier} /></li>)}</ul>
            ) : null}
          </Section>

          <Section title="Evidence trail"><EvidenceTrail items={p.trail} asOf={asOf} /></Section>
        </div>

        <div className="space-y-4">
          <Section title="Contact methods" empty="No contact methods. Never guess or invent an email or number." footer={<LinkedAdd kind="contact_method" hostId={id} backPath={`/people/${id}`} />}>
            {p.contacts.length ? (
              <ul className="space-y-2 text-sm">{p.contacts.map((c) => (
                <li key={c.id} className={c.effectively_suppressed ? "text-ink-soft line-through" : ""}>
                  <div className="flex flex-wrap items-center gap-1"><Badge>{c.method_type}</Badge> <span className="break-all">{c.value}</span></div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    {c.verified_on ? <Badge tone="ok">verified {fmtDate(c.verified_on)}</Badge> : <Badge tone="warn">unverified</Badge>}
                    {c.preferred ? <Badge tone="brand">preferred</Badge> : null}
                    {c.effectively_suppressed ? <Badge tone="bad">suppressed</Badge> : null}
                  </div>
                </li>))}</ul>
            ) : null}
          </Section>

          <Section title="Consent & permissions" empty="No consent records.">
            {p.consents.length ? (
              <ul className="space-y-1 text-sm">{p.consents.map((c) => <li key={c.id}>{c.purpose}{c.channel ? ` (${c.channel})` : ""} {c.revoked_at ? <Badge tone="bad">revoked {fmtDate(c.revoked_at)}</Badge> : c.suppressed ? <Badge tone="bad">suppressed</Badge> : c.expires_on ? <Badge>until {fmtDate(c.expires_on)}</Badge> : <Badge tone="ok">active</Badge>}</li>)}</ul>
            ) : null}
          </Section>

          <Section title="Stakeholder roles" empty="Not mapped to any requirement.">
            {p.stakeholderRoles.length ? (
              <ul className="space-y-1 text-sm">{p.stakeholderRoles.map((s) => <li key={s.id}>{s.role} on <Link className="text-brand" href={`/requirements/${s.requirement_id}`}>{s.requirement_title ?? "requirement"}</Link>{s.org_name ? <span className="text-ink-soft"> ({s.org_name})</span> : null}</li>)}</ul>
            ) : null}
          </Section>

          <Section title="Profile">
            <Facts items={[["Also known as", (person.aliases ?? []).join(", ")], ["Preferred language", person.preferred_language], ["Preferred channel", person.preferred_channel],
              ["Public profile", person.public_profile_url ? <a className="break-all text-brand underline" href={person.public_profile_url} target="_blank" rel="noreferrer noopener">{person.public_profile_url}</a> : null], ["Notes", person.personal_notes]]} />
          </Section>

          {hasRole(ctx, "admin") ? <Section title="Shared with"><ShareCard ctx={ctx} table="person" id={id} shares={p.shares} /></Section> : null}
          {hasRole(ctx, "editor") ? <Section title="Archive"><ArchiveCard ctx={ctx} table="person" row={person} /></Section> : null}
        </div>
      </div>
    </div>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<Loading />}><Body {...props} /></Suspense>;
}
