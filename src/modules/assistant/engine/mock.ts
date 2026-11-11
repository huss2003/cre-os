/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are rendered generically */
import type { ZodType } from "zod";
import type { ContextPackage, EntityRef, EntityType } from "../types";
import { TOOLS } from "../tools";
import type { Intent } from "./router";
import type { ChatRequest, ChatResponse, ContentBlock, ModelProvider } from "./provider";

/**
 * Deterministic planner used when ANTHROPIC_API_KEY is empty. Implements ModelProvider so the real tool loop,
 * validation, permissions, approvals and logging all run exactly as with a live model:
 *   turn 1 → tool_use blocks chosen from the intent + resolved entities;
 *   turn 2 → optional follow-up tools that need ids from turn-1 results;
 *   last  → a text answer composed only from tool results (no arithmetic, no invention).
 */

type Slots = {
  outreach?: EntityRef; infra?: { name: string; lat: number; lon: number };
  company?: EntityRef; person?: EntityRef; assets: EntityRef[]; requirement?: EntityRef; opportunity?: EntityRef; meeting?: EntityRef;
  request: string; primary?: EntityRef; records?: Record<string, unknown>[];
};

/** Per intent: ordered tool "needs" (preferred ids, then a regex over ids). Each need contributes at most one call. */
type Need = { ids: string[]; re?: RegExp; needs?: (keyof Slots)[]; unless?: (keyof Slots)[]; input?: (s: Slots) => Record<string, unknown> | null; when?: RegExp };
const companyScore = (s: Slots) => (s.company ? { entityType: "company", entityId: s.company.id } : null);
/** Everything a full account picture needs once the company is known (M2 signals, M3 score, M4 people, M5 outreach, M7 meetings). */
const ACCOUNT_PICTURE: Need[] = [
  { ids: ["get_research_signals"], needs: ["company"] },
  { ids: ["get_scores"], needs: ["company"], input: companyScore },
  { ids: ["find_decision_makers"], needs: ["company"] },
  { ids: ["get_outreach_history"], needs: ["company"], input: (s) => (s.company ? { companyId: s.company.id } : null) },
];
/** Profile of whichever record the request is about, company first. */
const PROFILE: Need[] = [
  { ids: ["get_company_profile"], needs: ["company"] },
  { ids: ["get_contact_profile"], needs: ["person"], unless: ["company"] },
  { ids: ["get_requirement_details"], needs: ["requirement"], unless: ["company", "person"] },
  { ids: ["get_opportunity_details"], needs: ["opportunity"], unless: ["company", "person", "requirement"] },
  { ids: ["get_property_details"], needs: ["assets"], unless: ["company", "person", "requirement", "opportunity"] },
  { ids: ["search_companies"], unless: ["company", "person", "requirement", "opportunity", "assets"] },
];
const PLANS: Record<Intent, Need[]> = {
  company_summary: [
    ...PROFILE.slice(0, 1), ...ACCOUNT_PICTURE,
    // meeting history carries the commitments from each meeting; kept within 6 steps (evals: company-everything)
    { ids: ["get_meeting_history"], needs: ["company"], input: (s) => (s.company ? { companyId: s.company.id } : null) },
    ...PROFILE.slice(1),
  ],
  meeting_prep: [
    { ids: ["get_person_context"], needs: ["person"], when: /\bknow before\b/i },
    { ids: ["get_company_context"], needs: ["company"], unless: ["person"], when: /\bknow before\b/i },
    { ids: ["generate_meeting_brief"], needs: ["meeting"] },
    { ids: ["get_upcoming_meetings"], unless: ["meeting"] },
    { ids: ["get_company_profile"], needs: ["company"] },
    { ids: ["get_commitments"], needs: ["company"] },
  ],
  compare_properties: [
    { ids: ["compare_properties"], needs: ["assets"] },
    { ids: ["get_requirement_details"], needs: ["requirement"], unless: ["assets"] },
    { ids: ["search_properties"], unless: ["assets", "requirement"] },
  ],
  leases_expiring: [{ ids: ["find_leases_expiring"] }],
  rejected_options: [
    { ids: ["get_requirement_history"], needs: ["requirement"] },
    { ids: ["get_requirement_history"], needs: ["company"], unless: ["requirement"], input: (s) => (s.company ? { companyId: s.company.id } : null) },
    { ids: ["get_requirement_details"], needs: ["requirement"] },
    { ids: ["search_requirements"], needs: ["company"], unless: ["requirement"] },
    { ids: ["get_meeting_history"], needs: ["company"] },
    { ids: ["recall_memories"], needs: ["primary"] },
  ],
  deal_review: [
    { ids: ["generate_deal_review"], needs: ["opportunity"] },
    { ids: ["search_opportunities"], needs: ["company"], unless: ["opportunity"] },
    ...ACCOUNT_PICTURE,
    { ids: ["get_meeting_history"], needs: ["company"], when: /\b(last|previous|recent) (interaction|meeting|conversation|call)\b|\bmeetings?\b/i, input: (s) => (s.company ? { companyId: s.company.id } : null) },
  ],
  priority_accounts: [
    { ids: ["get_scores"], needs: ["company"], input: companyScore },
    { ids: ["get_research_signals"], needs: ["company"] },
    { ids: ["rank_priority_accounts"], unless: ["company"] },
  ],
  commitments: [{ ids: ["get_commitments"] }],
  send_proposal: [{ ids: ["prepare_send"], needs: ["outreach"] }],
  memory_correction: [{ ids: ["correct_memory"], needs: ["primary"] }],
  research: [{ ids: ["web_research"] }, { ids: ["search_properties"] }],
  general: PROFILE,
  research_why: [
    { ids: ["get_research_signals"], needs: ["company"] },
    { ids: ["get_scores"], needs: ["company"], input: companyScore },
  ],
  decision_makers: [{ ids: ["get_company_context"], needs: ["company"], when: /\b(actual|real|final|current|new)\b.*\bdecision.?maker|\bwho (is|are) the decision.?makers?\b/i }, { ids: ["find_decision_makers"], needs: ["company"] }],
  requirement_change: [
    { ids: ["get_requirement_history"], needs: ["requirement"] },
    { ids: ["get_requirement_history"], needs: ["company"], unless: ["requirement"], input: (s) => (s.company ? { companyId: s.company.id } : null) },
  ],
  similar_requirements: [
    { ids: ["find_similar_requirements"], needs: ["requirement"] },
    { ids: ["find_similar_requirements"], needs: ["company"], unless: ["requirement"], input: (s) => (s.company ? { companyId: s.company.id } : null) },
  ],
  what_changed: [
    { ids: ["what_changed"], needs: ["primary"], input: (s) => (s.primary && ({ company: "company", person: "person", requirement: "requirement", asset: "asset", opportunity: "opportunity" } as Record<string, string>)[s.primary.type] ? { entityType: ({ company: "company", person: "person", requirement: "requirement", asset: "asset", opportunity: "opportunity" } as Record<string, string>)[s.primary.type], entityId: s.primary.id } : null) },
    { ids: ["get_recommendations"], input: (s) => (s.company ? { companyId: s.company.id } : s.person ? { personId: s.person.id } : s.requirement ? { requirementId: s.requirement.id } : {}) },
  ],
  history: [
    { ids: ["get_company_context"], needs: ["company"], unless: ["person"], when: /\b(last|latest|recent)\b.*\bdiscuss\w*|\bdiscuss\w*\b.*\blast\b/i },
    { ids: ["get_person_context"], needs: ["person"], when: /\bspoken to\b|\b(last|latest)\b.*\bdiscuss/i },
    { ids: ["get_meeting_history"], needs: ["person"], input: (s) => (s.person ? { personId: s.person.id } : null) },
    { ids: ["get_meeting_history"], needs: ["company"], unless: ["person"], input: (s) => (s.company ? { companyId: s.company.id } : null) },
  ],
  outreach_draft: [
    { ids: ["get_meeting_history"], needs: ["person"], input: (s) => (s.person ? { personId: s.person.id } : null) },
    { ids: ["generate_outreach_draft"], needs: ["person"], input: draftInput },
  ],
  automation: [
    { ids: ["start_workflow"], when: /\b(prepare|prep)\b.*\bmeetings?\b|\bcommitments?\b/i, input: (s) => ({ request: s.request }) },
    { ids: ["list_pending_approvals"], when: /\bapprov/i, input: () => ({}) },
    { ids: ["list_workflow_runs"], when: /\b(running|background|jobs?|tasks?|workflows?|automation|failed)\b/i, unless: [], input: (s) => (/\b(prepare|prep)\b.*\bmeetings?\b/i.test(s.request) ? null : { status: /failed/i.test(s.request) ? "failed" : "active" }) },
  ],
  requirement_correction: [{ ids: ["update_requirement_record"], needs: ["requirement"], input: (s) => correctionInput(s) }],
};

