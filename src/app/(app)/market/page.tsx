import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, MoreFields, Table, Td, StaleBanner, sf } from "@/components/ui";
import { marketOverview, marketComparables, listMarketNotes, latestAnalysis, pendingGeographyMappings } from "@/modules/intelligence/market/service";
import { MarketChart } from "@/modules/intelligence/market/chart";
import type { AnalysisFlag } from "@/modules/intelligence/market/analysis";
import { Flash, Disclaimer, fmtDay, label } from "@/modules/intelligence/ui";
import { noteAction, noteStatusAction, geoMappingAction, analysisAction } from "./actions";

type SP = { error?: string; notice?: string; locality?: string; min?: string; max?: string; since?: string; basis?: string };
const n = (v?: string) => (v && !Number.isNaN(Number(v)) ? Number(v) : null);
const GEO_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { mapped: "ok", alias: "ok", name_match_only: "warn", unmapped: "bad", unspecified: "bad" };

export default async function MarketPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const [ov, comps, notes, last, pending] = await Promise.all([
    marketOverview(ctx.db, ctx.workspaceId),
    marketComparables(ctx.db, ctx.workspaceId, { locality: sp.locality || null, minSf: n(sp.min), maxSf: n(sp.max), sinceDate: sp.since && /^\d{4}-\d{2}-\d{2}$/.test(sp.since) ? sp.since : null, rentBasis: sp.basis || null }),
    listMarketNotes(ctx.db, ctx.workspaceId),
    latestAnalysis(ctx.db, ctx.workspaceId),
    pendingGeographyMappings(ctx.db, ctx.workspaceId),
  ]);
  const warnFlags = ov.flags.filter((f) => f.severity === "warn");

  return (
    <div>
      <PageHeader title="Market" subtitle="Validated releases only." actions={canEdit ? <form action={analysisAction}><Button variant="secondary">Re-run checks</Button></form> : null} />
      <Disclaimer>{ov.disclaimer} Stock is never summed over time; missing periods stay unknown; no vacancy is inferred from gross absorption; units and period types are never mixed on one chart.</Disclaimer>
      <Flash sp={sp} />
      {ov.excluded.length > 0 && <StaleBanner>{ov.excluded.length} observation(s) not charted (failed the gate or superseded) — every one is listed with its reason at the bottom.</StaleBanner>}
      {last && <p className="mb-3 text-xs text-ink-soft">Last data check {fmtDay(String(last.ran_at))} ({label(String(last.trigger_kind))}): {String(last.series_count)} series, {String(last.excluded_count)} excluded, {(last.flags ?? []).length} flag(s).</p>}

      {ov.flags.length > 0 && (
        <Card title={`Data consistency (${warnFlags.length} to review)`} className="mb-4">
          <ul className="space-y-1 text-sm">{ov.flags.map((f: AnalysisFlag, i: number) => <li key={i}><Badge tone={f.severity === "warn" ? "warn" : "neutral"}>{label(f.kind)}</Badge> {f.series ? <span className="font-medium">{f.series}: </span> : null}{f.detail}</li>)}</ul>
        </Card>
      )}

      {ov.series.length === 0 ? (
        <Card className="mb-4"><EmptyState title="No validated market observations">Import a market release (rent, supply, absorption, stock) through <Link className="text-brand underline" href="/imports">Imports</Link>. Each row needs a metric definition, unit, period type, release date and source to appear here.</EmptyState></Card>
      ) : (
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {ov.series.map((s) => (
            <Card key={s.key} title={<span>{label(s.metric)} · {s.geographyLabel} <Badge>{s.kind}</Badge> <Badge tone="brand">{s.unit}</Badge> <Badge>{s.family}</Badge> <Badge tone={GEO_TONE[s.geographyStatus]}>{label(s.geographyStatus)}</Badge></span>}>
              <MarketChart s={s} />
              <ul className="mt-2 space-y-0.5 text-xs text-ink-soft">
                {s.points.filter((p) => p.note || p.change !== null).map((p) => <li key={p.label}>{p.label}: {p.change !== null ? `change ${p.change > 0 ? "+" : ""}${p.change} ${s.unit} vs previous comparable period` : p.note}</li>)}
                {s.definitions.length > 0 && <li>Definition{s.definitions.length > 1 ? "s" : ""}: {s.definitions.map((d) => `“${d}”`).join(" / ")}</li>}
                {s.kind === "stock" && <li>Snapshot metric — not additive over time.</li>}
                {s.flags.map((f, i) => <li key={i} className="text-warn">{f}</li>)}
              </ul>
              {canEdit && (s.geographyStatus === "name_match_only" || s.geographyStatus === "unmapped") && s.geographyRaw && (
                pending.includes(s.geographyRaw.trim().toLowerCase()) ? <p className="mt-2 text-xs text-accent">Mapping for “{s.geographyRaw}” proposed — waiting for approval on <Link className="underline" href="/approvals">Approvals</Link>.</p> : (
                  <form action={geoMappingAction} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                    <input type="hidden" name="raw" value={s.geographyRaw} />
                    <Field label={`Map “${s.geographyRaw}” to`}><Select name="geography_id" required defaultValue={s.geographySuggestion?.id ?? ""}>{[<option key="" value="" disabled>Choose a geography…</option>, ...ov.geos.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)]}</Select></Field>
                    <Button variant="secondary" type="submit">Propose mapping</Button>
                  </form>
                )
              )}
            </Card>
          ))}
        </div>
      )}

      {(ov.ratios.length > 0 || ov.vacancyNote) && (
        <Card title="Supply vs absorption" className="mb-4">
          {ov.vacancyNote && <p className="mb-2 text-sm text-ink-soft">{ov.vacancyNote}</p>}
          {ov.ratios.map((r) => (
            <div key={`${r.geography}|${r.unit}`} className="mb-2 text-sm"><div className="font-medium">{r.geography} <span className="text-xs text-ink-soft">(both in {r.unit}; ratio is unitless)</span></div>
              <ul className="text-xs">{r.rows.map((x) => <li key={x.label}>{x.label}: {x.ratio ?? "—"} <span className="text-ink-soft">({x.note})</span></li>)}</ul>
              <p className="text-xs text-ink-soft">Sources: {[...new Map(r.sources.map((x) => [`${x.key}@${x.release_date}`, x])).values()].map((x) => `${x.name} (released ${fmtDay(x.release_date)})`).join("; ")}</p></div>
          ))}
        </Card>
      )}

      <Card title="Comparables" className="mb-4">
        <form className="mb-3 max-w-md space-y-3">
          <Field label="Locality"><Select name="locality" defaultValue={sp.locality ?? ""}>{[<option key="" value="">Any</option>, ...comps.localities.map((l) => <option key={l} value={l}>{l}</option>)]}</Select></Field>
          <MoreFields label="Filters">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Min sf"><Input name="min" inputMode="numeric" defaultValue={sp.min} /></Field>
              <Field label="Max sf"><Input name="max" inputMode="numeric" defaultValue={sp.max} /></Field>
            </div>
            <Field label="Since"><Input name="since" type="date" defaultValue={sp.since} /></Field>
            <Field label="Rent basis"><Input name="basis" defaultValue={sp.basis} placeholder="any" /></Field>
          </MoreFields>
          <Button variant="secondary" type="submit">Filter</Button>
        </form>
        {comps.rows.length === 0 ? <EmptyState title="No comparable transactions">Import deal lists to see comparables here.</EmptyState> : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">{comps.stats.map((s) => <Badge key={s.basis} tone="brand">{s.basis}: n={s.n} · median {s.median ?? "—"} · P25 {s.p25 ?? "—"} · P75 {s.p75 ?? "—"}</Badge>)}</div>
            <Table head={["Date", "Building", "Locality", "Area", "Rent", "Basis"]}>
              {comps.rows.slice(0, 50).map((t) => (
                <tr key={t.id}><Td>{t.period_start?.slice(0, 7) ?? "unknown"}</Td><Td>{t.asset_name ?? "unknown"}</Td><Td>{t.locality ?? "—"}</Td><Td>{sf(t.area_sf)}</Td>
                  <Td>{t.rent_min === null && t.rent_max === null ? "unknown" : `${t.rent_min ?? "?"}${t.rent_max !== null && t.rent_max !== t.rent_min ? `–${t.rent_max}` : ""}`}</Td><Td>{t.rent_basis ?? "unknown"}</Td></tr>
              ))}
            </Table>
            <p className="mt-1 text-xs text-ink-soft">Sample of {comps.rows.length} — not the whole market. {comps.excluded} outside the filter.</p>
          </>
        )}
      </Card>

      <Card title="Market notes" className="mb-4">
        {canEdit && ov.series.length > 0 && (
          <form action={noteAction} className="mb-3 max-w-md space-y-4">
            <Field label="Series"><Select name="series" required>{ov.series.map((s) => <option key={s.key} value={s.key}>{label(s.metric)} · {s.geographyLabel} · {s.unit} · {s.family}</option>)}</Select></Field>
            <Field label="Audience"><Input name="audience" placeholder="e.g. occupier CFOs" maxLength={80} /></Field>
            <Button type="submit">Draft note</Button>
          </form>
        )}
        {notes.length === 0 ? <p className="text-sm text-ink-soft">No notes yet. Draft one above.</p> : (
          <ul className="divide-y divide-line">
            {notes.map((m) => (
              <li key={String(m.id)} className="py-2 text-sm">
                <details><summary className="cursor-pointer"><span className="font-medium">{String(m.title)}</span> <Badge tone={m.status === "approved" ? "ok" : "neutral"}>{label(String(m.status))}</Badge>{m.has_forecast ? <> <Badge tone="accent">includes source forecasts</Badge></> : null} <span className="text-xs text-ink-soft">{fmtDay(String(m.created_at))} · n={String(m.sample_size ?? "?")}</span></summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-canvas p-2 text-xs">{String(m.body)}</pre>
                  <p className="mt-1 text-xs text-accent">{String(m.commentary_label)}</p>
                  {Array.isArray(m.sources) && (m.sources as { name: string; release_date: string | null; licensed_name?: string | null; permits_publication?: boolean }[]).some((x) => x.licensed_name) && <p className="text-xs text-warn">Licensed source: {(m.sources as { name: string; licensed_name?: string | null; permits_publication?: boolean }[]).filter((x) => x.licensed_name).map((x) => `${x.licensed_name}${x.permits_publication ? " (publication permitted)" : " (not cleared for publication)"}`).join("; ")}</p>}
                  {canEdit && (
                    <form action={noteStatusAction} className="mt-2 flex flex-wrap items-center gap-2"><input type="hidden" name="id" value={String(m.id)} />
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confidentiality" defaultChecked={!!m.confidentiality_checked} /> No client-confidential data</label>
                      <Button variant="secondary" name="status" value="approved">Approve</Button><Button variant="ghost" name="status" value="published_manually">I shared it</Button><Button variant="ghost" name="status" value="discarded">Discard</Button></form>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {ov.excluded.length > 0 && (
        <Card title={`Not charted (${ov.excluded.length})`}>
          <p className="mb-1 text-xs text-ink-soft">Observations that failed the definition/date/source/unit gate, or were superseded by a later release or an actual for the same period.</p>
          <ul className="space-y-0.5 text-xs">{ov.excluded.slice(0, 200).map((e, i) => <li key={`${e.id}-${i}`}>{label(e.metric)} — {e.reason}</li>)}</ul>
        </Card>
      )}
    </div>
  );
}
