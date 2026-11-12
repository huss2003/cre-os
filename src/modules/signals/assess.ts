/**
 * Client-potential assessment for one company. Claude (Haiku + web search) only EXTRACTS dated, cited facts;
 * the score out of 100 is computed here by fixed rules (no model arithmetic), and every point shows how much it added.
 * Your own records (leases, contacts, requirements, deals) are added as points too. Unknowns stay unknown.
 */
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import { orgContext, settings } from "./service";
import { startRun } from "./research";

export const FACTORS = ["pune_expansion", "new_office", "gcc", "hiring_local", "relocation", "consolidation", "lease_event", "funding", "leadership_change", "rto", "india_expansion", "headcount_growth", "layoffs", "office_exit", "other"] as const;
type Factor = (typeof FACTORS)[number];

/** Points per factor (first occurrence only). Negative = reason against. Tuned for a Pune occupier adviser. */
export const WEIGHTS: Record<Factor, number> = {
  pune_expansion: 22, new_office: 16, gcc: 18, hiring_local: 12, relocation: 12, consolidation: 10, lease_event: 10,
  funding: 8, leadership_change: 7, rto: 6, india_expansion: 6, headcount_growth: 6, layoffs: -8, office_exit: -6, other: 2,
};
const LABEL: Record<Factor, string> = {
  pune_expansion: "Expanding in Pune", new_office: "New office", gcc: "GCC / captive centre", hiring_local: "Hiring locally",
  relocation: "Relocation", consolidation: "Consolidation", lease_event: "Lease event", funding: "New funding", leadership_change: "New decision-maker",
  rto: "Return-to-office", india_expansion: "Growing in India", headcount_growth: "Headcount growth", layoffs: "Layoffs", office_exit: "Office exit", other: "Other",
};

const Out = z.object({
  summary: z.string(),
  pune_presence: z.string().nullable(),
  facts: z.array(z.object({ factor: z.string(), point: z.string(), location: z.string().nullable(), published_on: z.string().nullable(), source_url: z.string(), source_name: z.string() })),
  unknowns: z.array(z.string()),
});

