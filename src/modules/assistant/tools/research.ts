/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { callStructured } from "@/lib/ai/gateway";
import { assertIngestionAllowed } from "@/modules/admin/killswitch";
import { missingQuestions, stakeholderGaps, type RequirementRow } from "@/modules/deals/requirements/contract";
import type { SourceRef, ToolContext } from "../types";
import { loadOpportunityBundle } from "./database";
import { HREF, daysBetween, db, defineTool, denied, errMsg, getOne, isUuid, missingBlock, ref, today, ws, type Row } from "./shared";

// ---------------------------------------------------------------------------------------------------- distance
/** Great-circle (haversine) distance in km. Straight-line only — NOT road distance or travel time. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371.0088; const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))) * 100) / 100;
}

const point = z.object({
  type: z.enum(["asset", "meeting", "geography", "point"]).describe("asset = building, meeting = meeting_visit (or meeting prep) id, geography = locality/micro-market, point = raw coordinates"),
  id: z.string().optional().describe("Record id (not needed for type=point)"),
  lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional(),
  label: z.string().max(100).optional(),
});
type Pt = z.infer<typeof point>;

async function resolvePoint(t: ToolContext, p: Pt): Promise<{ label: string; lat: number | null; lon: number | null; ok: boolean }> {
  if (p.type === "point") return { label: p.label ?? `${p.lat},${p.lon}`, lat: p.lat ?? null, lon: p.lon ?? null, ok: true };
  if (!p.id || !isUuid(p.id)) return { label: "?", lat: null, lon: null, ok: false };
  if (p.type === "meeting") {
    let r = await getOne(t, "meeting_visit", p.id, "id, title, lat, lon");
    if (!r) { const prep = await getOne(t, "meeting_prep", p.id, "meeting_visit_id"); if (prep) r = await getOne(t, "meeting_visit", prep.meeting_visit_id, "id, title, lat, lon"); }
    return r ? { label: r.title, lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), ok: true } : { label: "?", lat: null, lon: null, ok: false };
  }
  const r = await getOne(t, p.type === "asset" ? "asset" : "geography", p.id, "id, name, lat, lon");
  return r ? { label: r.name, lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), ok: true } : { label: "?", lat: null, lon: null, ok: false };
}

const calculateDistance = defineTool({
  id: "calculate_distance", module: "geo", category: "A",
  description: "Straight-line (as-the-crow-flies, haversine) distance in km from one place to one or more others, using coordinates stored on buildings, meetings or geographies. NOT road distance or travel time — always say 'straight-line'. Returns unknown when coordinates are missing.",
  input: z.object({ from: point, to: z.array(point).min(1).max(25) }),
  async run(i, t) {
    const a = await resolvePoint(t, i.from);
    if (!a.ok) return denied(t, "calculate_distance", { entity: i.from.type, id: i.from.id });
    const rows: { to: string; km: number | null; note: string | null }[] = [];
    const missing: string[] = [];
    if (a.lat === null || a.lon === null) missing.push(`No coordinates recorded for ${a.label}`);
    for (const p of i.to) {
      const b = await resolvePoint(t, p);
      if (!b.ok) { await denied(t, "calculate_distance", { entity: p.type, id: p.id }); rows.push({ to: "(not found or no access)", km: null, note: "not_found_or_no_access" }); continue; }
      if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) {
        if (b.lat === null || b.lon === null) missing.push(`No coordinates recorded for ${b.label}`);
        rows.push({ to: b.label, km: null, note: "unknown — coordinates missing" }); continue;
      }
      rows.push({ to: b.label, km: haversineKm({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }), note: null });
    }
    rows.sort((x, y) => (x.km ?? Infinity) - (y.km ?? Infinity));
    return {
      ok: true, summary: `Straight-line distances from ${a.label}`, missing: [...new Set(missing)],
      data: { method: "straight-line (haversine), km; not road distance", from: a.label, items: rows },
      coverage: { checked: rows.length, withData: rows.filter((r) => r.km !== null).length },
      blocks: [{ kind: "table", title: `Straight-line distance from ${a.label}`, columns: ["To", "Straight-line km", "Note"], rows: rows.map((r) => [r.to, r.km, r.note]), note: "Straight-line (haversine) from stored coordinates — not road distance or travel time." }, ...missingBlock([...new Set(missing)])],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- web research
const Finding = z.object({
  statement: z.string(), kind: z.enum(["fact", "interpretation"]),
  url: z.string().nullable(), publisher: z.string().nullable(), publishedDate: z.string().nullable(),
});
const ResearchOut = z.object({ summary: z.string(), findings: z.array(Finding), gaps: z.array(z.string()) });

const webResearch = defineTool({
  id: "web_research", module: "research", category: "A", timeoutMs: 90_000, retry: 0,
  description: "Search the public web for recent news/facts about a company, building or market question. Returns findings with URL, publisher, published date, retrieved date and whether each is a reported fact or an interpretation. Never searches LinkedIn. Results are reported (unverified) until confirmed. Use only when internal records don't answer the question.",
  input: z.object({
    question: z.string().min(5).max(500).describe("What to find out, e.g. 'Has Acme announced a Pune expansion in 2026?'"),
    companyName: z.string().max(200).optional(),
    maxSearches: z.number().int().min(1).max(5).optional(),
  }),
  async run(i, t) {
    try { await assertIngestionAllowed(db(t), ws(t)); } catch (e) { return { ok: false, error: "ingestion_paused", summary: `Web research is paused for this workspace (${errMsg(e)})` }; }
    const retrievedAt = new Date().toISOString();
    try {
      const r = await callStructured({
        workspaceId: ws(t), workflow: "assistant.web_research", tier: "sol", webSearch: true, maxSearches: i.maxSearches ?? 3, classification: "public",
        system: "You are a commercial real estate research assistant in India. Search the web and report only what sources say. For each finding give the source URL, publisher and published date (YYYY-MM-DD or null). Label kind='fact' only for what a source directly reports; your own reading is kind='interpretation'. Never use LinkedIn. If nothing relevant is found, return no findings and say so in gaps.",
        input: `Question: ${i.question}${i.companyName ? `\nCompany: ${i.companyName}` : ""}\nToday: ${today()}`,
        schema: ResearchOut, schemaName: "web_research", maxOutputTokens: 1500,
        mock: () => ({ summary: "Web research is unavailable in mock mode (no AI key configured). No external sources were checked.", findings: [], gaps: ["Web search not run (mock mode)"] }),
      });
      const findings = r.data.findings.filter((f) => !/linkedin\.com/i.test(f.url ?? ""));
      const sources: SourceRef[] = findings.map((f) => ({ label: f.publisher ?? (f.url ? new URL(f.url).hostname : "web"), href: f.url ?? undefined, observedAt: f.publishedDate, retrievedAt, status: f.kind === "fact" ? "reported" : "inferred" }));
      const missing = [...r.data.gaps, ...findings.filter((f) => !f.publishedDate).map((f) => `No published date for: ${f.statement.slice(0, 80)}`)];
      return {
        ok: true, summary: r.mocked ? "Mock mode: no web search run" : `${findings.length} finding(s) from the web`, sources, missing,
        data: { mocked: r.mocked, retrievedAt, summary: r.data.summary, findings: findings.map((f) => ({ ...f, retrievedAt })), searched: r.web?.queries ?? [], untrusted: true },
        blocks: [
          ...(findings.length ? [{ kind: "table" as const, title: "Web findings (reported, unverified)", columns: ["Finding", "Fact/interpretation", "Publisher", "Published", "Retrieved"], rows: findings.map((f) => [f.statement, f.kind, f.publisher, f.publishedDate, retrievedAt.slice(0, 10)]) }] : [{ kind: "text" as const, markdown: r.data.summary }]),
          ...(sources.length ? [{ kind: "sources" as const, items: sources }] : []), ...missingBlock(missing),
        ],
      };
    } catch (e) {
      return { ok: false, error: "web_research_failed", summary: `Web research failed: ${errMsg(e)}`, missing: ["Web research could not be completed"] };
    }
  },
});

// ---------------------------------------------------------------------------------------------------- deal stuck
const explainDealStuck = defineTool({
  id: "explain_deal_stuck", module: "database", category: "A",
  description: "Gather the evidence needed to explain why a deal is stalled: days in current stage vs earlier stages, days since last interaction, overdue next action/tasks, unresolved objections, blocking closing items, stakeholder gaps, unanswered requirement questions, expired quotes. Returns evidence only — you reason about it and cite it.",
  input: z.object({ opportunityId: z.string() }),
  async run(i, t) {
    const b = isUuid(i.opportunityId) ? await loadOpportunityBundle(t, i.opportunityId) : null;
    if (!b) return denied(t, "explain_deal_stuck", { entity: "opportunity", id: i.opportunityId });
    const { d, o } = b; const now = today();
    const hist = [...(d.history as Row[])].sort((x, y) => String(x.changed_at).localeCompare(String(y.changed_at)));
    const stageDurations = hist.slice(1).map((h, n) => ({ stage: hist[n].to_stage, days: daysBetween(String(hist[n].changed_at).slice(0, 10), String(h.changed_at).slice(0, 10)) }));
    const daysInStage = o.stage_entered_at ? daysBetween(String(o.stage_entered_at).slice(0, 10), now) : null;
    const lastTouch = b.interactions[0]?.occurred_at ? String(b.interactions[0].occurred_at).slice(0, 10) : null;
    const req = o.requirement_id ? await getOne(t, "requirement", o.requirement_id) : null;
    const evidence: { signal: string; detail: string; source: string }[] = [];
    if (daysInStage !== null) evidence.push({ signal: "time_in_stage", detail: `${daysInStage} days in ${o.stage}${stageDurations.length ? `; earlier stages took ${stageDurations.map((s) => `${s.stage} ${s.days}d`).join(", ")}` : ""}`, source: "stage history" });
    evidence.push({ signal: "last_interaction", detail: lastTouch ? `Last logged interaction ${lastTouch} (${daysBetween(lastTouch, now)} days ago)` : "No interaction logged against this deal", source: "interactions" });
    if (o.next_action_due && o.next_action_due < now) evidence.push({ signal: "next_action_overdue", detail: `Next action "${o.next_action}" was due ${o.next_action_due}`, source: "opportunity" });
    if (!o.next_action) evidence.push({ signal: "no_next_action", detail: "No next action recorded", source: "opportunity" });
    for (const tk of b.tasks.filter((x) => x.due_at && String(x.due_at).slice(0, 10) < now)) evidence.push({ signal: "overdue_task", detail: `${tk.title} (due ${String(tk.due_at).slice(0, 10)})`, source: "tasks" });
    for (const x of (d.objections as Row[]).filter((x) => !x.outcome)) evidence.push({ signal: "objection_open", detail: `${x.category}: ${x.objection}${x.raised_on ? ` (raised ${x.raised_on})` : ""}`, source: "objection log" });
    for (const m of (d.milestones as Row[]).filter((m) => m.required_for_stage && !["done", "waived", "not_applicable"].includes(m.status))) evidence.push({ signal: "closing_blocker", detail: `${m.title} — ${m.status}${m.due_date ? `, due ${m.due_date}` : ""}`, source: "closing checklist" });
    for (const g of stakeholderGaps(b.stakeholders.map((s) => s.role))) evidence.push({ signal: "stakeholder_gap", detail: g, source: "stakeholder map" });
    if (req) for (const q of missingQuestions(req as RequirementRow).filter((q) => q.priority === "mandatory").slice(0, 6)) evidence.push({ signal: "requirement_gap", detail: `${q.label}: ${q.reason === "missing" ? "unknown" : "not confirmed by client"}`, source: "requirement" });
    else evidence.push({ signal: "no_requirement", detail: "No requirement linked to this deal", source: "opportunity" });
    for (const q of b.quotes.filter((q) => q.valid_until && q.valid_until < now)) evidence.push({ signal: "quote_expired", detail: `Quote v${q.version} expired ${q.valid_until}`, source: "quotes" });
    for (const x of (b.interactions.flatMap((it) => ((it.promises ?? []) as Row[]).filter((p) => p && p.status !== "done" && p.due && p.due < now).map((p) => ({ p, it }))))) evidence.push({ signal: "promise_overdue", detail: `${x.p.who === "them" ? "Client" : "We"} promised "${x.p.what}" by ${x.p.due}`, source: `interaction ${String(x.it.occurred_at).slice(0, 10)}` });
    const entity = ref("opportunity", o.id, o.name, HREF.opportunity(o.id));
    return {
      ok: true, summary: `${evidence.length} evidence item(s) for ${o.name}`, entities: [entity],
      data: { opportunity: { id: o.id, name: o.name, stage: o.stage, temperature: o.temperature, risks: o.risks }, daysInStage, stageDurations, evidence, note: "Evidence only; explain the likely causes from these items and cite them." },
      blocks: [{ kind: "table", title: `Evidence: is ${o.name} stuck?`, columns: ["Signal", "Detail", "Source"], rows: evidence.map((e) => [e.signal, e.detail, e.source]) }],
      sources: [{ label: "Opportunity, history, tasks, interactions", href: HREF.opportunity(o.id), retrievedAt: new Date().toISOString(), status: "verified" }],
    };
  },
});

export const researchTools = [calculateDistance, webResearch, explainDealStuck];
