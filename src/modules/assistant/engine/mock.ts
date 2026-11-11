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
  request: string; primary?: EntityRef;
};

/** Per intent: ordered tool "needs" (preferred ids, then a regex over ids). Each need contributes at most one call. */
type Need = { ids: string[]; re?: RegExp; needs?: (keyof Slots)[]; unless?: (keyof Slots)[] };
const PLANS: Record<Intent, Need[]> = {
  company_summary: [{ ids: ["get_company_profile"], needs: ["company"] }, { ids: ["search_companies"], unless: ["company"] }],
  meeting_prep: [
    { ids: ["generate_meeting_brief"], needs: ["meeting"] },
    { ids: ["get_upcoming_meetings"], unless: ["meeting"] },
    { ids: ["get_company_profile"], needs: ["company"] },
    { ids: ["get_commitments"], needs: ["company"] },
  ],
  compare_properties: [{ ids: ["compare_properties"], needs: ["assets"] }, { ids: ["search_properties"], unless: ["assets"] }],
  leases_expiring: [{ ids: ["find_leases_expiring"] }],
  rejected_options: [
    { ids: ["get_requirement_details"], needs: ["requirement"] },
    { ids: ["search_requirements"], needs: ["company"], unless: ["requirement"] },
    { ids: ["get_meeting_history"], needs: ["company"] },
    { ids: ["recall_memories"], needs: ["primary"] },
  ],
  deal_review: [
    { ids: ["generate_deal_review"], needs: ["opportunity"] },
    { ids: ["search_opportunities"], needs: ["company"], unless: ["opportunity"] },
  ],
  priority_accounts: [{ ids: ["rank_priority_accounts"] }],
  commitments: [{ ids: ["get_commitments"] }],
  send_proposal: [{ ids: ["prepare_send"], needs: ["outreach"] }],
  memory_correction: [{ ids: ["correct_memory"], needs: ["primary"] }],
  research: [{ ids: ["web_research"] }, { ids: ["search_properties"] }],
  general: [{ ids: ["get_company_profile"], needs: ["company"] }, { ids: ["search_companies"], unless: ["company"] }],
};

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

function correctionText(req: string) {
  const m = req.match(/\b(?:now|actually)\s+(.+)$/i);
  return (m ? m[1] : req).replace(/^\s*(he|she|they)\s+/i, (x) => x).trim().replace(/\.$/, "") || req;
}

function infraOf(p: ContextPackage) {
  const r = p.records.find((x) => x.type === "infrastructure" && x.lat != null && x.lon != null);
  return r ? { name: String(r.name ?? "Infrastructure"), lat: Number(r.lat), lon: Number(r.lon) } : undefined;
}

function slotsFrom(p: ContextPackage): Slots {
  const first = (t: EntityType) => (p.focus?.type === t ? p.focus : p.resolved.find((r) => r.type === t));
  return {
    company: first("company"), person: first("person"), assets: p.resolved.filter((r) => r.type === "asset").slice(0, 5),
    requirement: first("requirement"), opportunity: first("opportunity"), meeting: first("meeting"), request: p.request,
    outreach: first("outreach"), infra: infraOf(p),
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
    const empty = (n: keyof Slots) => { const v = s[n]; return Array.isArray(v) ? !v.length : !v; };
    for (const need of PLANS[this.intent]) {
      if (need.needs?.some(empty) || need.unless?.some((n) => !empty(n))) continue;
      const tool = findTool(need.ids, need.re);
      if (!tool || calls.some((c) => c.name === tool.id)) continue;
      const input = fillInput(tool.input, s);
      if (!tool.input.safeParse(input).success) continue;
      calls.push(this.call(tool.id, input));
    }
    return calls;
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

  private compose(results: { name: string; r: Result }[]): string {
    const p = this.pkg;
    if (this.intent === "memory_correction" && !results.length) {
      return "Question: who is this about? Open the person's or company's page (or name them) so I can update the right memory.";
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
    if (failed.length) lines.push(...failed.map((x) => `- Not completed: ${x.r.error === "not_found_or_no_access" ? "a record was not found or you do not have access to it" : (x.r.summary ?? x.r.error ?? x.name)}`));
    const pendingApproval = ok.some((x) => /approval/i.test(x.r.summary ?? "") || (x.r.data as { status?: string } | undefined)?.status === "pending_approval");
    if (pendingApproval) lines.push("Nothing has been sent or changed: this needs your approval first.");
    if (this.intent === "rejected_options" || this.intent === "deal_review") lines.push("Statements marked verified come from records; anything marked inferred is interpretation.");
    if (this.intent === "research") lines.push("Distances are straight-line from stored coordinates, not travel distance. Research findings are reported, with their source dates; treat them as unconfirmed.");
    return lines.join("\n");
  }
}
