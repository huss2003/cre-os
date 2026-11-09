/**
 * Auto-research: finds recent public evidence about a company with Claude web search (Haiku), stores each finding as a
 * signal_claim with its source link + date, then lets the signal engine build cards. Bounded:
 *  - only active watchlist companies that are due (critical weekly, active monthly, universe quarterly);
 *  - weekly company limit (workspace_setting "signals".weeklyCompanyLimit, default 25);
 *  - max 2 searches per company; the workspace monthly AI budget is enforced by the gateway.
 * No key => mock returns nothing ("insufficient evidence"); nothing is invented. Web pages are untrusted evidence.
 */
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { scanClaims, settings, resolveOrg, upsertSignal, type OrgContext } from "./service";
import { categoryOf, dedupeKey, normName } from "./engine";

const KINDS = ["expansion", "gcc_plan", "hiring", "funding", "consolidation", "layoff", "relocation", "merger", "acquisition", "leadership_change", "rto", "infrastructure", "macro"] as const;
export const ResearchSchema = z.object({
  insufficient_evidence: z.boolean(),
  findings: z.array(z.object({
    kind: z.string(),
    summary: z.string(),
    location: z.string().nullable(),
    event_date: z.string().nullable(),
    published_on: z.string().nullable(),
    source_url: z.string(),
    source_name: z.string(),
    official_source: z.boolean(),
  })),
});
export type ResearchOut = z.infer<typeof ResearchSchema>;

/** Lenient model output → strict values: only full ISO dates and http(s) URLs survive. */
const isoDate = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const okUrl = (v: string) => /^https?:\/\/\S+$/i.test(v);

