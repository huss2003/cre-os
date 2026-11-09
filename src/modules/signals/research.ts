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
function clean<T extends { kind: string; summary: string; location: string | null; published_on: string | null; source_url: string; source_name: string; event_date?: string | null }>(f: T) {
  if (!(KINDS as readonly string[]).includes(f.kind) || !/^https?:\/\//.test(f.source_url)) return null;
  return { ...f, kind: f.kind as (typeof KINDS)[number], summary: f.summary.slice(0, 400), location: f.location?.slice(0, 100) ?? null,
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
 * Scans recent news for office / GCC / expansion / leasing activity in the focus cities. Known companies get a normal
 * signal; unknown companies get an "unmatched" signal you can turn into a company with one click. Nothing is auto-created.
 */
export async function discoverMarket(db: Db, ws: string, opts: { actorUserId?: string; ai?: typeof callStructured } = {}) {
  const ai = opts.ai ?? callStructured;
  const s = await settings(db, ws);
  const city = s.focusCities.join(", ");
  const runId = await startRun(db, ws, "discover", `New activity in ${city}`, null, opts.actorUserId);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  let r;
  try {
    r = await ai({
      workspaceId: ws, workflow: "signals.discover", tier: "luna", webSearch: true, classification: "public",
      schema: DiscoverSchema, schemaName: "market_findings", maxOutputTokens: 1200,
      system: "You scan Indian business news for a commercial real-estate adviser. Report only companies and events stated in sources you found, each with its URL. Never guess area, headcount or dates. Never use LinkedIn.",
      input: `Find news since ${since} about companies opening, expanding, leasing, relocating, consolidating or setting up GCCs/offices in ${city}. Also large hiring drives in ${city}. Return up to 10 distinct companies.`,
      mock: () => ({ findings: [] }),
    });
  } catch (e) {
    await finishRun(db, ws, runId, { status: e instanceof AiUnavailableError ? "skipped" : "failed", error: String((e as Error).message).slice(0, 300) });
    return { runId, found: 0, newCompanies: 0, skipped: (e as Error).message };
  }
  const today = new Date().toISOString().slice(0, 10);
  const cache = new Map<string, OrgContext>();
  let found = 0, unknown = 0;
  for (const raw of r.data.findings) {
    const f = { ...raw, published_on: isoDate(raw.published_on) };
    if (!okUrl(f.source_url) || /linkedin\.com/i.test(f.source_url)) continue;
    const cat = categoryOf(f.kind);
    if (!cat) continue;
    const res = await resolveOrg(db, ws, f.company);
    if (!res.orgId) unknown++;
    const entity = res.orgId ?? `name:${normName(f.company)}`;
    const out = await upsertSignal(db, ws, {
      category: cat, kind: f.kind, key: dedupeKey(cat, f.kind, entity, f.published_on ?? today),
      title: `${f.company}: ${f.kind.replace(/_/g, " ")}${f.location ? ` (${f.location})` : ""}`,
      summary: f.summary, creRelevance: "Found by market scan. Evidence of activity, not proof of a space need.",
      orgId: res.orgId, nameRaw: res.orgId ? null : f.company, location: f.location, verification: "inference",
      evidence: [{ role: "support", key: `url:${f.source_url}`, sourceName: f.source_name, url: f.source_url, excerpt: f.summary, tier: "single_unverified", status: "reported", published: f.published_on }],
      processing: res.orgId ? "review_required" : "entity_unresolved",
    }, s, today, cache);
    if (out.created) found++;
  }
  await finishRun(db, ws, runId, { status: r.mocked ? "skipped" : "done", queries: r.web?.queries ?? [], sources: sourcesOf(r.web, r.data.findings.map((f) => f.source_url)), findings: found, new_companies: unknown, usd: r.usage.usd, error: r.mocked ? (aiKind(r.model) ?? "AI not connected") : null });
  return { runId, found, newCompanies: unknown, skipped: r.mocked ? (aiKind(r.model) ?? "AI not connected") : undefined };
}
