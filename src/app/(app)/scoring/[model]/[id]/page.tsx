import { HelpFor } from "@/components/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { MODELS, MODEL_KEYS } from "@/modules/scoring/models";
import { scoreEntity } from "@/modules/scoring/service";
import { recalcAction, overrideAction, feedbackAction, explainAction } from "@/modules/scoring/actions";
import { ScoreBar, CONF_LABEL } from "@/modules/scoring/ui/parts";
import type { ModelKey } from "@/modules/scoring/engine";

export const metadata = { title: "Score" };
type Row = Record<string, any>;
const LINK: Record<string, string> = { organisation: "/companies", person: "/people", requirement: "/requirements", opportunity: "/deals" };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const ROLE: Record<string, string> = { decision_maker: "Decision-maker", influencer: "Influencer", evaluator: "Evaluator", gatekeeper: "Gatekeeper", operational: "Operational stakeholder", unknown: "Unknown authority" };

export default async function Page({ params }: { params: Promise<{ model: string; id: string }> }) {
  const { model, id } = await params;
  if (!MODEL_KEYS.includes(model as ModelKey)) notFound();
  const key = model as ModelKey;
  const ctx = await requirePageContext("viewer");
  let { data: cur } = await ctx.db.from("score_result").select("*, version:model_version_id(version)").eq("workspace_id", ctx.workspaceId).eq("model_key", key).eq("entity_id", id).eq("is_current", true).maybeSingle();
  if (!cur && hasRole(ctx, "editor")) {
    try { await scoreEntity(ctx.db, ctx.workspaceId, key, id, "first_view"); } catch { /* entity missing */ }
    cur = (await ctx.db.from("score_result").select("*, version:model_version_id(version)").eq("workspace_id", ctx.workspaceId).eq("model_key", key).eq("entity_id", id).eq("is_current", true).maybeSingle()).data;
  }
  if (!cur) notFound();
  const [{ data: hist }, { data: ov }, { data: assess }] = await Promise.all([
    ctx.db.from("score_result").select("id, score, band, previous_score, change_reason, trigger, calculated_at, version:model_version_id(version)").eq("workspace_id", ctx.workspaceId).eq("model_key", key).eq("entity_id", id).order("calculated_at", { ascending: false }).limit(20),
    ctx.db.from("score_override").select("value, reason, original_score, created_at").eq("workspace_id", ctx.workspaceId).eq("model_key", key).eq("entity_id", id).eq("kind", "priority").eq("active", true).maybeSingle(),
    ctx.db.from("score_override").select("value, reason, created_at").eq("workspace_id", ctx.workspaceId).eq("model_key", "relationship").eq("entity_id", id).eq("kind", "relationship_assessment").eq("active", true).maybeSingle(),
  ]);
  const ex = (cur.extra ?? {}) as Row;
  const name = ex.company ?? ex.name ?? ex.title ?? "Record";
  const title = key === "contact" ? ex.name : key === "requirement" ? ex.title : key === "opportunity" ? ex.name : ex.company;
  const editor = hasRole(ctx, "editor");
  const m = MODELS[key];
  const sel = "min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm";
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href={`/scoring?tab=${key}`} className="text-sm text-ink-soft hover:text-ink">Scoring</Link>
      <header className="rounded-2xl border border-line bg-surface p-6">
        <p className="text-sm text-ink-soft">{m.name}</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-2xl font-bold leading-tight">{title ?? name}</h1>
          <p className="text-right"><span className="text-5xl font-bold tabular-nums leading-none">{cur.score}</span><span className="text-ink-soft">/100</span></p>
        </div>
        <div className="mt-4"><ScoreBar score={cur.score} band={cur.band} size="lg" /></div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-ink-soft">Priority</dt><dd className="font-semibold">{ov ? <><s className="font-normal text-ink-soft">{cur.band}</s> {ov.value}</> : cur.band}</dd></div>
          <div><dt className="text-ink-soft">Evidence</dt><dd className="font-semibold">{CONF_LABEL[cur.confidence]}</dd></div>
          <div><dt className="text-ink-soft">Data known</dt><dd className={`font-semibold ${cur.completeness < 50 ? "text-amber-700" : ""}`}>{cur.completeness}%</dd></div>
          <div><dt className="text-ink-soft">Calculated</dt><dd className="font-semibold">{new Date(cur.calculated_at).toLocaleDateString("en-IN", { dateStyle: "medium" })} · v{cur.version?.version}</dd></div>
        </dl>
        {cur.completeness < 50 ? <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Less than half of the inputs are known, so treat this score as a first view, not a conclusion.</p> : null}
        {ov ? <p className="mt-3 text-sm">Priority set to <b>{ov.value}</b> by your team: “{ov.reason}”. The calculated score ({ov.original_score ?? cur.score}) is kept.</p> : null}
        {key === "lead" ? <p className="mt-3 text-xs text-ink-soft">A high lead score means worth pursuing now. It does not mean the company is ready to sign.</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {LINK[cur.entity_type] ? <Link href={`${LINK[cur.entity_type]}/${id}`} className="inline-flex min-h-10 items-center rounded-xl border border-line px-4 text-sm font-semibold">Open record</Link> : null}
          {editor ? <ActionForm action={recalcAction.bind(null, key, id)}><Submit variant="secondary">Recalculate</Submit></ActionForm> : null}
        </div>
      </header>

      {cur.recommended_action ? <section className="rounded-2xl border border-brand/30 bg-brand-soft/40 p-5"><h2 className="text-sm font-semibold">Recommended next step<HelpFor k="Recommended next step" /></h2><p className="mt-1">{cur.recommended_action}</p></section> : null}

      {key === "contact" || key === "requirement" || key === "opportunity" ? (
        <section className="grid gap-3 sm:grid-cols-4">
          {key === "contact" ? <><Fact label="Role in decision" value={ROLE[ex.role_class] ?? "Unknown"} /><Fact label="Employment" value={String(ex.verification ?? "none").replace(/_/g, " ")} /></> : null}
          {key === "requirement" ? <><Fact label="Completeness" value={`${cur.completeness}%`} /><Fact label="Urgency" value={ex.urgency == null ? "Unknown" : `${ex.urgency}/100`} /><Fact label="Commercial size" value={ex.attractiveness == null ? "Unknown" : `${ex.attractiveness}/100`} /><Fact label="Verification" value={String(ex.verification).replace(/_/g, " ")} /></> : null}
          {key === "opportunity" ? <><Fact label="Stage" value={String(ex.stage).replace(/_/g, " ")} /><Fact label="Expected fee" value={ex.revenue ? `₹${Number(ex.revenue).toLocaleString("en-IN")}` : "Not recorded"} /><Fact label="Win probability" value="Not estimated" hint={ex.probability} /></> : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">AI summary<HelpFor k="AI summary" /></h2>
          {editor ? <ActionForm action={explainAction.bind(null, key, id, cur.id)}><Submit variant="secondary">{ex.ai ? "Rewrite summary" : "Summarise with AI"}</Submit></ActionForm> : null}
        </div>
        {ex.ai ? (
          <div className="mt-3 space-y-3 text-sm">
            <p>{ex.ai.summary}</p>
            {ex.ai.risks?.length ? <div><p className="font-medium">Risks</p><ul className="list-disc pl-5">{(ex.ai.risks as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
            {ex.ai.questions?.length ? <div><p className="font-medium">Questions to ask</p><ul className="list-disc pl-5">{(ex.ai.questions as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
            <p className="text-xs text-ink-soft">Written by {String(ex.ai.model).replace(/^mock:.*/, "rules (AI not connected)")} on {new Date(ex.ai.at).toLocaleDateString("en-IN", { dateStyle: "medium" })}. It explains the score; it does not change it.</p>
          </div>
        ) : <p className="mt-2 text-sm text-ink-soft">A plain-English read of this score, its risks and what to ask next.</p>}
      </section>

      <section className="rounded-2xl border border-line bg-surface">
        <h2 className="px-6 pt-5 font-semibold">How the score is built<HelpFor k="How the score is built" /></h2>
        <ul className="mt-2 divide-y divide-line">
          {(cur.factors as Row[]).map((f) => (
            <li key={f.key}>
              <details className="group px-6 py-4">
                <summary className="flex cursor-pointer list-none items-center gap-4">
                  <span className="min-w-0 flex-1"><span className="block font-medium">{f.label}</span><span className="block text-sm text-ink-soft">{f.explanation}</span></span>
                  <span className="w-20 shrink-0 text-right tabular-nums">{f.known ? <><b>{f.points}</b><span className="text-ink-soft">/{f.max}</span></> : <span className="text-xs text-amber-700">Unknown</span>}</span>
                </summary>
                <div className="mt-3 rounded-xl bg-canvas p-4 text-sm">
                  <p className="text-ink-soft">{m.version.factors.find((x) => x.key === f.key)?.description}</p>
                  {(f.evidence ?? []).length ? <ul className="mt-2 space-y-1">{(f.evidence as Row[]).map((e, i) => <li key={i}>{e.url ? <a className="text-brand underline" href={e.url} target="_blank" rel="noreferrer noopener">{e.label} ({host(e.url)})</a> : e.type === "signal" && e.id ? <Link className="text-brand underline" href={`/signals/${e.id}`}>{e.label}</Link> : <span>{e.label}</span>}{e.date ? <span className="text-ink-soft"> · {e.date}</span> : null}</li>)}</ul> : <p className="mt-2 text-ink-soft">No evidence linked.</p>}
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>

      {(cur.missing ?? []).length || (ex.risks ?? []).length ? (
        <section className="grid gap-4 sm:grid-cols-2">
          {(cur.missing ?? []).length ? <div className="rounded-2xl border border-line bg-surface p-5"><h2 className="font-semibold">Missing information<HelpFor k="Missing information" /></h2><ul className="mt-2 list-disc pl-5 text-sm">{(cur.missing as string[]).map((x) => <li key={x}>{x}</li>)}</ul><p className="mt-2 text-xs text-ink-soft">Unknown is not treated as a negative.</p></div> : null}
          {(ex.risks ?? []).length ? <div className="rounded-2xl border border-line bg-surface p-5"><h2 className="font-semibold">Key risks<HelpFor k="Key risks" /></h2><ul className="mt-2 list-disc pl-5 text-sm">{(ex.risks as string[]).map((x) => <li key={x}>{x}</li>)}</ul></div> : null}
        </section>
      ) : null}

      {editor ? (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Change priority<HelpFor k="Change priority" /></h2>
            <ActionForm action={overrideAction.bind(null, key, id)} className="mt-3 space-y-3">
              <select name="value" defaultValue={ov?.value ?? cur.band} aria-label="Priority" className={sel}>{m.version.bands.map((b) => <option key={b.label}>{b.label}</option>)}</select>
              <input name="reason" placeholder="Why? (required to save)" aria-label="Reason" className={sel} />
              <div className="flex gap-2"><Submit>Save priority</Submit>{ov ? <Submit variant="secondary" name="clear" value="1">Remove</Submit> : null}</div>
            </ActionForm>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Is this score right?<HelpFor k="Is this score right?" /></h2>
            <ActionForm action={feedbackAction.bind(null, key, id, cur.id)} className="mt-3 space-y-3">
              <select name="kind" aria-label="Feedback" className={sel}><option value="accurate">Score is accurate</option><option value="too_high">Too high</option><option value="too_low">Too low</option><option value="wrong_company">Wrong company</option><option value="missing_evidence">Missing evidence</option><option value="incorrect_requirement">Incorrect requirement</option><option value="incorrect_contact">Incorrect contact relevance</option><option value="incorrect_match">Incorrect property match</option></select>
              <input name="comment" placeholder="Comment (optional)" aria-label="Comment" className={sel} />
              <Submit variant="secondary">Send feedback</Submit>
            </ActionForm>
          </div>
          {key === "relationship" ? (
            <div className="rounded-2xl border border-line bg-surface p-5 sm:col-span-2">
              <h2 className="font-semibold">Your assessment of the relationship<HelpFor k="Your assessment of the relationship" /></h2>
              {assess ? <p className="mt-1 text-sm text-ink-soft">Current: {assess.value} — “{assess.reason}”</p> : null}
              <ActionForm action={overrideAction.bind(null, "relationship", id)} className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input type="hidden" name="kind" value="relationship_assessment" />
                <select name="value" defaultValue={assess?.value ?? "developing"} aria-label="Assessment" className={sel}><option value="strong">Strong</option><option value="active">Active</option><option value="developing">Developing</option><option value="weak">Weak</option><option value="none">No relationship</option></select>
                <input name="reason" required minLength={3} placeholder="Why? (required)" aria-label="Reason" className={sel} />
                <Submit>Save</Submit>
              </ActionForm>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-surface p-6">
        <h2 className="font-semibold">Score history<HelpFor k="Score history" /></h2>
        <ol className="mt-3 space-y-3 text-sm">
          {(hist ?? []).map((h: Row) => (
            <li key={h.id} className="flex gap-4">
              <span className="w-24 shrink-0 text-ink-soft">{new Date(h.calculated_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
              <span className="w-20 shrink-0 font-semibold tabular-nums">{h.previous_score != null ? `${h.previous_score} → ` : ""}{h.score}</span>
              <span className="min-w-0 text-ink-soft">{h.change_reason ?? "—"} <span className="text-xs">({String(h.trigger).replace(/[._]/g, " ")}, model v{h.version?.version})</span></span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="rounded-2xl border border-line bg-surface p-4" title={hint}><p className="text-xs text-ink-soft">{label}</p><p className="mt-1 font-semibold capitalize">{value}</p>{hint ? <p className="mt-1 text-xs text-ink-soft">{hint}</p> : null}</div>;
}
