import { DeckPanel } from "@/modules/toolkit/ui/deck-button";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { HelpFor, sf } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { rerunComparisonAction } from "@/modules/toolkit/actions-compare";
import { getAnalysis } from "@/modules/toolkit/store";
import type { PropertyRating, RatingProperty, RatingResult } from "@/modules/toolkit/calc/rating";
import { COMPARE_STEPS, whyLost } from "@/modules/toolkit/ui/compare/explain";
import { Certainty, Field, Legend, MissingNote, Readout, Status, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";

const CERT: Record<string, string> = { approved: "confirmed", actual: "confirmed", quoted: "quoted", estimated: "estimated", manual: "estimated" };
const certOf = (p: PropertyRating) => (p.evidence ? CERT[p.evidence] ?? "estimated" : "missing");
const unknown = <Certainty c="missing" />;
/** A figure plus how sure we are about it. Unknown is shown as "Missing", never as 0. */
const fig = (x: ReactNode | null | undefined, cert: string) => (x === null || x === undefined || x === "" ? unknown : <span className="flex flex-col gap-0.5"><span className="tabular-nums">{x}</span><Certainty c={cert} /></span>);

function List({ items, icon }: { items: string[]; icon: string }) {
  if (!items.length) return <span className="text-ink-soft">—</span>;
  return <ul className="space-y-1 text-xs">{items.map((t, i) => <li key={i}><span aria-hidden>{icon} </span>{t}</li>)}</ul>;
}

function ScoreBar({ score, eligible }: { score: number | null; eligible: boolean }) {
  if (score === null) return <p className="text-sm italic text-ink-soft">No score — not enough data</p>;
  return (
    <div>
      <p className="flex items-baseline gap-1"><span className="text-2xl font-bold tabular-nums">{score}</span><span className="text-sm text-ink-soft">out of 100</span></p>
      <div className="mt-1 h-2.5 rounded-full bg-canvas" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Score"><div className={`h-2.5 rounded-full ${eligible ? "bg-brand" : "bg-slate-300"}`} style={{ width: `${score}%` }} /></div>
    </div>
  );
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
  const ranked = [...props].sort((x, y) => (x.rank ?? 999) - (y.rank ?? 999));
  const factorKeys = props[0]?.factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight })) ?? [];
  const missingAll = props.flatMap((p) => p.missing.map((m) => `${p.name}: ${m}`));

  const row = (label: ReactNode, cell: (p: PropertyRating) => ReactNode) => (
    <tr>
      <th scope="row" className="sticky left-0 z-10 w-32 min-w-32 border-r border-line bg-surface px-3 py-2 text-left text-xs font-medium text-ink-soft sm:w-40 sm:min-w-40">{label}</th>
      {props.map((p) => <td key={p.key} className={`min-w-48 px-3 py-2 align-top text-sm ${p.key === out.recommendation.key ? "bg-brand-soft/40" : ""}`}>{cell(p)}</td>)}
    </tr>
  );

  return (
    <div className="space-y-6">
      <ToolHeader back={{ href: "/toolkit/compare", label: "All comparisons" }} eyebrow="Property comparison" title={a.title}
        purpose={`${a.requirement?.title ?? "No requirement linked"} · rating model ${out.model.name}${out.model.version ? ` v${out.model.version}` : ""} · lease term ${out.termMonths} months${out.termAssumed ? " (assumed)" : ""} · formula ${out.formula}`}
        steps={COMPARE_STEPS} current={2} />
      <DeckPanel db={ctx.db} ws={ctx.workspaceId} analysisId={id} />
      <Legend />

      <section data-tour="compare-recommendation" aria-labelledby="rec-h" className={`rounded-2xl border p-5 ${rec ? "border-brand/40 bg-brand-soft" : "border-amber-200 bg-amber-50"}`}>
        <h2 id="rec-h" className="flex items-center text-sm font-semibold uppercase tracking-wide text-ink-soft">Recommendation<HelpFor k="Recommendation" /></h2>
        {rec ? (
          <>
            <p className="mt-2 text-2xl font-bold text-ink">{rec.name} <span className="text-brand">{rec.score} / 100</span>{out.recommendation.tie ? <span className="ml-2 align-middle"><Status s="pending" label="Tie" /></span> : null}</p>
            <p className="mt-1 max-w-3xl text-[15px] text-ink">{out.recommendation.explanation}</p>
            {props.length > 1 ? <ul className="mt-3 space-y-1 text-sm text-ink-soft">{ranked.filter((p) => p.key !== rec.key).map((p) => <li key={p.key}><span aria-hidden>• </span>{whyLost(p, rec)}</li>)}</ul> : null}
            {rec.verification.length ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">! Verify before advising: {rec.verification.join("; ")}</p> : null}
          </>
        ) : <p className="mt-2 text-[15px] text-amber-900">! {out.recommendation.explanation}</p>}
      </section>

      <section aria-labelledby="rank-h" className="space-y-3">
        <h2 id="rank-h" className="text-lg font-semibold">Ranking</h2>
        <ol className="grid gap-3 md:grid-cols-2">
          {ranked.map((p) => {
            const r = raw.get(p.key);
            return (
              <li key={p.key} className={`rounded-xl border bg-surface p-4 ${p.key === out.recommendation.key ? "border-brand ring-1 ring-brand" : "border-line"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-semibold">{p.rank ? <span className="mr-1 text-ink-soft">#{p.rank}</span> : null}{p.name}</p>
                  <div className="flex flex-wrap gap-1"><Status s={p.eligibility} />{p.source === "manual" ? <Status s="manual" label="✎ Manual entry" /> : null}</div>
                </div>
                <p className="mt-0.5 text-xs text-ink-soft">{[r?.microMarket, r?.grade ? `Grade ${r.grade}` : null, r?.areaSf != null ? sf(r.areaSf) : null].filter(Boolean).join(" · ") || "Location, grade and area unknown"}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <ScoreBar score={p.score} eligible={p.eligibility === "eligible"} />
                  <Readout label="Effective cost" unknown={p.occupancyCost === null} value={p.occupancyCost === null ? "" : `₹${p.occupancyCost.toFixed(2)}`} sub={`per sf / month over ${out.termMonths} months`} />
                </div>
                {p.score !== null ? <p className="mt-2 text-xs text-ink-soft">Based on {Math.round(p.coverage * 100)}% of the weights — the rest is unknown and left out.</p> : null}
                <details className="group mt-3">
                  <summary className={`${btn.quiet} cursor-pointer list-none`}>Why this score <span aria-hidden className="transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
                  <ul className="mt-2 space-y-2 text-sm">
                    {p.factors.map((f) => (
                      <li key={f.key}>
                        <p className="flex justify-between gap-2"><span>{f.label} <span className="text-xs text-ink-soft">(weight {f.weight})</span></span><span className="tabular-nums">{f.score === null ? <Certainty c="missing" /> : `${Math.round(f.score * 100)}%`}</span></p>
                        {f.score !== null ? <div className="mt-1 h-1.5 rounded-full bg-canvas"><div className="h-1.5 rounded-full bg-brand/70" style={{ width: `${f.score * 100}%` }} /></div> : null}
                        <p className="text-xs text-ink-soft">{f.score === null ? `Left out — ${f.reason ?? "unknown"}` : f.reason}</p>
                      </li>
                    ))}
                    {p.rules.map((x, i) => <li key={`r${i}`} className="text-xs"><span aria-hidden>{x.outcome === "fail" ? "✕" : x.outcome === "unknown" ? "?" : "✓"} </span><span className="font-medium">{x.outcome === "fail" ? "Fails" : x.outcome === "unknown" ? "Can't check" : "Passes"}:</span> {x.label} <span className="text-ink-soft">({x.detail})</span></li>)}
                  </ul>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      <MissingNote items={missingAll} what="fill these in and re-run to firm up the ranking" />

      <section aria-labelledby="tbl-h" className="space-y-3">
        <h2 id="tbl-h" className="text-lg font-semibold">Side-by-side detail</h2>
        <p className="text-sm text-ink-soft md:hidden">Scroll sideways to see every building →</p>
        <div data-tour="compare-table" className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-canvas">
                <th scope="col" className="sticky left-0 z-10 border-r border-line bg-canvas px-3 py-2 text-xs uppercase tracking-wide text-ink-soft">Building</th>
                {props.map((p) => (
                  <th scope="col" key={p.key} className="px-3 py-2 align-top">
                    <div className="font-semibold">{p.rank ? <span className="mr-1 text-ink-soft">#{p.rank}</span> : null}{p.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1"><Status s={p.eligibility} />{p.evidence ? null : <Status s="needs_info" label="No commercials" />}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {row("Score", (p) => p.score === null ? unknown : <span className="tabular-nums"><b>{p.score}</b> <span className="text-xs text-ink-soft">out of 100</span></span>)}
              {row("Micro-market", (p) => fig(raw.get(p.key)?.microMarket, certOf(p)))}
              {row("Grade", (p) => fig(raw.get(p.key)?.grade, certOf(p)))}
              {row("Area", (p) => { const r = raw.get(p.key); return fig(r?.areaSf != null ? `${sf(r.areaSf)} ${r.areaBasis ?? "(basis unknown)"}` : null, certOf(p)); })}
              {row("Rent ₹/sf/month", (p) => { const r = raw.get(p.key); return fig(r?.rent != null ? <>{r.rent} <span className="text-xs text-ink-soft">{r.rentBasis ?? "basis?"}</span></> : null, certOf(p)); })}
              {row("CAM ₹/sf/month", (p) => fig(raw.get(p.key)?.cam, certOf(p)))}
              {row("Escalation", (p) => { const r = raw.get(p.key); return fig(r?.escalationPct != null ? `${r.escalationPct}%${r.escalationEveryMonths ? ` every ${r.escalationEveryMonths / 12} yr` : ""}` : null, certOf(p)); })}
              {row("Rent-free", (p) => fig(raw.get(p.key)?.rentFreeMonths != null ? `${raw.get(p.key)?.rentFreeMonths} months` : null, certOf(p)))}
              {row(<>Effective cost <span className="block text-[10px] uppercase">Calculated</span></>, (p) => p.occupancyCost === null ? unknown : <span className="rounded bg-canvas px-1.5 py-0.5 tabular-nums">₹{p.occupancyCost.toFixed(2)}<span className="text-xs text-ink-soft"> /sf/month</span></span>)}
              {row("Refundable deposit", (p) => fig(p.depositMonths != null ? `${p.depositMonths} months` : null, certOf(p)))}
              {factorKeys.map((f) => row(<>{f.label} <span className="text-ink-soft">(weight {f.weight})</span></>, (p) => {
                const x = p.factors.find((y) => y.key === f.key);
                if (!x || x.score === null) return <span className="text-xs text-ink-soft">Left out — {x?.reason ?? "unknown"}</span>;
                return <div><div className="h-1.5 rounded-full bg-canvas"><div className="h-1.5 rounded-full bg-brand/70" style={{ width: `${x.score * 100}%` }} /></div><p className="mt-1 text-xs text-ink-soft">{Math.round(x.score * 100)}% · {x.reason}</p></div>;
              }))}
              {row("Must-have rules", (p) => <ul className="space-y-1 text-xs">{p.rules.map((r, i) => <li key={i} className={r.outcome === "fail" ? "text-rose-700" : r.outcome === "unknown" ? "text-amber-800" : "text-ink-soft"}><span aria-hidden>{r.outcome === "fail" ? "✕" : r.outcome === "unknown" ? "?" : "✓"} </span><span className="sr-only">{r.outcome === "fail" ? "Fails: " : r.outcome === "unknown" ? "Cannot check: " : "Passes: "}</span>{r.label} <span className="opacity-70">({r.detail})</span></li>)}</ul>)}
              {row("Advantages", (p) => <List items={p.advantages} icon="+" />)}
              {row("Disadvantages", (p) => <List items={p.disadvantages} icon="−" />)}
              {row("Limitations", (p) => <List items={p.limitations} icon="•" />)}
              {row("Missing info", (p) => <List items={p.missing} icon="?" />)}
              {row("Verify", (p) => <List items={p.verification} icon="!" />)}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="next-h" className="rounded-xl border border-line bg-surface p-5">
        <h2 id="next-h" className="font-semibold">Next: use in a client document</h2>
        <p className="mt-1 text-sm text-ink-soft">Bring this ranking into a client brief or proposal from the Deal toolkit.</p>
        <Link href="/toolkit" className={`${btn.secondary} mt-3`}>Open Deal toolkit</Link>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="rerun-h" className="rounded-xl border border-line bg-surface p-5">
          <h2 id="rerun-h" className="font-semibold">Change inputs &amp; re-run (saves a new version)</h2>
          <p className="mt-1 mb-3 text-sm text-ink-soft">Re-reads buildings, quotes and availability, keeps manual rows, and saves a new version. Older versions stay unchanged.</p>
          <ActionForm action={rerunComparisonAction} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={a.id} />
            <Field label="Note for this version" htmlFor="rerun-note"><input id="rerun-note" name="note" placeholder="e.g. Updated rent quote for Tower B" className={inputCls} /></Field>
            <Submit className="min-h-11 self-start">Re-run as new version</Submit>
          </ActionForm>
        </section>
        <section aria-labelledby="ver-h" className="p-1">
          <h2 id="ver-h" className="text-sm font-semibold text-ink-soft">Versions</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {(a.versions as { version: number; formula_version: string; note: string | null; created_at: string }[]).map((x) => (
              <li key={x.version} className="flex flex-wrap justify-between gap-2 py-2 text-ink-soft"><span><span className="font-medium text-ink">v{x.version}</span> · {x.formula_version}{x.note ? ` · ${x.note}` : ""}</span><span className="text-xs">{new Date(x.created_at).toLocaleString("en-IN")}</span></li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