function draftInput(s: Slots) {
  if (!s.person) return null;
  const followup = /\b(follow[- ]?up|last meeting|after (the|our) meeting)\b/i.test(s.request);
  return { personId: s.person.id, channels: [/\bwhats\s?app\b/i.test(s.request) ? "whatsapp" : /\blinkedin\b/i.test(s.request) ? "linkedin" : "email"], ...(followup ? { scenario: "meeting_followup" } : {}), ...(s.opportunity ? { opportunityId: s.opportunity.id } : {}) };
}

const num = (x: string) => Number(x.replace(/,/g, ""));
/** "now 30,000 SF, not 25,000 SF" → requirement field change with the Deals contract key (area/seats = [min, target, max]). */
export function parseCorrection(request: string): { key: "area" | "seats"; target: number; was: number | null } | null {
  const m = request.match(/\bnow\s+(?:₹\s*)?(\d[\d,.]*)\s*(k\b)?\s*([a-z. ]{0,12})/i) ?? request.match(/(\d[\d,.]*)\s*(k\b)?\s*([a-z. ]{0,12})\s+instead of/i);
  if (!m) return null;
  const target = num(m[1]) * (m[2] ? 1000 : 1);
  if (!Number.isFinite(target) || target <= 0) return null;
  const unit = `${m[3] ?? ""} ${request}`.toLowerCase();
  const key = /\b(seats?|desks?|workstations?|people|headcount)\b/.test(m[3] ?? "") || (!/\b(sf|sft|sq|square|area)\b/.test(unit) && /\b(seats?|desks?)\b/.test(unit)) ? "seats" : "area";
  const w = request.match(/\b(?:not|instead of)\s+(?:₹\s*)?(\d[\d,.]*)\s*(k\b)?/i);
  return { key, target, was: w ? num(w[1]) * (w[2] ? 1000 : 1) : null };
}
function correctionInput(s: Slots) {
  const c = parseCorrection(s.request);
  if (!c || !s.requirement) return null;
  const rec = (s.records ?? []).find((r) => r.type === "requirement" && r.id === s.requirement!.id) ?? {};
  const [lo0, hi0] = c.key === "area" ? [rec.area_min_sf, rec.area_max_sf] : [rec.seats_min, rec.seats_max];
  // Keep the recorded bounds; only widen a bound the new target falls outside of (no arithmetic on the values).
  const lo = lo0 == null ? null : Math.min(Number(lo0), c.target);
  const hi = hi0 == null ? null : Math.max(Number(hi0), c.target);
  return {
    requirementId: s.requirement.id,
    changes: [{ key: c.key, value: [lo, c.target, hi], status: "client_confirmed" }],
    reason: `Client correction in assistant chat: "${s.request.slice(0, 200)}"`,
  };
}

