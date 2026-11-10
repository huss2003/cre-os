import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Badge, ButtonLink, Card, HelpFor, PageHeader, sf } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { rerunComparisonAction } from "@/modules/toolkit/actions-compare";
import { getAnalysis } from "@/modules/toolkit/store";
import type { PropertyRating, RatingProperty, RatingResult } from "@/modules/toolkit/calc/rating";

const dash = <span className="text-ink-soft">unknown</span>;
const v = (x: number | null | undefined, unit = "") => (x === null || x === undefined ? dash : `${x}${unit}`);
const ELIG: Record<PropertyRating["eligibility"], ["ok" | "bad" | "warn", string]> = { eligible: ["ok", "Eligible"], not_eligible: ["bad", "Not eligible"], unconfirmed: ["warn", "Unconfirmed"] };
const EVID: Record<string, "ok" | "brand" | "warn" | "neutral"> = { approved: "ok", actual: "ok", quoted: "brand", estimated: "warn", manual: "warn" };

function List({ items, tone }: { items: string[]; tone?: string }) {
  if (!items.length) return <span className="text-ink-soft">—</span>;
  return <ul className={`space-y-1 text-xs ${tone ?? ""}`}>{items.map((t, i) => <li key={i}>• {t}</li>)}</ul>;
}

