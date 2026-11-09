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
import { scanClaims, settings } from "./service";

const KINDS = ["expansion", "gcc_plan", "hiring", "funding", "consolidation", "layoff", "relocation", "merger", "acquisition", "leadership_change", "rto", "infrastructure", "macro"] as const;
export const ResearchSchema = z.object({
  insufficient_evidence: z.boolean(),
  findings: z.array(z.object({
    kind: z.enum(KINDS),
    summary: z.string().max(400),
    location: z.string().max(100).nullable(),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    published_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    source_url: z.string().url(),
    source_name: z.string().max(120),
    official_source: z.boolean(),
  })).max(5),
});
export type ResearchOut = z.infer<typeof ResearchSchema>;

const CADENCE: Record<string, number> = { critical: 7, active: 30, universe: 90 };

export async function approvedDomains(db: Db, ws: string): Promise<string[]> {
  const { data } = await db.from("research_source_registry").select("base_url, paused, acquisition_method").eq("workspace_id", ws).is("archived_at", null);
  return [...new Set((data ?? []).filter((r) => !r.paused && r.base_url && r.acquisition_method === "gateway_web_search")
    .map((r) => { try { return new URL(String(r.base_url)).hostname.replace(/^www\./, ""); } catch { return null; } }).filter(Boolean) as string[])];
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
  try {
    const r = await ai({
      workspaceId: ws, workflow: "signals.research", tier: "luna", webSearch: true, allowedDomains: domains.length ? domains : undefined,
      classification: "public", schema: ResearchSchema, schemaName: "research_findings",
      system: "You research public business news for a commercial real-estate adviser in India. Report only events stated in sources you found. Every finding must cite its URL. Never guess office area, budget, headcount or dates; use null. If nothing relevant, set insufficient_evidence true with no findings. Never use LinkedIn.",
      input: `Company: ${org.display_name}${org.domain ? ` (website ${org.domain})` : ""}${org.sector ? `, sector ${org.sector}` : ""}.\nFind news since ${since} about: office expansion or new offices, GCC plans, large local hiring, funding, consolidation or closures, layoffs, relocation, mergers/acquisitions, leadership changes in real estate/facilities/admin/finance/HR, return-to-office policy. Focus cities: ${s.focusCities.join(", ")}. Return at most 5 findings.`,
      mock: () => ({ insufficient_evidence: true, findings: [] }),
    });
    out = r.data; mocked = r.mocked;
  } catch (e) {
    if (e instanceof AiUnavailableError) return { stored: 0, skipped: e.message, mocked: true };
    throw e;
  }
  let stored = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const f of out.findings) {
    if (/linkedin\.com/i.test(f.source_url)) continue;
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
  return { stored, mocked, insufficient: out.insufficient_evidence };
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
