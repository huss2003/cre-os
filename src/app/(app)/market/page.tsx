import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Table, Td, StaleBanner, sf } from "@/components/ui";
import { marketOverview, marketComparables, listMarketNotes } from "@/modules/intelligence/market/service";
import { Flash, Disclaimer, Bars, fmtDay, label } from "@/modules/intelligence/ui";
import { noteAction, noteStatusAction } from "./actions";

type SP = { error?: string; notice?: string; locality?: string; min?: string; max?: string; since?: string; basis?: string };
const n = (v?: string) => (v && !Number.isNaN(Number(v)) ? Number(v) : null);

export default async function MarketPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const [ov, comps, notes] = await Promise.all([
    marketOverview(ctx.db, ctx.workspaceId),
    marketComparables(ctx.db, ctx.workspaceId, { locality: sp.locality || null, minSf: n(sp.min), maxSf: n(sp.max), sinceDate: sp.since && /^\d{4}-\d{2}-\d{2}$/.test(sp.since) ? sp.since : null, rentBasis: sp.basis || null }),
    listMarketNotes(ctx.db, ctx.workspaceId),
  ]);

  return (
    <div>
      <PageHeader title="Market" subtitle="Validated releases only: every figure carries its definition, period type, release date and source." />
      <Disclaimer>{ov.disclaimer} Stock is never summed over time; missing years stay unknown; no vacancy is inferred from gross absorption.</Disclaimer>
      <Flash sp={sp} />
      {ov.excluded.length > 0 && <StaleBanner>{ov.excluded.length} observation(s) excluded by the definition/date/source gate — see the list at the bottom.</StaleBanner>}

      {ov.series.length === 0 ? (
        <Card className="mb-4"><EmptyState title="No validated market observations">Import a market release (rent, supply, absorption, stock) through <Link className="text-brand underline" href="/imports">Imports</Link>. Each row needs a metric definition, unit, period type, release date and source to appear here.</EmptyState></Card>
      ) : (
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {ov.series.map((s) => (
            <Card key={`${s.metric}|${s.geography}`} title={<span>{label(s.metric)} · {s.geographyLabel} <Badge>{s.kind}</Badge></span>}>
              <Bars rows={s.points.map((p) => ({ label: p.label, value: p.value, note: p.note, tone: p.is_forecast ? "accent" : p.period_type === "ytd" ? "warn" : "brand" }))} unit={s.points.find((p) => p.unit)?.unit ?? undefined} />
              <ul className="mt-2 space-y-0.5 text-xs text-ink-soft">
                {s.points.filter((p) => p.note || p.change !== null).map((p) => <li key={p.label}>{p.label}: {p.change !== null ? `change ${p.change > 0 ? "+" : ""}${p.change} vs previous comparable period` : p.note}</li>)}
                <li>Latest release {fmtDay(s.points.filter((p) => p.release_date).map((p) => p.release_date!).sort().pop() ?? null)}{s.kind === "stock" ? " · snapshot metric (not additive)" : ""}</li>
              </ul>
            </Card>
          ))}
        </div>
      )}

      {(ov.ratios.length > 0 || ov.vacancyNote) && (
        <Card title="Supply vs absorption" className="mb-4">
          {ov.vacancyNote && <p className="mb-2 text-sm text-ink-soft">{ov.vacancyNote}</p>}
          {ov.ratios.map((r) => (
            <div key={r.geography} className="mb-2 text-sm"><div className="font-medium">{r.geography}</div>
              <ul className="text-xs">{r.rows.map((x) => <li key={x.label}>{x.label}: {x.ratio ?? "—"} <span className="text-ink-soft">({x.note})</span></li>)}</ul></div>
          ))}
        </Card>
      )}

      <Card title="Comparables" className="mb-4">
        <form className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6 sm:items-end">
          <Field label="Locality"><Select name="locality" defaultValue={sp.locality ?? ""}>{[<option key="" value="">Any</option>, ...comps.localities.map((l) => <option key={l} value={l}>{l}</option>)]}</Select></Field>
          <Field label="Min sf"><Input name="min" inputMode="numeric" defaultValue={sp.min} /></Field>
          <Field label="Max sf"><Input name="max" inputMode="numeric" defaultValue={sp.max} /></Field>
          <Field label="Since"><Input name="since" type="date" defaultValue={sp.since} /></Field>
          <Field label="Rent basis"><Input name="basis" defaultValue={sp.basis} placeholder="any" /></Field>
          <Button variant="secondary" type="submit">Filter</Button>
        </form>
        {comps.rows.length === 0 ? <EmptyState title="No comparable transactions">Imported deal lists (market transactions) appear here. They are selected observed deals, not a complete market.</EmptyState> : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">{comps.stats.map((s) => <Badge key={s.basis} tone="brand">{s.basis}: n={s.n} · median {s.median ?? "—"} · P25 {s.p25 ?? "—"} · P75 {s.p75 ?? "—"}</Badge>)}</div>
            <Table head={["Date", "Building", "Locality", "Area", "Rent", "Basis"]}>
              {comps.rows.slice(0, 50).map((t) => (
                <tr key={t.id}><Td>{t.period_start?.slice(0, 7) ?? "unknown"}</Td><Td>{t.asset_name ?? "unknown"}</Td><Td>{t.locality ?? "—"}</Td><Td>{sf(t.area_sf)}</Td>
                  <Td>{t.rent_min === null && t.rent_max === null ? "unknown" : `${t.rent_min ?? "?"}${t.rent_max !== null && t.rent_max !== t.rent_min ? `–${t.rent_max}` : ""}`}</Td><Td>{t.rent_basis ?? "unknown"}</Td></tr>
              ))}
            </Table>
            <p className="mt-1 text-xs text-ink-soft">Statistics are per rent basis — bases are never mixed. {comps.excluded} transaction(s) outside the filter.</p>
          </>
        )}
      </Card>

      <Card title="Market notes" className="mb-4">
        {canEdit && ov.series.length > 0 && (
          <form action={noteAction} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:items-end">
            <Field label="Series"><Select name="series" required>{ov.series.map((s) => <option key={`${s.metric}|${s.geography}`} value={`${s.metric}|${s.geography}`}>{label(s.metric)} · {s.geographyLabel}</option>)}</Select></Field>
            <Field label="Audience"><Input name="audience" placeholder="e.g. occupier CFOs" maxLength={80} /></Field>
            <Button type="submit">Draft note</Button>
          </form>
        )}
        {notes.length === 0 ? <p className="text-sm text-ink-soft">No notes yet.</p> : (
          <ul className="divide-y divide-line">
            {notes.map((m) => (
              <li key={String(m.id)} className="py-2 text-sm">
                <details><summary className="cursor-pointer"><span className="font-medium">{String(m.title)}</span> <Badge>{label(String(m.status))}</Badge> <span className="text-xs text-ink-soft">{fmtDay(String(m.created_at))}</span></summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-canvas p-2 text-xs">{String(m.body)}</pre>
                  <p className="mt-1 text-xs text-accent">{String(m.commentary_label)}</p>
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
        <Card title={`Excluded observations (${ov.excluded.length})`}>
          <ul className="space-y-0.5 text-xs">{ov.excluded.slice(0, 100).map((e) => <li key={e.id}>{label(e.metric)} — {e.reason}</li>)}</ul>
        </Card>
      )}
    </div>
  );
}