export default async function ComparisonDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext();
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!a || a.kind !== "property_comparison") notFound();
  const out = a.outputs as RatingResult;
  const inputs = a.inputs as { properties: RatingProperty[]; model: { name: string; version?: number } };
  const raw = new Map(inputs.properties.map((p) => [p.key, p]));
  const props = out.properties;
  const rec = props.find((p) => p.key === out.recommendation.key);
  const factorKeys = props[0]?.factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight })) ?? [];

  const row = (label: ReactNode, cell: (p: PropertyRating) => ReactNode) => (
    <tr>
      <th scope="row" className="sticky left-0 z-10 w-36 min-w-36 border-r border-line bg-surface px-3 py-2 text-left text-xs font-medium text-ink-soft">{label}</th>
      {props.map((p) => <td key={p.key} className={`min-w-52 px-3 py-2 align-top text-sm ${p.key === out.recommendation.key ? "bg-brand-soft/40" : ""}`}>{cell(p)}</td>)}
    </tr>
  );

  return (
    <div>
      <PageHeader title={a.title} subtitle={<>{a.requirement?.title ?? "No requirement linked"} · model {out.model.name}{out.model.version ? ` v${out.model.version}` : ""} · formula {out.formula} · term {out.termMonths} months{out.termAssumed ? " (assumed)" : ""}</>}
        actions={<ButtonLink variant="secondary" href="/toolkit/compare">All comparisons</ButtonLink>} />

      <div data-tour="compare-recommendation"><Card title={<span className="flex items-center">Recommendation<HelpFor k="Recommendation" /></span>} className="mb-5">
        {rec ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-lg font-semibold">{rec.name} <span className="text-brand">{rec.score}/100</span>{out.recommendation.tie ? <Badge tone="warn">tie</Badge> : null}</p>
              <p className="mt-1 max-w-3xl text-sm text-ink-soft">{out.recommendation.explanation}</p>
            </div>
            {rec.verification.length ? <div className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">Verify before advising: {rec.verification.join("; ")}</div> : null}
          </div>
        ) : <p className="text-sm text-bad">{out.recommendation.explanation}</p>}
      </Card></div>

      <div data-tour="compare-table" className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-canvas">
              <th className="sticky left-0 z-10 border-r border-line bg-canvas px-3 py-2 text-xs uppercase tracking-wide text-ink-soft">Property</th>
              {props.map((p) => (
                <th key={p.key} className="px-3 py-2 align-top">
                  <div className="font-semibold">{p.rank ? <span className="mr-1 text-ink-soft">#{p.rank}</span> : null}{p.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={ELIG[p.eligibility][0]}>{ELIG[p.eligibility][1]}</Badge>
                    {p.evidence ? <Badge tone={EVID[p.evidence] ?? "neutral"}>{p.evidence}</Badge> : <Badge>no commercials</Badge>}
                    {p.source === "manual" ? <Badge tone="warn">manual entry</Badge> : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {row("Score", (p) => p.score === null ? dash : (
              <div>
                <div className="flex items-baseline gap-2"><span className="text-xl font-bold">{p.score}</span><span className="text-xs text-ink-soft">/100 · {Math.round(p.coverage * 100)}% of weight known</span></div>
                <div className="mt-1 h-2 rounded-full bg-canvas"><div className={`h-2 rounded-full ${p.eligibility === "eligible" ? "bg-brand" : "bg-line"}`} style={{ width: `${p.score}%` }} /></div>
              </div>
            ))}
            {row("Micro-market", (p) => raw.get(p.key)?.microMarket ?? dash)}
            {row("Grade", (p) => raw.get(p.key)?.grade ?? dash)}
            {row("Area", (p) => { const r = raw.get(p.key); return r?.areaSf != null ? `${sf(r.areaSf)} ${r.areaBasis ?? "(basis unknown)"}` : dash; })}
            {row("Rent ₹/sf/mo", (p) => { const r = raw.get(p.key); return r?.rent != null ? <>{r.rent} <span className="text-xs text-ink-soft">{r.rentBasis ?? "basis?"}</span></> : dash; })}
            {row("CAM ₹/sf/mo", (p) => v(raw.get(p.key)?.cam))}
            {row("Escalation", (p) => { const r = raw.get(p.key); return r?.escalationPct != null ? `${r.escalationPct}%${r.escalationEveryMonths ? ` every ${r.escalationEveryMonths / 12}y` : ""}` : dash; })}
            {row("Rent-free", (p) => v(raw.get(p.key)?.rentFreeMonths, " months"))}
            {row("Effective cost", (p) => p.occupancyCost === null ? dash : <>₹{p.occupancyCost.toFixed(2)}<span className="text-xs text-ink-soft"> /sf/mo over term</span></>)}
            {row("Refundable deposit", (p) => v(p.depositMonths, " months"))}
            {factorKeys.map((f) => row(<>{f.label} <span className="text-ink-soft">({f.weight})</span></>, (p) => {
              const x = p.factors.find((y) => y.key === f.key);
              if (!x || x.score === null) return <span className="text-xs text-ink-soft">excluded — {x?.reason ?? "unknown"}</span>;
              return <div><div className="h-1.5 rounded-full bg-canvas"><div className="h-1.5 rounded-full bg-brand/70" style={{ width: `${x.score * 100}%` }} /></div><p className="mt-1 text-xs text-ink-soft">{Math.round(x.score * 100)}% · {x.reason}</p></div>;
            }))}
            {row("Rules", (p) => <ul className="space-y-1 text-xs">{p.rules.map((r, i) => <li key={i} className={r.outcome === "fail" ? "text-bad" : r.outcome === "unknown" ? "text-warn" : "text-ink-soft"}>{r.outcome === "fail" ? "✕" : r.outcome === "unknown" ? "?" : "✓"} {r.label} <span className="opacity-70">({r.detail})</span></li>)}</ul>)}
            {row("Advantages", (p) => <List items={p.advantages} tone="text-ok" />)}
            {row("Disadvantages", (p) => <List items={p.disadvantages} tone="text-bad" />)}
            {row("Limitations", (p) => <List items={p.limitations} />)}
            {row("Missing info", (p) => <List items={p.missing} tone="text-warn" />)}
            {row("Verify", (p) => <List items={p.verification} tone="text-warn" />)}
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Re-run">
          <p className="mb-3 text-sm text-ink-soft">Re-reads buildings, quotes and availability, keeps manual rows, and saves a new version. Older versions stay unchanged.</p>
          <ActionForm action={rerunComparisonAction} className="flex flex-col gap-2 sm:flex-row">
            <input type="hidden" name="id" value={a.id} />
            <input name="note" placeholder="Note (optional)" className="flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm" />
            <Submit variant="secondary">Re-run as new version</Submit>
          </ActionForm>
        </Card>
        <Card title="Versions">
          <ul className="divide-y divide-line text-sm">
            {(a.versions as { version: number; formula_version: string; note: string | null; created_at: string }[]).map((x) => (
              <li key={x.version} className="flex justify-between py-2"><span>v{x.version} · {x.formula_version}{x.note ? ` · ${x.note}` : ""}</span><span className="text-xs text-ink-soft">{new Date(x.created_at).toLocaleString("en-IN")}</span></li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