/** Clauses of a multi-part request that map to an extra action (12.12). */
const CLAUSES: { label: string; re: RegExp; tool: string; build: (s: Slots) => Record<string, unknown> | null; why: string }[] = [
  { label: "Follow-up draft", re: /\b(prepare|draft|write)\b[^,.;]*\bfollow[- ]?up\b|\bdraft (an? )?(email|message|note)\b/i, tool: "generate_outreach_draft", build: draftInput, why: "no contact was identified — name the person" },
  { label: "Internal reminder", re: /\b(create|set|add|make)\b[^,.;]*\b(remind(er)?|task)\b|\bremind me\b/i, tool: "create_internal_task", build: reminderInput, why: "the reminder text could not be worked out" },
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** Next date for a weekday name / tomorrow (calendar lookup, no money/area arithmetic). */
export function dueFrom(text: string, now = new Date()): string | undefined {
  const t = text.toLowerCase();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (/\btomorrow\b/.test(t)) { d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wd < 0) return undefined;
  d.setUTCDate(d.getUTCDate() + (((wd - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}
function reminderInput(s: Slots) {
  const clause = s.request.split(/,|\band\b/i).find((c) => /\bremind/i.test(c)) ?? s.request;
  const who = s.person?.label ? ` ${s.person.label}` : "";
  const title = /follow[- ]?up/i.test(s.request) ? `Follow up${who}` : clause.replace(/\b(create|an?|internal|reminder|for)\b/gi, " ").replace(/\s+/g, " ").trim() || "Reminder";
  const target = s.primary && ["company", "person", "opportunity", "requirement", "asset"].includes(s.primary.type) ? s.primary : (s.opportunity ?? s.person ?? s.company);
  return { title: title.length >= 3 ? title.slice(0, 120) : "Reminder", ...(dueFrom(clause) ? { due: dueFrom(clause) } : {}), ...(target ? { entityType: target.type, entityId: target.id } : {}) };
}

function findTool(ids: string[], re?: RegExp) {
  for (const id of ids) { const t = TOOLS.find((x) => x.id === id); if (t) return t; }
  return re ? TOOLS.find((x) => re.test(x.id)) : undefined;
}

// ---- zod introspection (v4) -------------------------------------------------------------------
type Def = { type?: string; innerType?: ZodType; shape?: Record<string, ZodType>; element?: ZodType; entries?: Record<string, string> };
const defOf = (s: ZodType): Def => ((s as unknown as { _zod?: { def?: Def } })._zod?.def ?? {}) as Def;
function unwrap(s: ZodType): { base: ZodType; optional: boolean } {
  let cur = s, optional = false;
  for (let i = 0; i < 6; i++) {
    const d = defOf(cur);
    if ((d.type === "optional" || d.type === "nullable" || d.type === "default" || d.type === "prefault" || d.type === "nullish") && d.innerType) {
      if (d.type !== "nullable") optional = true;
      cur = d.innerType;
    } else break;
  }
  return { base: cur, optional };
}
function shapeOf(s: ZodType): Record<string, ZodType> | null {
  const d = defOf(unwrap(s).base);
  const sh = d.shape ?? (unwrap(s).base as unknown as { shape?: Record<string, ZodType> }).shape;
  return sh && typeof sh === "object" ? sh : null;
}

const NUMWORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, eighteen: 18, twenty: 20, "twenty-four": 24 };
function monthsIn(text: string): number | null {
  const m = text.match(/(\d+|one|two|three|six|twelve|eighteen|twenty-four)\s+months?/i);
  if (m) return Number(m[1]) || NUMWORDS[m[1].toLowerCase()] || null;
  if (/next year|12 months/i.test(text)) return 12;
  return null;
}
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, "twenty-five": 25, thirty: 30, fifty: 50 };
const COUNT_NOUNS = "accounts?|compan(?:y|ies)|clients?|customers?|deals?|leases?|buildings?|propert(?:y|ies)|options?|people|persons?|contacts?|meetings?|items?|tasks?|records?|results?|opportunit(?:y|ies)|requirements?|names?|prospects?|leads?|targets?|tenants?|landlords?|spaces?|ideas?|actions?|priorities";
const COUNT_TOKEN = `(\\d{1,3}|${Object.keys(COUNT_WORDS).join("|")})`;
/**
 * How many items the user asked for ("five accounts", "top 3", "10 deals"), or null. Durations ("12 months") and
 * areas are ignored: only "top N"/"first N" or N followed by a list noun counts. Shared by the mock planner and the
 * real-model context hint.
 */
export function requestedCount(text: string): number | null {
  const m = text.match(new RegExp(`\\b(?:top|first|best|biggest|largest)\\s+${COUNT_TOKEN}\\b`, "i"))
    ?? text.match(new RegExp(`\\b${COUNT_TOKEN}\\s+(?:(?:most|top|key|main|best|priority|important|hot|warm|active|open|big(?:gest)?|new)\\s+){0,2}(?:${COUNT_NOUNS})\\b`, "i"));
  if (!m) return null;
  const n = Number(m[1]) || COUNT_WORDS[m[1].toLowerCase()];
  return n && n > 0 && n <= 100 ? n : null;
}

const ENTITY_TYPE_ALIASES: Record<EntityType, string[]> = {
  company: ["company", "organisation", "org"], person: ["person", "contact"], asset: ["asset", "property", "building"], space: ["space"],
  requirement: ["requirement"], opportunity: ["opportunity", "deal"], lease: ["lease"], meeting: ["meeting"], outreach: ["outreach"],
  analysis: ["analysis"], document: ["document"], task: ["task"], signal: ["signal"],
};

/** Fill a tool's input object from resolved entities and the request, by key name. */
export function fillInput(schema: ZodType, s: Slots): Record<string, unknown> {
  const shape = shapeOf(schema);
  if (!shape) return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const k = key.toLowerCase().replace(/_/g, "");
    const { base } = unwrap(field);
    const d = defOf(base);
    const isArray = d.type === "array";
    let v: unknown;
    if (/^(org|company|organisation|client|tenant)(org)?ids?$/.test(k)) v = s.company?.id;
    else if (/^(person|contact)ids?$/.test(k)) v = s.person?.id;
    else if (/^(asset|property|building|option)ids?$/.test(k)) v = isArray ? (s.assets.length ? s.assets.map((a) => a.id) : undefined) : s.assets[0]?.id;
    else if (/^requirementids?$/.test(k)) v = s.requirement?.id;
    else if (/^(opportunity|deal)ids?$/.test(k)) v = s.opportunity?.id;
    else if (k === "prepid") v = s.meeting?.href?.startsWith("/meetings/") ? s.meeting.id : undefined;
    else if (/^(meeting|meetingvisit)ids?$/.test(k)) v = s.meeting && !s.meeting.href?.startsWith("/meetings/") ? s.meeting.id : undefined;
    else if (k === "outreachid") v = s.outreach && s.outreach.href !== "/drafts" ? s.outreach.id : undefined;
    else if (k === "draftid") v = s.outreach?.href === "/drafts" ? s.outreach.id : undefined;
    else if (k === "entities" && isArray) v = [...(s.primary ? [s.primary] : []), ...[s.person, s.company, s.requirement].filter(Boolean) as EntityRef[]]
      .filter((r, i, arr) => ["person", "company", "requirement"].includes(r.type) && arr.findIndex((x) => x.id === r.id) === i).slice(0, 5).map((r) => ({ type: r.type, id: r.id }));
    else if (k === "status" && d.entries && Object.values(d.entries).includes("any")) v = "any";
    else if (k === "entitytype" && s.primary) {
      const opts = d.entries ? Object.values(d.entries) : null;
      v = opts ? ENTITY_TYPE_ALIASES[s.primary.type].find((a) => opts.includes(a)) ?? opts.find((o) => o === s.primary!.type) : s.primary.type;
    } else if (k === "entityid") v = s.primary?.id;
    else if (/^(windowmonths|months|withinmonths|horizonmonths)$/.test(k)) v = monthsIn(s.request) ?? undefined;
    else if (k === "limit") v = requestedCount(s.request) ?? undefined;
    else if (k === "place" || k === "city") v = placeIn(s.request);
    else if (/^(newcontent|correction|content)$/.test(k)) v = correctionText(s.request);
    else if (k === "hint") v = s.request;
    else if (k === "question") v = s.request.length >= 5 ? s.request : undefined;
    else if (/^(query|q|question|topic|request|text|instruction)$/.test(k)) v = s.request;
    else if (/^(name|companyname)$/.test(k) && s.company) v = s.company.label;
    if (v !== undefined && v !== null) out[key] = isArray && !Array.isArray(v) ? [v] : v;
  }
  // Free-text filters only when no record id narrows the call (a sentence is not a useful title filter).
  if (Object.keys(out).some((k) => /id$/i.test(k) && k.length > 2)) for (const k of ["query", "q", "text"]) delete out[k];
  return out;
}

const NOT_PLACE = new Set(["show", "list", "find", "all", "which", "what", "give", "the", "our", "my", "me", "any", "who", "how", "tell"]);
/** A place named in the request: "in Pune", "around Hinjewadi", "all Pune companies". */
export function placeIn(text: string): string | undefined {
  const m = text.match(/\b(?:in|at|around|near|within)\s+([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)/) ?? text.match(/\b([A-Z][a-z][\w-]+)\s+(?:companies|offices|leases|tenants|accounts|clients|occupiers)\b/);
  const p = m?.[1]?.trim();
  return p && !NOT_PLACE.has(p.toLowerCase()) ? p : undefined;
}

function correctionText(req: string) {
  const m = req.match(/\b(?:now|actually)\s+(.+)$/i);
  return (m ? m[1] : req).replace(/^\s*(he|she|they)\s+/i, (x) => x).trim().replace(/\.$/, "") || req;
}

function infraOf(p: ContextPackage) {
  const r = p.records.find((x) => x.type === "infrastructure" && x.lat != null && x.lon != null);
  return r ? { name: String(r.name ?? "Infrastructure"), lat: Number(r.lat), lon: Number(r.lon) } : undefined;
}

const UPCOMING = /\b(next|upcoming|tomorrow|today|coming|later)\b/i;
function slotsFrom(p: ContextPackage): Slots {
  const first = (t: EntityType) => (p.focus?.type === t ? p.focus : p.resolved.find((r) => r.type === t));
  // "next meeting": only a resolved meeting that has not started yet; otherwise fall back to get_upcoming_meetings.
  let meeting = first("meeting");
  if (meeting && meeting !== p.focus && UPCOMING.test(p.request)) {
    const now = Date.now();
    const future = p.resolved.filter((r) => r.type === "meeting").map((r) => ({ r, at: Date.parse(String(p.records.find((x) => x.type === "meeting" && x.id === r.id)?.start_at ?? "")) }))
      .filter((x) => Number.isFinite(x.at) && x.at >= now).sort((a, b) => a.at - b.at);
    meeting = future[0]?.r;
  }
  const assets = p.resolved.filter((r) => r.type === "asset").slice(0, 5);
  return {
    company: first("company"), person: first("person"), assets: p.focus?.type === "asset" ? [p.focus, ...assets.filter((a) => a.id !== p.focus!.id)].slice(0, 5) : assets,
    requirement: first("requirement"), opportunity: first("opportunity"), meeting, request: p.request,
    outreach: first("outreach"), infra: infraOf(p), records: p.records,
    primary: p.focus ?? p.resolved[0],
  };
}

type ToolUse = { type: "tool_use"; id: string; name: string; input: unknown };
type Result = { ok?: boolean; summary?: string; missing?: string[]; coverage?: { checked: number; withData: number; note?: string }; error?: string; data?: unknown };

const HEADINGS: Record<Intent, string> = {
  company_summary: "Company overview", meeting_prep: "Meeting preparation", compare_properties: "Property comparison",
  leases_expiring: "Leases expiring", rejected_options: "Previously rejected options", deal_review: "Deal review pack",
  priority_accounts: "Priority accounts", commitments: "Open commitments", send_proposal: "Send proposal",
  memory_correction: "Memory updated", research: "Research", general: "Answer",
  research_why: "Why this account is an opportunity", decision_makers: "People to speak to", history: "What was said",
  outreach_draft: "Follow-up draft", requirement_correction: "Requirement correction", automation: "Background work",
  requirement_change: "Requirement history", similar_requirements: "Similar requirements", what_changed: "What changed",
};

export const MOCK_CHUNK = 24;

export class MockProvider implements ModelProvider {
  name = "mock";
  private turn = 0;
  private uses = 0;
  constructor(private pkg: ContextPackage, private intent: Intent) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.turn++;
    const usage = { input: 0, output: 0, searches: 0, usd: 0 };
    const results = this.collectResults(req);
    const calls = this.turn === 1 ? this.plan() : this.turn === 2 ? this.followUp(results) : [];
    if (calls.length) return { content: calls, stop_reason: "tool_use", usage, model: "mock" };
    return { content: [{ type: "text", text: this.compose(results) }], stop_reason: "end_turn", usage, model: "mock" };
  }

  /** Streams the final text in small chunks so the live-text path (engine → SSE → UI) is exercised without a key. */
  async chatStream(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse> {
    const r = await this.chat(req);
    for (const b of r.content) {
      if (b.type !== "text") continue;
      const t = (b as { text: string }).text;
      for (let i = 0; i < t.length; i += MOCK_CHUNK) { onText(t.slice(i, i + MOCK_CHUNK)); await new Promise((res) => setImmediate(res)); }
    }
    return r;
  }

  private call(name: string, input: unknown): ToolUse { return { type: "tool_use", id: `mock_${++this.uses}`, name, input }; }

  private plan(): ContentBlock[] {
    const s = slotsFrom(this.pkg);
    const calls: ToolUse[] = [];
    // Attached lease/LOI + "extract/terms" → read the document's terms (the real model chooses this itself).
    const att = this.pkg.attachments[0];
    if (att && /\b(extract|terms?|lease|loi|term sheet|offer letter|clauses?)\b/i.test(this.pkg.request) && findTool(["extract_lease_terms"])) {
      return [this.call("extract_lease_terms", { attachmentId: att.id })];
    }
    // A name matched several records equally well: ask (compose) instead of acting on the first one.
    if (this.ambiguity().length) return [];
    const empty = (n: keyof Slots) => { const v = s[n]; return Array.isArray(v) ? !v.length : !v; };
    let needs = PLANS[this.intent];
    // Page focus on a contact/property/requirement/deal: a generic "summarise this" is about that record.
    const f = this.pkg.focus;
    if (f && (this.intent === "company_summary" || this.intent === "general") && f.type !== "company") {
      const byType: Partial<Record<EntityType, string>> = { person: "get_contact_profile", asset: "get_property_details", requirement: "get_requirement_details", opportunity: "get_opportunity_details", meeting: "get_meeting_history" };
      const id = byType[f.type];
      if (id && f.type !== "meeting") needs = [{ ids: [id], needs: [] }];
    }
    const add = (tool: ReturnType<typeof findTool>, input: Record<string, unknown> | null) => {
      if (!tool || !input || !tool.input.safeParse(input).success) return false;
      if (calls.some((c) => c.name === tool.id && JSON.stringify(c.input) === JSON.stringify(input))) return false;
      calls.push(this.call(tool.id, input));
      return true;
    };
    for (const need of needs) {
      if (need.needs?.some(empty) || need.unless?.some((n) => !empty(n)) || (need.when && !need.when.test(this.pkg.request))) continue;
      const tool = findTool(need.ids, need.re);
      if (!tool || (calls.some((c) => c.name === tool.id) && !need.input)) continue;
      add(tool, need.input ? need.input(s) : fillInput(tool.input, s));
    }
    // Other clauses of a multi-part request ("…, create a reminder for Friday and update the deal review").
    for (const c of CLAUSES) if (c.re.test(this.pkg.request) && !calls.some((x) => x.name === c.tool)) add(findTool([c.tool]), c.build(s));
    return calls;
  }

  private ambiguity() {
    return (this.pkg.ambiguous ?? []).filter((a) => !(this.pkg.focus && this.pkg.focus.type === a.type));
  }

  /** Second turn: tools that need ids from the first turn's results. */
  private followUp(results: { name: string; r: Result }[]): ToolUse[] {
    const s = slotsFrom(this.pkg);
    const items = (name: string) => (((results.find((x) => x.name === name && x.r.ok)?.r.data ?? {}) as { items?: Record<string, unknown>[] }).items ?? []);
    const out: ToolUse[] = [];
    const has = (id: string) => !!findTool([id]);
    if (this.intent === "meeting_prep") {
      const m = items("get_upcoming_meetings").find((x) => !s.company || x.companyId === s.company.id) ?? items("get_upcoming_meetings")[0];
      if (m && has("generate_meeting_brief")) out.push(this.call("generate_meeting_brief", m.prepId ? { prepId: m.prepId } : { meetingId: m.meetingId }));
    }
    if (this.intent === "rejected_options") {
      const r = items("search_requirements")[0];
      const id = r && (r.id ?? r.requirementId);
      if (id && has("get_requirement_details")) out.push(this.call("get_requirement_details", { requirementId: id }));
    }
    if (this.intent === "deal_review") {
      const o = items("search_opportunities")[0];
      const id = o && (o.id ?? o.opportunityId);
      if (id && has("generate_deal_review")) out.push(this.call("generate_deal_review", { opportunityId: id }));
    }
    if (this.intent === "research" && s.infra && has("calculate_distance")) {
      const ids = [...new Set(items("search_properties").map((x) => x.assetId as string).filter(Boolean))].slice(0, 25);
      if (ids.length) out.push(this.call("calculate_distance", { from: { type: "point", lat: s.infra.lat, lon: s.infra.lon, label: s.infra.name }, to: ids.map((id) => ({ type: "asset", id })) }));
    }
    return out.filter((c) => findTool([c.name])!.input.safeParse(c.input).success);
  }

  private collectResults(req: ChatRequest): { name: string; r: Result }[] {
    const names = new Map<string, string>();
    const out: { name: string; r: Result }[] = [];
    for (const m of req.messages) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_use") names.set((b as ToolUse).id, (b as ToolUse).name);
        if (b.type === "tool_result") {
          const tr = b as { tool_use_id: string; content: string };
          let r: Result = {};
          const raw = tr.content.includes("<evidence>") ? tr.content.split("<evidence>")[1].split("</evidence>")[0].trim() : tr.content;
          try { r = JSON.parse(raw.replace(/…\(truncated\)$/, "")); } catch { r = { summary: tr.content.slice(0, 200) }; }
          out.push({ name: names.get(tr.tool_use_id) ?? "tool", r });
        }
      }
    }
    return out;
  }

  /** Intent-specific detail lines, quoted from tool results only (no arithmetic, no invented quotes). */
  private detail(ok: { name: string; r: Result }[]): string[] {
    const out: string[] = [];
    // Results reach the planner compacted (deep lists may be summarised as text), so read them defensively.
    const L = (v: unknown): any[] => (Array.isArray(v) ? v : []);
    const S = (v: unknown): string[] => L(v).map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    const data = (name: string) => ok.find((x) => x.name === name)?.r.data as Record<string, any> | undefined;
    const sig = data("get_research_signals");
    if (L(sig?.items).length && (this.intent === "research_why" || this.intent === "priority_accounts")) {
      const ev = L(sig!.evidence);
      for (const x of L(sig!.items).slice(0, 3)) {
        out.push(`- Signal: ${x.title} — ${x.verification} (${x.confidence ?? "confidence unknown"}), evidence dated ${x.evidenceOn ?? x.eventDate ?? "unknown"}.`);
        const mine = ev.filter((e) => e.signalId === x.id);
        for (const e of mine.filter((y) => y.role !== "counter")) out.push(`  - Supports (${e.source ?? "source"}, ${e.date ?? "undated"}): “${e.excerpt ?? "no excerpt stored"}”`);
        for (const e of mine.filter((y) => y.role === "counter")) out.push(`  - Counter-evidence (${e.source ?? "source"}, ${e.date ?? "undated"}): “${e.excerpt ?? "no excerpt stored"}”`);
        if (!mine.length) out.push("  - No stored evidence excerpt for this signal.");
      }
      if (L(sig!.items).some((x: any) => x.verification !== "fact")) out.push("These signals are not confirmed facts: treat the opportunity as a hypothesis until the client confirms it.");
    }
    const sc = data("get_scores");
    for (const x of L(sc?.items).filter((y: any) => ["lead", "company", "opportunity"].includes(y.model)).slice(0, 3)) {
      out.push(`- ${x.model} score ${x.score ?? "unknown"} (${x.band ?? "no band"}, completeness ${x.completeness ?? "unknown"}).${S(x.strengths).length ? ` Strengths: ${S(x.strengths).join("; ")}.` : ""}${S(x.weaknesses).length ? ` Weaker: ${S(x.weaknesses).join("; ")}.` : ""}${S(x.missing).length ? ` Missing: ${S(x.missing).slice(0, 5).join(", ")}.` : ""}`);
    }
    const dm = data("find_decision_makers");
    if (this.intent === "decision_makers") for (const x of L(dm?.items).slice(0, 8)) out.push(`- ${x.name ?? "Unnamed"} — ${x.title ?? "title unknown"}; role ${x.roleClass} (${x.roleBasis}); contact info ${x.contactStatus ?? "unknown"}.`);
    const mh = data("get_meeting_history");
    if (mh && (this.intent === "history" || this.intent === "outreach_draft")) {
      const items = L(mh.items);
      const assets = this.pkg.resolved.filter((r) => r.type === "asset").map((a) => a.label.split(/\s+/).slice(0, 2).join(" ").toLowerCase());
      const flat = L(mh.notes);
      const notes = flat.filter((x) => x.kind === "note").map((x) => ({ m: { title: x.meeting, date: x.date }, n: String(x.text) }));
      const relevant = assets.length ? notes.filter((x) => assets.some((a) => x.n.toLowerCase().includes(a))) : notes;
      if (this.intent === "history") {
        if (relevant.length) for (const x of relevant.slice(0, 5)) out.push(`- Original note, meeting “${x.m.title}” on ${x.m.date}: “${x.n}” (recorded note — wording as stored; not a verbatim quote of the client).`);
        else out.push(assets.length ? "- No recorded meeting note mentions that property; I won't guess what was said." : "- No meeting notes are recorded for this.");
      } else if (items[0]) {
        const commits = flat.filter((x) => x.kind === "commitment" && x.prepId === items[0].prepId).map((x) => String(x.text));
        out.push(`- Last meeting: “${items[0].title}” on ${items[0].date}.${commits.length ? ` Our commitments from it: ${commits.join("; ")}.` : " No commitments recorded."} The draft follows up on this meeting.`);
      }
    }
    if (ok.some((x) => x.name === "generate_outreach_draft")) out.push("This is a draft only — nothing has been sent. Review it in Outreach, approve it, and send it from your own mail.");
    const cmp = data("compare_properties");
    if (L(cmp?.properties).length && /\b(financ\w*|cheap\w*|cost\w*|econom\w*|expensive|rent)\b/i.test(this.pkg.request)) {
      const byCost = L(cmp!.byOccupancyCost);
      if (byCost.length) out.push(`- Financially (lowest occupancy cost over ${cmp!.termMonths ?? "the"} months, from the comparison calculator): ${byCost.map((x: any, i: number) => `${i + 1}. ${x.name} (${x.occupancyCost})`).join(", ")}.`);
      else out.push("- Occupancy cost is unknown for these properties, so I can't say which is financially better.");
      const top = L(cmp!.properties).find((x) => x.rank === 1);
      if (top) out.push(`- Separately, the weighted rating (${cmp!.formula ?? "rating model"}: fit, location, specs and cost together) ranks ${top.name} first — that is not a cost ranking.`);
    }
    return out;
  }

  private compose(results: { name: string; r: Result }[]): string {
    const p = this.pkg;
    const amb = this.ambiguity();
    if (amb.length && !results.length) {
      return [`Question: ${amb.map((a) => `several ${a.type === "company" ? "companies" : `${a.type}s`} match "${a.phrase}" — which one do you mean?`).join(" Also, ")}`,
        ...amb.flatMap((a) => a.candidates.map((c, i) => `${i + 1}. ${c.label}`)), "Open its page or use the full name, and I'll continue."].join("\n");
    }
    if (this.intent === "memory_correction" && !results.length) {
      return "Question: who is this about? Open the person's or company's page (or name them) so I can update the right memory.";
    }
    if (this.intent === "requirement_correction" && !results.length) {
      const s = slotsFrom(p);
      return s.requirement ? `Question: what is the new value? I could not read a number and unit from "${p.request.slice(0, 120)}" (e.g. "now 30,000 SF, not 25,000 SF").`
        : "Question: which requirement should I correct? Open the requirement's page or name it, and I'll prepare the change for your approval.";
    }
    if (this.intent === "compare_properties" && !slotsFrom(p).assets.length && (slotsFrom(p).requirement || !results.some((x) => x.r.ok))) {
      const req = slotsFrom(p).requirement;
      return [`Question: which properties should I compare${req ? ` against “${req.label}”` : ""}? Name them (or open a shortlist) — I won't pick buildings for you.`,
        ...results.filter((x) => x.r.ok).map((x) => `- ${x.r.summary ?? x.name}`)].join("\n");
    }
    if (!results.length) {
      const what = p.resolved.length ? p.resolved.map((r) => `${r.type} “${r.label}”`).join(", ") : null;
      return [`**${HEADINGS[this.intent]}**`, what ? `I found ${what}, but no tool could answer this in offline (mock) mode.` : "I couldn't identify a matching record for this request.", ...p.missing.map((m) => `- ${m}`)].join("\n\n");
    }
    const ok = results.filter((x) => x.r.ok);
    const failed = results.filter((x) => !x.r.ok);
    const lines: string[] = [`**${HEADINGS[this.intent]}**`];
    if (ok.length) lines.push(...ok.map((x) => `- ${x.r.summary ?? x.name}`));
    for (const x of ok) if (x.r.coverage) {
      lines.push(`Coverage: checked ${x.r.coverage.checked}, ${x.r.coverage.withData} with data.${x.r.coverage.note ? ` ${x.r.coverage.note}` : ""} This is based only on records in CRE OS — it is not a complete market list.`);
    }
    const asked = ["priority_accounts", "leases_expiring", "commitments", "general", "research", "rejected_options", "company_summary"].includes(this.intent) ? requestedCount(p.request) : null;
    if (asked) for (const x of ok) {
      const n = ((x.r.data as { items?: unknown[] } | undefined)?.items ?? null)?.length;
      if (n == null) continue;
      lines.push(n >= asked ? `Showing ${n}, as you asked for ${asked}.` : `Showing ${n} — you asked for ${asked}, but only ${n} matched.`);
      break;
    }
    if (failed.length) lines.push(...failed.map((x) => `- Not completed: ${x.r.error === "not_found_or_no_access" ? "a record was not found or you do not have access to it" : (x.r.summary ?? x.r.error ?? x.name)}`));
    lines.push(...this.detail(ok));
    // Requested sub-tasks that were not carried out are reported, not silently dropped (12.12).
    for (const c of CLAUSES) if (c.re.test(p.request) && !results.some((x) => x.name === c.tool)) lines.push(`- Not completed: ${c.label} — ${c.why}.`);
    const pendingApproval = ok.some((x) => /approval/i.test(x.r.summary ?? "") || (x.r.data as { status?: string } | undefined)?.status === "pending_approval");
    if (pendingApproval) lines.push("Nothing has been sent or changed: this needs your approval first.");
    if (this.intent === "rejected_options" || this.intent === "deal_review") lines.push("Statements marked verified come from records; anything marked inferred is interpretation.");
    if (this.intent === "research") lines.push("Distances are straight-line from stored coordinates, not travel distance. Research findings are reported, with their source dates; treat them as unconfirmed.");
    return lines.join("\n");
  }
}
