import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, FactBadge, PageHeader, StaleBanner, sf } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { getBuilding, type VacancyState } from "@/modules/admin/entities";
import { ArchiveCard, ShareCard } from "@/modules/admin/ui/entity";
import { RecordTrust } from "@/modules/admin/ui/trust";
import { ArchiveLinked, LinkedAdd, LinkedRows } from "@/modules/admin/ui/linked";
import { AsOfForm, ClassBadge, EvidenceTrail, Facts, Loading, Section, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Building" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATE: Record<VacancyState, [string, "ok" | "warn" | "bad" | "neutral" | "brand"]> = {
  available: ["Available", "ok"],
  under_offer: ["Under offer", "warn"],
  leased: ["Leased", "neutral"],
  withdrawn: ["Withdrawn", "neutral"],
  unverified: ["Unverified", "warn"],
  expired: ["Evidence expired — re-verify", "warn"],
  no_evidence: ["No availability evidence", "neutral"],
};

async function Body({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const asOf = typeof sp.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of) ? sp.as_of : null;
  const ctx = await requirePageContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const b = await getBuilding(ctx.db, ctx.workspaceId, id, asOf);
  if (!b) notFound();
  const a = b.asset;
  const base = `/buildings/${id}`;
  const org = (oid?: string | null) => (oid ? <Link className="text-brand" href={`/companies/${oid}`}>{b.orgNames[oid] ?? "hidden organisation"}</Link> : null);

  return (
    <div className="space-y-4">
      <PageHeader title={a.name}
        subtitle={<span className="flex flex-wrap items-center gap-1.5"><ClassBadge value={a.classification} /><Badge>{a.asset_kind}</Badge>
          {b.parent ? <span>part of <Link className="text-brand" href={`/buildings/${b.parent.id}`}>{b.parent.name}</Link></span> : null}
          {a.archived_at ? <Badge tone="bad">Archived</Badge> : null}<RecordTrust db={ctx.db} workspaceId={ctx.workspaceId} type="asset" id={a.id} /></span>}
        actions={<>{hasRole(ctx, "editor") && !a.archived_at ? <ButtonLink variant="secondary" href={`${base}/edit`}>Edit</ButtonLink> : null}<AsOfForm asOf={asOf} action={base} /></>} />

      {asOf ? <StaleBanner>Showing availability snapshots and leases recorded on or before {fmtDate(asOf)}.</StaleBanner> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title="Building" footer={<>
            <h3 className="mt-3 text-xs font-semibold uppercase text-ink-soft">Specifications</h3>
            <LinkedRows table="asset_spec" hostColumn="asset_id" hostId={id} backPath={`/buildings/${id}`} empty="No specifications recorded." cols={[{ key: "spec_key" }, { key: "value_text" }, { key: "value_num", fmt: "num" }, { key: "unit" }, { key: "verification" }]} />
            <LinkedAdd kind="asset_spec" hostId={id} backPath={`/buildings/${id}`} />
            <h3 className="mt-3 text-xs font-semibold uppercase text-ink-soft">Sourced values (observations)</h3>
            <LinkedRows table="observation" hostColumn="entity_id" hostId={id} backPath={`/buildings/${id}`} filter={{ entity_type: "asset" }} proposeCurrent empty="No observations. Conflicting values are kept side by side." cols={[{ key: "field" }, { key: "value_raw" }, { key: "unit" }, { key: "source_location", label: "from" }, { key: "observed_on", label: "on", fmt: "date" }, { key: "verification" }]} />
            <LinkedAdd kind="observation" hostId={id} backPath={`/buildings/${id}`} />
            <h3 className="mt-3 text-xs font-semibold uppercase text-ink-soft">Alternative names</h3>
            <LinkedRows table="entity_alias" hostColumn="entity_id" hostId={id} backPath={`/buildings/${id}`} filter={{ entity_type: "asset" }} cols={[{ key: "raw_alias" }]} />
            <LinkedAdd kind="asset_alias" hostId={id} backPath={`/buildings/${id}`} />
          </>}>
            <Facts items={[
              ["Locality", b.locality ?? null], ["Address", a.address], ["Status (source wording)", a.status], ["Grade", a.grade],
              ["Total area", a.total_area_sf !== null && a.total_area_sf !== undefined ? sf(a.total_area_sf) : a.total_area_source_zero ? "source said 0 (treated as unknown)" : null],
              ["Floors", a.floors], ["Floor plate", a.floor_size_text ?? (a.floor_size_min_sf ? `${sf(a.floor_size_min_sf)}–${sf(a.floor_size_max_sf)}` : null)],
              ["Completion", a.completion_date ? `${fmtDate(a.completion_date)} (${a.completion_precision} precision)` : null],
              ["Developer", org(a.developer_org_id)], ["Owner", org(a.owner_org_id)], ["Operator", org(a.operator_org_id)],
              ["Last availability verification", b.lastVerification ? fmtDate(b.lastVerification) : null],
            ]} />
          </Section>

          {b.children.length ? (
            <Section title={a.asset_kind === "campus" || a.asset_kind === "project" ? "Towers / buildings" : "Parts"}>
              <ul className="space-y-1 text-sm">{b.children.map((c) => <li key={c.id}><Link className="text-brand" href={`/buildings/${c.id}`}>{c.name}</Link> <span className="text-ink-soft">{c.asset_kind}{c.total_area_sf ? ` · ${sf(c.total_area_sf)}` : ""}</span></li>)}</ul>
            </Section>
          ) : null}

          <Section title="Spaces & availability" empty="No spaces recorded. Availability is only shown from dated snapshots — nothing is assumed vacant." footer={<><LinkedAdd kind="space" hostId={id} backPath={`/buildings/${id}`} />{b.spaces.length ? <LinkedAdd kind="availability" hostId={id} backPath={`/buildings/${id}`} /> : null}</>}>
            {b.spaces.length ? (
              <ul className="space-y-3">{b.spaces.map((s) => {
                const [label, tone] = STATE[s.state];
                return (
                  <li key={s.id} className="rounded-lg border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{[s.floor_text, s.unit].filter(Boolean).join(" · ") || "Space"}</span><Badge tone={tone}>{label}</Badge>{s.latest ? <FactBadge status={s.latest.fact_status} /> : null}{hasRole(ctx, "editor") && !asOf ? <ArchiveLinked table="space" id={s.id} backPath={`/buildings/${id}`} /> : null}</div>
                    <div className="text-xs text-ink-soft">
                      {s.carpet_sf ? `${sf(s.carpet_sf)} carpet` : "carpet unknown"} · {s.chargeable_sf ? `${sf(s.chargeable_sf)} chargeable` : "chargeable unknown"}{s.configuration ? ` · ${s.configuration.replace(/_/g, " ")}` : ""}
                    </div>
                    {s.latest ? <div className="text-xs text-ink-soft">As of {fmtDate(s.latest.as_of)}{s.latest.valid_until ? ` · valid until ${fmtDate(s.latest.valid_until)}` : ""}{s.latest.available_from ? ` · available from ${fmtDate(s.latest.available_from)}` : ""}
                      {s.latest.asking_rent_min ? ` · asking ₹${s.latest.asking_rent_min}${s.latest.asking_rent_max && s.latest.asking_rent_max !== s.latest.asking_rent_min ? `–${s.latest.asking_rent_max}` : ""}/sf (${s.latest.rent_basis ?? "basis unknown"})` : ""}</div> : null}
                    {s.latest ? <div className="text-xs text-ink-soft">Terms: CAM {s.latest.cam_psf_month != null ? `₹${s.latest.cam_psf_month}/sf/month` : "unknown"} · deposit {s.latest.deposit_months != null ? `${s.latest.deposit_months} months` : "unknown"} · rent-free {s.latest.rent_free_months != null ? `${s.latest.rent_free_months} months` : "unknown"} · escalation {s.latest.escalation_pct != null ? `${s.latest.escalation_pct}%${s.latest.escalation_every_months ? ` every ${s.latest.escalation_every_months} months` : ""}` : "unknown"}</div> : null}
                    {s.history.length > 1 ? (
                      <details className="mt-1 text-xs"><summary className="cursor-pointer text-brand">History ({s.history.length} snapshots)</summary>
                        <ul className="mt-1 space-y-0.5">{s.history.map((h) => <li key={h.id}>{fmtDate(h.as_of)}: {h.status} <FactBadge status={h.fact_status} /></li>)}</ul>
                      </details>
                    ) : null}
                  </li>
                );
              })}</ul>
            ) : null}
          </Section>

          <Section title="Leases" empty="No leases recorded for this building." footer={<LinkedAdd kind="lease" hostId={id} backPath={`/buildings/${id}`} />}>
            {b.leases.length ? (
              <ul className="space-y-1 text-sm">{b.leases.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-1.5">
                  {l.tenant_org_id ? <Link className="text-brand" href={`/companies/${l.tenant_org_id}`}>{l.tenant_name ?? "hidden tenant"}</Link> : <span>{l.tenant_name ?? "tenant unknown"}</span>}
                  <span className="text-ink-soft">{l.landlord_name ? `landlord ${l.landlord_name} · ` : ""}{l.start_date ? `from ${fmtDate(l.start_date)} · ` : ""}{l.area_sf ? sf(l.area_sf) : "area unknown"} · expiry {l.contractual_expiry ? fmtDate(l.contractual_expiry) : "unknown"}</span>{l.is_estimate ? <Badge tone="warn">Estimate</Badge> : <FactBadge status={l.fact_status} />}
                  {l.source_note || l.observed_on ? <span className="text-xs text-ink-soft">source: {l.source_note ?? "not recorded"}{l.observed_on ? ` · observed ${fmtDate(l.observed_on)}` : ""}</span> : null}
                  <div className="w-full pl-3">
                    <LinkedRows table="lease_space" hostColumn="lease_id" hostId={l.id} backPath={`/buildings/${id}`} cols={[{ key: "space_id", label: "space" }, { key: "area_sf", fmt: "num" }]} joins={{ space_id: { table: "space", label: "floor_text" } }} />
                    <LinkedRows table="lease_event" hostColumn="lease_id" hostId={l.id} backPath={`/buildings/${id}`} order="event_date" cols={[{ key: "event_type" }, { key: "event_date", fmt: "date" }, { key: "date_basis" }, { key: "notice_days", label: "notice days" }]} />
                    <LinkedAdd kind="lease_space" hostId={l.id} backPath={`/buildings/${id}`} />
                    <LinkedAdd kind="lease_event" hostId={l.id} backPath={`/buildings/${id}`} />
                  </div>
                </li>))}</ul>
            ) : null}
          </Section>

          <Section title="Market transactions" empty="No transactions recorded.">
            {b.transactions.length ? (
              <ul className="space-y-1 text-sm">{b.transactions.slice(0, 20).map((t) => <li key={t.id}>{t.tenant_name ?? "Tenant unknown"} <span className="text-ink-soft">{t.period_start ? fmtDate(t.period_start) : ""}{t.area_sf ? ` · ${sf(t.area_sf)}` : ""}</span></li>)}</ul>
            ) : null}
          </Section>

          <Section title="Evidence trail"><EvidenceTrail items={b.trail} asOf={asOf} /></Section>
        </div>

        <div className="space-y-4">
          {hasRole(ctx, "admin") ? <Section title="Shared with"><ShareCard ctx={ctx} table="asset" id={id} shares={b.shares} /></Section> : null}
          {hasRole(ctx, "editor") ? <Section title="Archive"><ArchiveCard ctx={ctx} table="asset" row={a} /></Section> : null}
          <p className="text-xs text-ink-soft">Created {fmtDate(a.created_at)} · updated {fmtDate(a.updated_at, true)} · version {a.row_version}</p>
        </div>
      </div>
    </div>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<Loading />}><Body {...props} /></Suspense>;
}