/** Model output is untrusted: keep only well-formed findings, trim text, drop bad dates/kinds instead of failing the run. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Model "kind" labels vary (new_office, office_lease, leasing…): map them to our list instead of dropping the finding. */
const KIND_ALIAS: [RegExp, (typeof KINDS)[number]][] = [
  [/gcc|capability|captive/, "gcc_plan"], [/lease|leasing|office|campus|expan|open|new_/, "expansion"], [/hir|recruit|job/, "hiring"],
  [/fund|invest|rais/, "funding"], [/consolid/, "consolidation"], [/layoff|cut|reduc/, "layoff"], [/relocat|shift|move/, "relocation"],
  [/merg/, "merger"], [/acqui/, "acquisition"], [/leader|appoint|ceo|head/, "leadership_change"], [/rto|return/, "rto"],
];
function normKind(k: string): (typeof KINDS)[number] {
  const l = (k ?? "").toLowerCase();
  if ((KINDS as readonly string[]).includes(l)) return l as (typeof KINDS)[number];
  return KIND_ALIAS.find(([re]) => re.test(l))?.[1] ?? "expansion";
}
function clean<T extends { kind: string; summary: string; location: string | null; published_on: string | null; source_url: string; source_name: string; event_date?: string | null }>(f: T) {
  if (!/^https?:\/\//.test(f.source_url ?? "")) return null;
  return { ...f, kind: normKind(f.kind), summary: f.summary.slice(0, 400), location: f.location?.slice(0, 100) ?? null,
    source_name: f.source_name.slice(0, 120), published_on: f.published_on && DATE.test(f.published_on) ? f.published_on : null,
    event_date: f.event_date && DATE.test(f.event_date) ? f.event_date : null };
}

/** "fallback:" = the AI answered but the call failed or its answer was unreadable — not the same as "no key". */
function aiKind(model: string): string | null {
  return model.startsWith("fallback:") ? "AI call failed or its answer couldn't be read. Check Settings → AI usage for the error." : null;
}

const CADENCE: Record<string, number> = { critical: 7, active: 30, universe: 90 };

export async function approvedDomains(db: Db, ws: string): Promise<string[]> {
  const { data } = await db.from("research_source_registry").select("base_url, paused, acquisition_method").eq("workspace_id", ws).is("archived_at", null);
  return [...new Set((data ?? []).filter((r) => !r.paused && r.base_url && r.acquisition_method === "gateway_web_search")
    .map((r) => { try { return new URL(String(r.base_url)).hostname.replace(/^www\./, ""); } catch { return null; } }).filter(Boolean) as string[])];
}

// ------------------------------------------------------------------ run log (what was searched, which sites were read)

export async function startRun(db: Db, ws: string, kind: "company" | "discover" | "assess", label: string, orgId: string | null, userId?: string) {
  const { data } = await db.from("research_run").insert({ workspace_id: ws, kind, label, org_id: orgId, status: "running", owner_user_id: userId ?? undefined }).select("id").single();
  return (data?.id as string | undefined) ?? null;
}
async function finishRun(db: Db, ws: string, id: string | null, patch: Record<string, unknown>) {
  if (id) await db.from("research_run").update({ ...patch, finished_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", id);
}
function sourcesOf(web: { queries: string[]; sources: { url: string; title: string }[] } | undefined, used: string[]) {
  const seen = new Map<string, { url: string; title: string; used: boolean }>();
  for (const r of web?.sources ?? []) if (!seen.has(r.url)) seen.set(r.url, { ...r, used: used.includes(r.url) });
  for (const u of used) if (!seen.has(u)) seen.set(u, { url: u, title: "", used: true });
  return [...seen.values()].slice(0, 40);
}

/** Research one company now. Returns how many new findings were stored. */
export async function researchCompany(db: Db, ws: string, orgId: string, opts: { actorUserId?: string; ai?: typeof callStructured } = {}) {
  const ai = opts.ai ?? callStructured;
  const { data: org } = await db.from("organisation").select("id, display_name, domain, sector").eq("workspace_id", ws).eq("id", orgId).maybeSingle();
  if (!org) throw new Error("Company not found.");
  const s = await settings(db, ws);
  const domains = await approvedDomains(db, ws);
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  let out: ResearchOut;
  let mocked = false;
  let web: { queries: string[]; sources: { url: string; title: string }[] } | undefined;
  let usd = 0;
  let rModel = "";
  const runId = await startRun(db, ws, "company", org.display_name, orgId, opts.actorUserId);
  try {
    const r = await ai({
      workspaceId: ws, workflow: "signals.research", tier: "luna", webSearch: true, allowedDomains: domains.length ? domains : undefined,
      classification: "public", schema: ResearchSchema, schemaName: "research_findings",
      system: "You research public business news for a commercial real-estate adviser in India. Report only events stated in sources you found. Every finding must cite its URL. Never guess office area, budget, headcount or dates; use null. If nothing relevant, set insufficient_evidence true with no findings. Never use LinkedIn.",
      input: `Company: ${org.display_name}${org.domain ? ` (website ${org.domain})` : ""}${org.sector ? `, sector ${org.sector}` : ""}.\nFind news since ${since} about: office expansion or new offices, GCC plans, large local hiring, funding, consolidation or closures, layoffs, relocation, mergers/acquisitions, leadership changes in real estate/facilities/admin/finance/HR, return-to-office policy. Focus cities: ${s.focusCities.join(", ")}. Return at most 5 findings.`,
      mock: () => ({ insufficient_evidence: true, findings: [] }),
    });
    out = r.data; mocked = r.mocked; web = r.web; usd = r.usage.usd; rModel = r.model;
  } catch (e) {
    await finishRun(db, ws, runId, { status: e instanceof AiUnavailableError ? "skipped" : "failed", error: String((e as Error).message).slice(0, 300) });
    if (e instanceof AiUnavailableError) return { stored: 0, skipped: e.message, mocked: true, runId };
    throw e;
  }
  let stored = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const raw of out.findings) {
    const f = { ...raw, event_date: isoDate(raw.event_date), published_on: isoDate(raw.published_on) };
    if (!okUrl(f.source_url) || /linkedin\.com/i.test(f.source_url)) continue;
    const { data: dup } = await db.from("signal_claim").select("id").eq("workspace_id", ws).eq("subject_id", orgId).eq("claim_type", f.kind).eq("source_url", f.source_url).limit(1);
    if (dup?.length) continue;
    const { error } = await db.from("signal_claim").insert({
      workspace_id: ws, subject_type: "organisation", subject_id: orgId, claim_type: f.kind, predicate: "web_research",
      value_json: { text: f.summary, location: f.location, source_name: f.source_name, via: "claude_web_search" },
      status: "reported", evidence_tier: f.official_source ? "credible_reported" : "single_unverified",
      evidence_excerpt: f.summary, source_url: f.source_url, source_locator: f.source_name,
      published_on: f.published_on, observed_on: today, effective_on: f.event_date, owner_user_id: opts.actorUserId ?? undefined,
    });
    if (!error) stored++;
  }
  // researched_at is recorded even when nothing new was found.
  const { data: w } = await db.from("watchlist").select("id, tier").eq("workspace_id", ws).eq("org_id", orgId).maybeSingle();
  if (w) await db.from("watchlist").update({ last_researched_at: new Date().toISOString(), next_due_at: new Date(Date.now() + (CADENCE[w.tier] ?? 90) * 86_400_000).toISOString() }).eq("id", w.id);
  if (stored) await scanClaims(db, ws, s, { orgIds: [orgId] });
  await finishRun(db, ws, runId, { status: mocked ? "skipped" : "done", queries: web?.queries ?? [], sources: sourcesOf(web, out.findings.map((f) => f.source_url)), findings: stored, usd, error: mocked ? (aiKind(rModel) ?? "AI not connected") : null });
  return { stored, mocked, insufficient: out.insufficient_evidence, runId, skipped: mocked ? (aiKind(rModel) ?? "AI not connected") : undefined as string | undefined };
}

/** Daily batch: due watchlist companies, limited to weeklyCompanyLimit/7 per day (at least 1). */
export async function researchDue(db: Db, ws: string) {
  const { data: cfg } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", "signals").maybeSingle();
  const weekly = Number((cfg?.value as { weeklyCompanyLimit?: number } | null)?.weeklyCompanyLimit ?? 25);
  const perDay = Math.max(1, Math.ceil(weekly / 7));
  const { data: due } = await db.from("watchlist").select("org_id").eq("workspace_id", ws).eq("active", true).is("archived_at", null)
    .lte("next_due_at", new Date().toISOString()).order("next_due_at").limit(perDay);
  const results = [];
  for (const d of due ?? []) {
    const r = await researchCompany(db, ws, d.org_id);
    results.push(r);
    if (r.skipped) break; // budget reached / AI paused: stop, local work continues tomorrow
  }
  return { researched: results.length, stored: results.reduce((a, r) => a + r.stored, 0) };
}

// ------------------------------------------------------------------ market discovery: find companies we don't know yet

export const DiscoverSchema = z.object({
  findings: z.array(z.object({
    company: z.string().min(2),
    kind: z.string(),
    summary: z.string(),
    location: z.string().nullable(),
    published_on: z.string().nullable(),
    source_url: z.string(),
    source_name: z.string(),
  })),
});

/**
 * Finds ONE new prospect: scans recent news for office / GCC / expansion activity in the focus cities, drops companies
 * already in your records, picks the company with the most evidence (then most local, then most recent), and runs a
 * full client assessment on that company only. Nothing is added to your records until you click "Add as company".
 */
export async function discoverMarket(db: Db, ws: string, opts: { actorUserId?: string; ai?: typeof callStructured; assessAi?: typeof callStructured } = {}) {
  const ai = opts.ai ?? callStructured;
  const s = await settings(db, ws);
  const city = s.focusCities.join(", ");
  const runId = await startRun(db, ws, "discover", `New prospect in ${city}`, null, opts.actorUserId);
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  let r;
  try {
    r = await ai({
      workspaceId: ws, workflow: "signals.discover", tier: "luna", webSearch: true, classification: "public",
      schema: DiscoverSchema, schemaName: "market_findings",
      system: "You scan Indian business news for a commercial real-estate adviser. Report only named companies and events stated in sources you found, each with its URL. Skip landlords, developers, brokers and co-working operators. Never guess area, headcount or dates. Never use LinkedIn.",
      input: `Use kind values only from: ${KINDS.join(", ")}.\nFind news since ${since} naming specific companies (occupiers) that are opening, expanding, leasing, relocating or setting up GCCs/offices in ${city}, or running large hiring drives there. One finding per company per event; up to 10.`,
      mock: () => ({ findings: [] }),
    });
  } catch (e) {
    await finishRun(db, ws, runId, { status: e instanceof AiUnavailableError ? "skipped" : "failed", error: String((e as Error).message).slice(0, 300) });
    return { runId, found: 0, newCompanies: 0, skipped: (e as Error).message, picked: null as string | null, assessRunId: null as string | null };
  }
  if (r.mocked) {
    await finishRun(db, ws, runId, { status: "skipped", error: aiKind(r.model) ?? "AI not connected" });
    return { runId, found: 0, newCompanies: 0, skipped: aiKind(r.model) ?? "AI not connected", picked: null, assessRunId: null };
  }
  // Group findings by company; keep only companies not already in your records.
  const groups = new Map<string, { name: string; items: NonNullable<ReturnType<typeof clean>>[] }>();
  for (const raw of r.data.findings.slice(0, 12)) {
    const c = clean(raw);
    if (!c || /linkedin\.com/i.test(c.source_url)) continue;
    const key = normName(raw.company);
    if (!key) continue;
    const g = groups.get(key) ?? { name: raw.company.slice(0, 120), items: [] };
    g.items.push(c); groups.set(key, g);
  }
  const fresh: { name: string; items: NonNullable<ReturnType<typeof clean>>[] }[] = [];
  for (const g of groups.values()) if (!(await resolveOrg(db, ws, g.name)).orgId) fresh.push(g);
  const focus = s.focusCities.map((x) => x.toLowerCase());
  const rank = (g: (typeof fresh)[number]) => [
    g.items.length,
    g.items.filter((i) => focus.some((c) => `${i.location ?? ""} ${i.summary}`.toLowerCase().includes(c))).length,
    Math.max(0, ...g.items.map((i) => (i.published_on ? Date.parse(i.published_on) : 0))),
  ];
  fresh.sort((a, b) => { const x = rank(a), y = rank(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  const pick = fresh[0];
  const allUsed = [...groups.values()].flatMap((g) => g.items.map((i) => i.source_url));
  if (!pick) {
    await finishRun(db, ws, runId, { status: "done", queries: r.web?.queries ?? [], sources: sourcesOf(r.web, allUsed), findings: 0, new_companies: 0, usd: r.usage.usd,
      error: groups.size ? `All ${groups.size} companies found (${[...groups.values()].map((g) => g.name).slice(0, 5).join(", ")}) are already in your records.`
        : r.data.findings.length ? `${r.data.findings.length} findings came back but none had a usable source link.` : "No named companies found in recent news." });
    return { runId, found: 0, newCompanies: 0, skipped: undefined, picked: null, assessRunId: null };
  }
  await finishRun(db, ws, runId, { status: "done", label: `New prospect in ${city}: ${pick.name}`, queries: r.web?.queries ?? [], sources: sourcesOf(r.web, pick.items.map((i) => i.source_url)),
    findings: pick.items.length, new_companies: fresh.length, usd: r.usage.usd,
    error: null });
  // Deep dive on that one company.
  const { assessCompany } = await import("./assess");
  const deep = await assessCompany(db, ws, { name: pick.name, hints: pick.items.map((i) => `${i.summary} (${i.source_url})`) }, { actorUserId: opts.actorUserId, ai: opts.assessAi ?? opts.ai });
  // One signal for the prospect, carrying every cited source.
  const today = new Date().toISOString().slice(0, 10);
  const top = pick.items[0];
  const cat = categoryOf(top.kind) ?? "expansion";
  const ev = [...pick.items.map((i) => ({ url: i.source_url, name: i.source_name, text: i.summary, date: i.published_on })),
    ...deep.assessment.for.filter((p) => p.source).map((p) => ({ url: p.source!.url, name: p.source!.name, text: p.text, date: p.source!.date }))];
  await upsertSignal(db, ws, {
    category: cat, kind: top.kind, key: dedupeKey(cat, top.kind, `name:${normName(pick.name)}`, top.published_on ?? today),
    title: `${pick.name}: new prospect — score ${deep.assessment.score}/100`, summary: deep.assessment.summary,
    creRelevance: "Found by market scan and assessed. Evidence of activity, not proof of a space need.",
    nameRaw: pick.name, location: top.location, verification: "inference",
    evidence: [...new Map(ev.map((e) => [e.url, e])).values()].map((e) => ({ role: "support" as const, key: `url:${e.url}`, sourceName: e.name, url: e.url, excerpt: e.text, tier: "single_unverified", status: "reported", published: e.date })),
    processing: "entity_unresolved",
  }, s, today, new Map<string, OrgContext>());
  return { runId, found: 1, newCompanies: fresh.length, skipped: undefined, picked: pick.name, assessRunId: deep.runId, score: deep.assessment.score };
}