export interface Point { text: string; points: number; factor: string; label: string; source?: { url: string; name: string; date: string | null }; from: "web" | "records" }
export interface Assessment { company: string; orgId: string | null; score: number; band: "Strong" | "Promising" | "Weak"; summary: string; pune_presence: string | null; for: Point[]; against: Point[]; unknowns: string[]; method: string; at: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const monthsAgo = (d: string | null) => (d && DATE.test(d) ? (Date.now() - Date.parse(d)) / (30 * 86_400_000) : null);

/** Pure scoring — exported for tests. */
export function score(webFacts: z.infer<typeof Out>["facts"], records: Point[], focus: string[]): { for: Point[]; against: Point[]; score: number } {
  const seen = new Set<string>();
  const pts: Point[] = [];
  for (const f of webFacts) {
    if (!/^https?:\/\//.test(f.source_url) || /linkedin\.com/i.test(f.source_url)) continue;
    let factor = ((FACTORS as readonly string[]).includes(f.factor) ? f.factor : "other") as Factor;
    // "hiring" / "new office" outside the focus cities counts as general India growth, not local demand.
    const local = focus.some((c) => `${f.location ?? ""} ${f.point}`.toLowerCase().includes(c.toLowerCase()));
    if (!local && (factor === "hiring_local" || factor === "pune_expansion")) factor = "india_expansion";
    if (seen.has(factor)) continue;
    seen.add(factor);
    const age = monthsAgo(f.published_on);
    let w = WEIGHTS[factor];
    if (w > 0 && age !== null && age > 12) w = Math.round(w / 2);         // old news counts half
    if (w > 0 && age === null) w = Math.round(w * 0.75);                  // undated counts less
    pts.push({ text: f.point.slice(0, 300), points: w, factor, label: LABEL[factor], from: "web",
      source: { url: f.source_url, name: f.source_name.slice(0, 80), date: f.published_on && DATE.test(f.published_on) ? f.published_on : null } });
  }
  for (const r of records) if (!seen.has(r.factor + ":rec")) { seen.add(r.factor + ":rec"); pts.push(r); }
  const total = Math.max(0, Math.min(100, 10 + pts.reduce((a, p) => a + p.points, 0)));   // 10 = baseline for a named company
  return { for: pts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points), against: pts.filter((p) => p.points <= 0), score: total };
}

/** Keyword rules: signal kind/title/summary → assessment factor (first match wins; order = specificity). */
const FACTOR_RULES: [RegExp, Factor][] = [
  [/\blayoff|retrench|job cuts|downsiz/i, "layoffs"],
  [/\b(office exit|shut(?:s|ting)? (?:down )?(?:its )?office|clos(?:e|es|ing) (?:its )?(?:pune |india )?office|vacat)/i, "office_exit"],
  [/\bgcc\b|captive|global capabilit|global (?:delivery|technology|innovation) cent/i, "gcc"],
  [/\brelocat|mov(?:e|es|ing) (?:its )?(?:office|hq|headquarters)/i, "relocation"],
  [/\bconsolidat|merg(?:e|ing) (?:offices|campuses)/i, "consolidation"],
  [/\blease|lock[\s-]?in|notice deadline|expiry|renewal/i, "lease_event"],
  [/\bnew office|opens? (?:a |its )?(?:new )?(?:office|campus|centre|center)|inaugurat/i, "new_office"],
  [/\bexpan|scal(?:e|ing) up|additional (?:space|floors?)/i, "pune_expansion"],
  [/\bhir(?:e|es|ing)|recruit|job openings?|headcount to/i, "hiring_local"],
  [/\bheadcount growth|workforce grew|employees grew/i, "headcount_growth"],
  [/\bfund(?:ing|raise|ed)|series [a-f]\b|raises? \$|ipo\b/i, "funding"],
  [/\bappoint|joins? as|new (?:ceo|cfo|coo|head|md|country)|leadership change|job_move/i, "leadership_change"],
  [/\breturn[\s-]to[\s-]office|\brto\b|work from office|days a week in office/i, "rto"],
  [/\bindia (?:expansion|growth)|enter(?:s|ing)? india/i, "india_expansion"],
];

export function factorFor(kind: string, text: string): Factor {
  if ((FACTORS as readonly string[]).includes(kind)) return kind as Factor;
  const hay = `${kind.replace(/_/g, " ")} ${text}`;
  for (const [re, f] of FACTOR_RULES) if (re.test(hay)) return f;
  return "other";
}

type StoredSignal = { kind: string; title: string; summary: string | null; location_text: string | null; event_date: string | null; latest_evidence_on: string | null; detected_at: string; confidence: string; evidence?: { source_url: string | null; source_name: string | null; published_on: string | null }[] };

/** Rules-only assessment input from signals already stored for the company (AI policy "off" path). */
export function codeAssessment(company: string, signals: StoredSignal[], focus: string[], hints: string[] = []): z.infer<typeof Out> {
  // Discovery hints look like "summary (https://url, 2026-11-05)" — sourced leads found by the research step.
  for (const h of hints) {
    const m = /^(.*)\((https?:\/\/[^\s,)]+)(?:,\s*(\d{4}-\d{2}-\d{2}))?\)\s*$/.exec(h.trim());
    if (!m) continue;
    signals = [...signals, { kind: "", title: m[1].trim(), summary: null, location_text: focus.find((c) => m[1].toLowerCase().includes(c.toLowerCase())) ?? null, event_date: null, latest_evidence_on: m[3] ?? null, detected_at: "", confidence: "medium",
      evidence: [{ source_url: m[2], source_name: new URL(m[2]).hostname.replace(/^www\./, ""), published_on: m[3] ?? null }] }];
  }
  const usable = signals.filter((x) => x.confidence !== "insufficient");
  const facts = usable.flatMap((x) => {
    const ev = (x.evidence ?? []).find((e) => e.source_url && /^https?:\/\//.test(e.source_url));
    if (!ev?.source_url) return [];
    const text = `${x.title}${x.summary ? ` — ${x.summary}` : ""}`;
    return [{ factor: factorFor(x.kind, text), point: text.slice(0, 300), location: x.location_text, published_on: ev.published_on ?? x.latest_evidence_on ?? x.event_date ?? null, source_url: ev.source_url, source_name: ev.source_name ?? new URL(ev.source_url).hostname }];
  });
  const local = usable.filter((x) => focus.some((c) => `${x.location_text ?? ""} ${x.title}`.toLowerCase().includes(c.toLowerCase())));
  const summary = usable.length
    ? `${company} has ${usable.length} known signal${usable.length === 1 ? "" : "s"}${local.length ? `, ${local.length} mentioning ${focus.join("/")}` : ""}; the latest is “${usable[0].title.slice(0, 120)}”. Points below come from those signals and your records.`
    : `No stored signals for ${company} yet; points below come from your records only.`;
  const unknowns = [...(facts.length < usable.length ? ["Sources for some stored signals (they count only once a source link is attached)"] : []), ...(usable.length ? [] : ["Recent news (no signals stored — run web research to look)"])];
  return { summary, pune_presence: local[0] ? `${local[0].title}${local[0].location_text ? ` (${local[0].location_text})` : ""}`.slice(0, 300) : null, facts, unknowns };
}

/** Assess a saved company (orgId) or one found on the web that isn't in your records yet (name). */
export async function assessCompany(db: Db, ws: string, target: string | { orgId?: string | null; name?: string; hints?: string[] }, opts: { actorUserId?: string; ai?: typeof callStructured; mode?: AiMode } = {}) {
  const ai = opts.ai ?? callStructured;
  const t = typeof target === "string" ? { orgId: target } : target;
  const orgId = t.orgId ?? null;
  const empty = { org: null, locations: [], leases: [], leaseEvents: [], requirements: [], contacts: [], lastInteractionOn: null, opportunities: [], openTasks: 0 };
  const ctx = orgId ? await orgContext(db, ws, orgId) : { ...empty, org: { display_name: t.name ?? "", sector: null } } as Awaited<ReturnType<typeof orgContext>>;
  if (!ctx.org?.display_name) throw new Error("Company not found.");
  const s = await settings(db, ws);
  const focus = s.focusCities;
  const runId = await startRun(db, ws, "assess", ctx.org.display_name, orgId, opts.actorUserId);

  // Points from your own records (no AI).
  const today = Date.now();
  const records: Point[] = [];
  const soon = ctx.leaseEvents.filter((e) => e.event_date && Date.parse(e.event_date) > today && Date.parse(e.event_date) - today < 548 * 86_400_000)
    .sort((a, b) => a.event_date.localeCompare(b.event_date))[0];
  if (soon) records.push({ factor: "lease_event", label: "Lease event", from: "records", points: 15, text: `${String(soon.event_type).replace(/_/g, " ")} on ${soon.event_date} (${soon.date_basis}) — from your lease records.` });
  const cre = ctx.contacts.find((c) => /real estate|facilit|admin|workplace|procure|cfo|finance|site|country head|managing director|ceo|coo|gcc/i.test(`${c.title ?? ""} ${c.function ?? ""}`));
  if (cre) records.push({ factor: "contact", label: "Known decision-maker", from: "records", points: 8, text: `${cre.name}${cre.title ? `, ${cre.title}` : ""} is in your contacts.` });
  if (ctx.requirements.length) records.push({ factor: "requirement", label: "Open requirement", from: "records", points: 10, text: `${ctx.requirements.length} requirement(s) on record, e.g. “${ctx.requirements[0].title}”.` });
  if (ctx.opportunities.some((o) => o.outcome === "open")) records.push({ factor: "deal", label: "Deal in progress", from: "records", points: 5, text: "An open deal already exists with this company." });
  if (ctx.locations.length) records.push({ factor: "occupancy", label: "Known occupancy", from: "records", points: 4, text: `Occupies ${ctx.locations.slice(0, 3).join(", ")} per your records.` });

  let stored: StoredSignal[] = [];
  if (orgId) {
    const { data } = await db.from("signal").select("kind, title, summary, location_text, event_date, latest_evidence_on, detected_at, confidence, evidence:signal_evidence(source_url, source_name, published_on)")
      .eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).not("status", "in", "(rejected,dismissed)").order("detected_at", { ascending: false }).limit(30);
    stored = (data ?? []) as StoredSignal[];
  }
  const mode = opts.mode ?? await getAiMode(db, ws, "signals.assess");
  let out: z.infer<typeof Out>; let web: any; let usd = 0; let model = "rules";
  try {
    const res = await runWithPolicy<z.infer<typeof Out>>({ mode, code: () => codeAssessment(ctx.org!.display_name, stored, focus, t.hints ?? []), accept: (o) => o.facts.length > 0, ai: async () => {
    const r = await ai({
      workspaceId: ws, workflow: "signals.assess", tier: "luna", webSearch: true, classification: "public", schema: Out, schemaName: "client_assessment",
      system: "You research one company for a commercial real-estate adviser in India. Extract only facts stated in sources you found, each with its URL and date. Never guess office size, budget, headcount or dates; put what you could not find in unknowns. Do not score or rate. Never use LinkedIn.",
      input: `Company: ${ctx.org!.display_name}${ctx.org!.sector ? ` (${ctx.org!.sector})` : ""}. Focus city: ${focus.join(", ")}.
${t.hints?.length ? `Leads already found (verify and expand, do not just repeat): ${t.hints.slice(0, 4).join(" | ")}\n` : ""}Search specifically for this one company. Find recent (last 18 months) evidence relevant to whether they may need office space: expansion or new offices (especially in ${focus.join("/")}), GCC/captive centre plans, local hiring, relocation, consolidation, lease activity, funding, new real-estate/facilities/admin/finance leaders, return-to-office policy, and also layoffs or office exits.
Use factor values exactly from: ${FACTORS.join(", ")}. Up to 8 facts. summary: 2 sentences on the company's ${focus.join("/")} presence and situation. pune_presence: what is known about their offices in ${focus.join("/")}, or null.`,
      mock: () => ({ summary: "Web research is not connected; only your own records were used.", pune_presence: null, facts: [], unknowns: ["Recent news (AI web search not connected)"] }),
    });
    web = r.web; usd = r.usage.usd; model = r.model;
    return r.data;
    } });
    if (res.source !== "ai") { model = "rules"; web = undefined; usd = 0; }
    if (!res.value) throw res.aiError ?? new Error("assessment produced nothing");
    out = res.value;
  } catch (e) {
    if (runId) await db.from("research_run").update({ status: "failed", error: String((e as Error).message).slice(0, 300), finished_at: new Date().toISOString() }).eq("id", runId);
    if (e instanceof AiUnavailableError) throw new Error(`Assessment didn't run: ${e.message}`);
    throw e;
  }
  const sc = score(out.facts, records, focus);
  const unknowns = [...new Set([...out.unknowns.slice(0, 6).map((u) => u.slice(0, 200)), ...(soon ? [] : [orgId ? "Lease expiry / notice dates (not in your records)" : "Their current lease (company not in your records yet)"]), ...(cre ? [] : ["A real-estate or facilities contact"]), "Required area, budget and move-in date"])];
  const a: Assessment = {
    company: ctx.org.display_name, orgId, score: sc.score, band: sc.score >= 70 ? "Strong" : sc.score >= 45 ? "Promising" : "Weak",
    summary: out.summary.slice(0, 600), pune_presence: out.pune_presence?.slice(0, 300) ?? null, for: sc.for, against: sc.against, unknowns,
    method: (model === "rules" ? "Rules over your stored signals and records. " : "") + "10 base points for a named company, plus fixed points per evidence type (first occurrence only). News older than 12 months counts half; undated news counts 75%. Reasons against subtract. Capped at 100. Facts come from sources; scoring is fixed rules.",
    at: new Date().toISOString(),
  };
  const used = sc.for.concat(sc.against).map((p) => p.source?.url).filter(Boolean) as string[];
  const sources = [...new Map([...(web?.sources ?? []), ...used.map((u) => ({ url: u, title: "" }))].map((x) => [x.url, { ...x, used: used.includes(x.url) }])).values()].slice(0, 40);
  if (runId) await db.from("research_run").update({ status: model === "rules" ? "done" : model.startsWith("mock:") ? "skipped" : model.startsWith("fallback:") ? "failed" : "done",
    queries: web?.queries ?? [], sources, findings: sc.for.length, usd, assessment: a, finished_at: new Date().toISOString(),
    error: model === "rules" ? null : model.startsWith("fallback:") ? "AI call failed or its answer couldn't be read" : model.startsWith("mock:") ? "AI not connected — scored from your records only" : null }).eq("id", runId);
  return { runId, assessment: a };
}
