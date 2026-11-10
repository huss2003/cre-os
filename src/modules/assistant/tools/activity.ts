/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Block, EntityRef, SourceRef, ToolContext } from "../types";
import {
  HREF, clampLimit, db, defineTool, denied, getOne, isUuid, missingBlock, namesById, ref, today, ws, type Row,
} from "./shared";

const limit = z.number().int().min(1).max(25).optional().describe("Max rows (1–25, default 10)");
const OURS = new Set(["self", "us", "we", "our", "me", "user"]);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

async function assertVisible(t: ToolContext, toolId: string, table: string, id: string | undefined, entity: string) {
  if (!id) return true;
  if (!isUuid(id) || !(await getOne(t, table, id, "id"))) { await denied(t, toolId, { entity, id }); return false; }
  return true;
}
const NA = { ok: false, error: "not_found_or_no_access", summary: "Record not found or you don't have access." } as const;

// ---------------------------------------------------------------------------------------------------- meetings
async function prepsFor(t: ToolContext, visitIds: string[]) {
  if (!visitIds.length) return new Map<string, Row>();
  const { data } = await db(t).from("meeting_prep").select("id, meeting_visit_id, org_id, opportunity_id, requirement_id, meeting_type, purpose, status, readiness, outcome, brief_version").eq("workspace_id", ws(t)).in("meeting_visit_id", visitIds);
  return new Map(((data ?? []) as Row[]).map((p) => [p.meeting_visit_id, p]));
}

const getUpcomingMeetings = defineTool({
  id: "get_upcoming_meetings", module: "meetings", category: "A",
  description: "Meetings scheduled in a date range (default: today + 7 days), with company, type, prep status and readiness. Use atTime ('15:00') with a date to resolve phrases like 'my 3 PM meeting' (matched in the workspace time zone, ±30 min).",
  input: z.object({
    from: isoDay.optional().describe("Start date YYYY-MM-DD (default today)"),
    to: isoDay.optional().describe("End date YYYY-MM-DD inclusive (default from + 7 days)"),
    atTime: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Local time HH:MM to pick one meeting"),
    companyId: z.string().optional(), limit,
  }),
  async run(i, t) {
    const tz = t.ctx.timezone || "Asia/Kolkata";
    const from = i.from ?? today();
    const to = i.to ?? new Date(Date.parse(from) + 7 * 86_400_000).toISOString().slice(0, 10);
    const startIso = fromZonedTime(`${from}T00:00:00`, tz).toISOString(); const endIso = fromZonedTime(`${to}T23:59:59`, tz).toISOString();
    const { data } = await db(t).from("meeting_visit").select("id, title, start_at, end_at, location, status, kind, linked_entity_type, linked_entity_id, opportunity_id, lat, lon").eq("workspace_id", ws(t)).is("archived_at", null).gte("start_at", startIso).lte("start_at", endIso).order("start_at").limit(200);
    let rows = ((data ?? []) as Row[]).filter((m) => m.status !== "cancelled");
    const preps = await prepsFor(t, rows.map((m) => m.id));
    if (i.companyId) rows = rows.filter((m) => preps.get(m.id)?.org_id === i.companyId || (m.linked_entity_type === "organisation" && m.linked_entity_id === i.companyId));
    if (i.atTime) {
      const [h, mm] = i.atTime.split(":").map(Number); const want = h * 60 + mm;
      rows = rows.filter((m) => { const [lh, lm] = formatInTimeZone(m.start_at, tz, "HH:mm").split(":").map(Number); return Math.abs(lh * 60 + lm - want) <= 30; });
    }
    const orgs = await namesById(t, "organisation", rows.map((m) => preps.get(m.id)?.org_id));
    const lim = clampLimit(i.limit);
    const items = rows.slice(0, lim).map((m) => {
      const p = preps.get(m.id);
      return { meetingId: m.id, prepId: p?.id ?? null, title: m.title, start: m.start_at, local: formatInTimeZone(m.start_at, tz, "EEE dd MMM HH:mm"), end: m.end_at, location: m.location, company: p?.org_id ? orgs.get(p.org_id) ?? null : null, companyId: p?.org_id ?? null, type: p?.meeting_type ?? m.kind, prepStatus: p?.status ?? "no prep", readiness: p?.readiness ?? null, hasBrief: !!p?.brief_version, href: p ? HREF.meeting(p.id) : "/meetings" };
    });
    const entities: EntityRef[] = items.map((x) => ref("meeting", x.prepId ?? x.meetingId, x.title, x.href));
    return {
      ok: true, summary: i.atTime ? (items.length === 1 ? `Found: ${items[0].title} at ${items[0].local}` : `${items.length} meetings near ${i.atTime}`) : `${rows.length} meeting(s) ${from} → ${to}`,
      data: { from, to, total: rows.length, items, ambiguous: !!i.atTime && items.length > 1 }, entities,
      coverage: { checked: rows.length, withData: items.filter((x) => x.prepId).length, note: "withData = meetings with a prep record" },
      blocks: items.length ? [{ kind: "table", title: "Meetings", columns: ["When", "Meeting", "Company", "Prep", "Readiness"], rows: items.map((x) => [x.local, x.title, x.company, x.prepStatus, x.readiness]) }] : [{ kind: "text", markdown: `No meetings found ${from} → ${to}${i.atTime ? ` around ${i.atTime}` : ""}.` }],
    };
  },
});

const getMeetingHistory = defineTool({
  id: "get_meeting_history", module: "meetings", category: "A",
  description: "Past meetings with a company or person: date, type, outcome summary, commitments and notes. Use to answer 'what happened last time we met X'.",
  input: z.object({ companyId: z.string().optional(), personId: z.string().optional(), limit }).refine((v) => v.companyId || v.personId, "companyId or personId is required"),
  async run(i, t) {
    if (!(await assertVisible(t, "get_meeting_history", "organisation", i.companyId, "organisation"))) return NA;
    if (!(await assertVisible(t, "get_meeting_history", "person", i.personId, "person"))) return NA;
    let prepIds: string[] = [];
    if (i.companyId) prepIds = (((await db(t).from("meeting_prep").select("id").eq("workspace_id", ws(t)).eq("org_id", i.companyId).limit(200)).data ?? []) as Row[]).map((p) => p.id);
    if (i.personId) {
      const att = (((await db(t).from("meeting_prep_attendee").select("prep_id").eq("workspace_id", ws(t)).eq("person_id", i.personId).limit(200)).data ?? []) as Row[]).map((a) => a.prep_id);
      prepIds = i.companyId ? prepIds.filter((p) => att.includes(p)) : att;
    }
    const preps = prepIds.length ? (((await db(t).from("meeting_prep").select("id, meeting_visit_id, meeting_type, purpose, status, outcome").eq("workspace_id", ws(t)).in("id", prepIds)).data ?? []) as Row[]) : [];
    const visits = preps.length ? (((await db(t).from("meeting_visit").select("id, title, start_at, location, status").eq("workspace_id", ws(t)).in("id", preps.map((p) => p.meeting_visit_id)).lt("start_at", new Date().toISOString())).data ?? []) as Row[]) : [];
    const vBy = new Map(visits.map((v) => [v.id, v]));
    const past = preps.filter((p) => vBy.has(p.meeting_visit_id)).sort((a, b) => String(vBy.get(b.meeting_visit_id)!.start_at).localeCompare(String(vBy.get(a.meeting_visit_id)!.start_at)));
    const lim = clampLimit(i.limit); const page = past.slice(0, lim);
    const { data: notes } = page.length ? await db(t).from("meeting_note").select("prep_id, kind, text, created_at").eq("workspace_id", ws(t)).in("prep_id", page.map((p) => p.id)).order("created_at") : { data: [] };
    const items = page.map((p) => {
      const v = vBy.get(p.meeting_visit_id)!; const pr = (p.outcome?.proposed ?? p.outcome ?? {}) as Row;
      const n = ((notes ?? []) as Row[]).filter((x) => x.prep_id === p.id);
      return { prepId: p.id, date: String(v.start_at).slice(0, 10), title: v.title, type: p.meeting_type, status: v.status ?? p.status, outcome: pr.summary ?? pr.outcome ?? null, commitments: n.filter((x) => x.kind === "commitment").map((x) => x.text), notes: n.filter((x) => x.kind !== "commitment").slice(0, 5).map((x) => String(x.text).slice(0, 240)), href: HREF.meeting(p.id) };
    });
    const missing = past.length ? [] : ["No past meetings recorded for this record"];
    return {
      ok: true, summary: `${past.length} past meeting(s)`, data: { total: past.length, items }, missing,
      entities: items.map((x) => ref("meeting", x.prepId, x.title, x.href)),
      sources: items.map((x): SourceRef => ({ label: `Meeting ${x.date}`, href: x.href, observedAt: x.date, status: "verified" })),
      blocks: [...(items.length ? [{ kind: "table" as const, title: "Meeting history", columns: ["Date", "Meeting", "Type", "Outcome", "Commitments"], rows: items.map((x) => [x.date, x.title, x.type, x.outcome ? String(x.outcome).slice(0, 160) : null, x.commitments.join("; ") || null]) }] : []), ...missingBlock(missing)],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- commitments
const getCommitments = defineTool({
  id: "get_commitments", module: "tasks", category: "A",
  description: "Open and overdue promises/commitments for a date range, gathered from meeting/call interactions (promises), open tasks, planned outreach follow-ups and meeting commitment notes. Marks each as overdue/open with its source. Default range: 30 days back to 14 days ahead.",
  input: z.object({
    from: isoDay.optional(), to: isoDay.optional(), companyId: z.string().optional().describe("Only commitments about this company"),
    includeTheirs: z.boolean().optional().describe("Also include promises the client made to us (default false = only ours)"),
    onlyOverdue: z.boolean().optional(), limit,
  }),
  async run(i, t) {
    if (!(await assertVisible(t, "get_commitments", "organisation", i.companyId, "organisation"))) return NA;
    const now = today();
    const from = i.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    type C = { what: string; due: string | null; who: string; source: string; status: "overdue" | "open"; company: string | null; href?: string };
    const out: C[] = [];
    let interIds: string[] | null = null;
    if (i.companyId) interIds = (((await db(t).from("interaction_link").select("interaction_id").eq("workspace_id", ws(t)).eq("entity_type", "organisation").eq("entity_id", i.companyId).limit(500)).data ?? []) as Row[]).map((x) => x.interaction_id);
    let iq = db(t).from("interaction").select("id, occurred_at, subject, promises").eq("workspace_id", ws(t)).gte("occurred_at", new Date(Date.parse(from) - 60 * 86_400_000).toISOString()).neq("promises", "[]").order("occurred_at", { ascending: false }).limit(500);
    if (interIds) iq = interIds.length ? iq.in("id", interIds.slice(0, 300)) : iq.eq("id", "00000000-0000-0000-0000-000000000000");
    for (const x of ((await iq).data ?? []) as Row[]) {
      for (const p of (x.promises ?? []) as Row[]) {
        if (typeof p !== "object" || !p) continue;
        if (["done", "closed", "cancelled", "kept"].includes(String(p.status ?? "open"))) continue;
        const ours = OURS.has(String(p.who ?? "self").toLowerCase());
        if (!ours && !i.includeTheirs) continue;
        const due = p.due ?? null;
        if (due && (due < from || due > to) && !(due < now)) continue;
        out.push({ what: String(p.what ?? p.text ?? ""), due, who: ours ? "us" : "client", source: `Interaction ${String(x.occurred_at).slice(0, 10)}${x.subject ? ` — ${x.subject}` : ""}`, status: due && due < now ? "overdue" : "open", company: null });
      }
    }
    let tq = db(t).from("task").select("id, title, due_at, linked_entity_type, linked_entity_id, source").eq("workspace_id", ws(t)).in("status", ["open", "snoozed"]).lte("due_at", `${to}T23:59:59Z`).order("due_at").limit(300);
    if (i.companyId) tq = tq.eq("linked_entity_type", "organisation").eq("linked_entity_id", i.companyId);
    for (const x of ((await tq).data ?? []) as Row[]) {
      const due = x.due_at ? String(x.due_at).slice(0, 10) : null;
      out.push({ what: x.title, due, who: "us", source: `Task (${x.source ?? "manual"})`, status: due && due < now ? "overdue" : "open", company: null, href: HREF.tasks() });
    }
    let oq = db(t).from("outreach_item").select("id, org_id, channel, scenario, planned_on, status, person_id").eq("workspace_id", ws(t)).eq("status", "planned").lte("planned_on", to).limit(200);
    if (i.companyId) oq = oq.eq("org_id", i.companyId);
    const oRows = ((await oq).data ?? []) as Row[];
    const pn = await namesById(t, "person", oRows.map((o) => o.person_id));
    for (const o of oRows) out.push({ what: `Follow up with ${pn.get(o.person_id) ?? "contact"} (${o.channel})`, due: o.planned_on, who: "us", source: "Planned outreach follow-up", status: o.planned_on < now ? "overdue" : "open", company: null, href: HREF.outreach(o.id) });
    let mq = db(t).from("meeting_note").select("prep_id, text, created_at").eq("workspace_id", ws(t)).eq("kind", "commitment").gte("created_at", `${from}T00:00:00Z`).limit(200);
    if (i.companyId) {
      const preps = (((await db(t).from("meeting_prep").select("id").eq("workspace_id", ws(t)).eq("org_id", i.companyId)).data ?? []) as Row[]).map((p) => p.id);
      mq = preps.length ? mq.in("prep_id", preps) : mq.eq("prep_id", "00000000-0000-0000-0000-000000000000");
    }
    for (const n of ((await mq).data ?? []) as Row[]) out.push({ what: String(n.text), due: null, who: "us", source: `Meeting note ${String(n.created_at).slice(0, 10)}`, status: "open", company: null, href: HREF.meeting(n.prep_id) });
    let rows = i.onlyOverdue ? out.filter((x) => x.status === "overdue") : out;
    rows = rows.sort((a, b) => (a.status === b.status ? String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")) : a.status === "overdue" ? -1 : 1));
    const lim = clampLimit(i.limit ?? 25); const page = rows.slice(0, lim);
    const overdue = rows.filter((x) => x.status === "overdue").length;
    return {
      ok: true, summary: `${rows.length} commitment(s), ${overdue} overdue`, data: { from, to, total: rows.length, overdue, items: page },
      coverage: { checked: rows.length, withData: rows.filter((x) => x.due).length, note: "Commitments without a due date are listed as open." },
      blocks: [{ kind: "tasks", title: "Commitments", items: page.map((x) => ({ title: `${x.status === "overdue" ? "OVERDUE · " : ""}${x.what} — ${x.source}`, due: x.due, done: false, href: x.href })) }],
      sources: [{ label: "Interactions, tasks, outreach plan, meeting notes", retrievedAt: new Date().toISOString(), status: "verified" }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- outreach
const getOutreachHistory = defineTool({
  id: "get_outreach_history", module: "outreach", category: "A",
  description: "Outreach to a person or company: each message's channel, scenario, status (draft/approved/sent/replied/paused), sent and reply dates and reply summary. Drafts are not sends.",
  input: z.object({ personId: z.string().optional(), companyId: z.string().optional(), limit }).refine((v) => v.personId || v.companyId, "personId or companyId is required"),
  async run(i, t) {
    if (!(await assertVisible(t, "get_outreach_history", "person", i.personId, "person"))) return NA;
    if (!(await assertVisible(t, "get_outreach_history", "organisation", i.companyId, "organisation"))) return NA;
    let q = db(t).from("outreach_item").select("id, person_id, org_id, channel, scenario, status, step, reason, planned_on, sent_at, responded_at, response, pause_reason, created_at", { count: "exact" }).eq("workspace_id", ws(t));
    if (i.personId) q = q.eq("person_id", i.personId);
    if (i.companyId) q = q.eq("org_id", i.companyId);
    const { data, count } = await q.order("created_at", { ascending: false }).limit(clampLimit(i.limit));
    const rows = (data ?? []) as Row[];
    const pn = await namesById(t, "person", rows.map((r) => r.person_id));
    const items = rows.map((r) => ({ id: r.id, person: pn.get(r.person_id) ?? null, channel: r.channel, scenario: r.scenario, status: r.status, step: r.step, plannedOn: r.planned_on, sentAt: r.sent_at, repliedAt: r.responded_at, reply: r.response?.summary ?? null, paused: r.pause_reason, href: HREF.outreach(r.id) }));
    const sent = items.filter((x) => x.sentAt).length;
    return {
      ok: true, summary: `${count ?? items.length} outreach item(s), ${sent} sent`, data: { total: count ?? items.length, sent, items },
      entities: items.map((x) => ref("outreach", x.id, `${x.channel} to ${x.person ?? "contact"}`, x.href)),
      blocks: items.length ? [{ kind: "table", title: "Outreach", columns: ["Created/sent", "To", "Channel", "Scenario", "Status", "Reply"], rows: items.map((x) => [String(x.sentAt ?? x.plannedOn ?? "").slice(0, 10) || null, x.person, x.channel, x.scenario, x.status, x.reply]) }] : [{ kind: "text", markdown: "No outreach recorded." }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- signals
const getResearchSignals = defineTool({
  id: "get_research_signals", module: "research", category: "A",
  description: "Signals (expansion, lease events, leadership moves, funding, etc.) and the latest research dossier for a company or the whole workspace. Each signal has verification (fact/inference/hypothesis/unknown), confidence, evidence date and recommended action.",
  input: z.object({
    companyId: z.string().optional(), sinceDays: z.number().int().min(1).max(730).optional().describe("Only signals with evidence in the last N days (default 180)"),
    priorityBand: z.enum(["high", "medium", "low"]).optional(), limit,
  }),
  async run(i, t) {
    if (!(await assertVisible(t, "get_research_signals", "organisation", i.companyId, "organisation"))) return NA;
    const since = new Date(Date.now() - (i.sinceDays ?? 180) * 86_400_000).toISOString().slice(0, 10);
    let q = db(t).from("signal").select("id, org_id, category, kind, title, summary, verification, confidence, event_date, latest_evidence_on, detected_at, priority, priority_band, recommended_action, missing_info, status", { count: "exact" }).eq("workspace_id", ws(t)).is("archived_at", null).not("status", "in", "(dismissed,closed)").or(`latest_evidence_on.gte.${since},detected_at.gte.${since}`);
    if (i.companyId) q = q.eq("org_id", i.companyId);
    if (i.priorityBand) q = q.eq("priority_band", i.priorityBand);
    const { data, count } = await q.order("priority", { ascending: false }).limit(clampLimit(i.limit));
    const rows = (data ?? []) as Row[];
    const orgs = await namesById(t, "organisation", rows.map((r) => r.org_id));
    const { data: dossier } = i.companyId ? await db(t).from("research_dossier").select("id, generated_at, synthesis_status, evidence_count, expired_claim_count, degraded_reason").eq("workspace_id", ws(t)).eq("org_id", i.companyId).eq("is_current", true).maybeSingle() : { data: null };
    const items = rows.map((r) => ({ id: r.id, company: orgs.get(r.org_id) ?? null, title: r.title, kind: r.kind, verification: r.verification, confidence: r.confidence, eventDate: r.event_date, evidenceOn: r.latest_evidence_on, priority: r.priority_band, action: r.recommended_action, missing: r.missing_info, href: HREF.signal(r.id) }));
    const sources: SourceRef[] = items.map((x) => ({ label: x.title, href: x.href, observedAt: x.evidenceOn ?? x.eventDate, status: x.verification === "fact" ? "verified" : x.verification === "inference" ? "reported" : x.verification === "hypothesis" ? "inferred" : "unknown" }));
    const missing = dossier ? [] : i.companyId ? ["No research dossier for this company"] : [];
    return {
      ok: true, summary: `${count ?? items.length} signal(s)`, data: { total: count ?? items.length, items, dossier }, sources, missing,
      entities: items.map((x) => ref("signal", x.id, x.title, x.href)),
      blocks: [...(items.length ? [{ kind: "table" as const, title: "Signals", columns: ["Company", "Signal", "Verification", "Evidence date", "Priority", "Next"], rows: items.map((x) => [x.company, x.title, x.verification, x.evidenceOn ?? x.eventDate ?? null, x.priority, x.action]) }] : [{ kind: "text" as const, markdown: "No signals in this period." }]), ...missingBlock(missing)],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- scores
const ENTITY_TABLE: Record<string, { table: string; models: string[]; href: (m: string, id: string) => string }> = {
  company: { table: "organisation", models: ["company", "lead", "relationship"], href: HREF.score },
  person: { table: "person", models: ["contact"], href: HREF.score },
  requirement: { table: "requirement", models: ["requirement"], href: HREF.score },
  opportunity: { table: "opportunity", models: ["opportunity"], href: HREF.score },
};

function explain(r: Row) {
  const f = ((r.factors ?? []) as Row[]).filter((x) => x.known).sort((a, b) => Number(b.points) - Number(a.points));
  const weak = ((r.factors ?? []) as Row[]).filter((x) => x.known && Number(x.points) < Number(x.max) / 2).sort((a, b) => Number(b.max) - Number(a.max));
  return { strengths: f.slice(0, 3).map((x) => `${x.label}: ${x.explanation}`), weaknesses: weak.slice(0, 3).map((x) => `${x.label}: ${x.explanation}`) };
}

const getScores = defineTool({
  id: "get_scores", module: "scoring", category: "A",
  description: "Current scores for a company (company attractiveness, lead priority, relationship), person (contact relevance), requirement or opportunity — each with band, confidence, completeness, the main reasons (factor explanations), missing inputs and the recommended next action. Scores are rules-based, not AI.",
  input: z.object({ entityType: z.enum(["company", "person", "requirement", "opportunity"]), entityId: z.string() }),
  async run(i, t) {
    const meta = ENTITY_TABLE[i.entityType];
    if (!(await assertVisible(t, "get_scores", meta.table, i.entityId, meta.table))) return NA;
    const { data } = await db(t).from("score_result").select("id, model_key, score, band, disqualified, confidence, completeness, factors, missing, recommended_action, calculated_at, change_reason, previous_score").eq("workspace_id", ws(t)).eq("entity_id", i.entityId).eq("is_current", true).in("model_key", meta.models);
    const rows = (data ?? []) as Row[];
    const { data: ov } = await db(t).from("score_override").select("model_key, kind, value, reason").eq("workspace_id", ws(t)).eq("entity_id", i.entityId).eq("active", true);
    const items = rows.map((r) => ({ model: r.model_key, score: r.score, band: r.band, disqualified: r.disqualified, confidence: r.confidence, completeness: r.completeness, ...explain(r), missing: r.missing ?? [], nextBestAction: r.recommended_action, calculatedAt: r.calculated_at, previous: r.previous_score, changeReason: r.change_reason, href: meta.href(r.model_key, i.entityId) }));
    const notScored = meta.models.filter((m) => !rows.some((r) => r.model_key === m));
    const missing = notScored.map((m) => `No current ${m} score (not yet calculated)`);
    return {
      ok: true, summary: items.length ? items.map((x) => `${x.model} ${x.score} (${x.band})`).join(", ") : "Not scored yet", data: { items, overrides: ov ?? [] }, missing,
      blocks: [...(items.length ? [{ kind: "table" as const, title: "Scores", columns: ["Model", "Score", "Band", "Confidence", "Next best action"], rows: items.map((x) => [x.model, x.score, x.band, x.confidence, x.nextBestAction]) }] : []), ...missingBlock(missing)],
      sources: items.map((x): SourceRef => ({ label: `${x.model} score`, href: x.href, observedAt: x.calculatedAt, status: "verified" })),
    };
  },
});

const rankPriorityAccounts = defineTool({
  id: "rank_priority_accounts", module: "scoring", category: "A",
  description: "Rank companies to focus on using the existing lead-priority scores (Module 3), honouring manual priority overrides. Explains each rank with the top scoring reasons and gives the recommended next action. Optional filter by sector or minimum band.",
  input: z.object({ sector: z.string().max(100).optional(), limit }),
  async run(i, t) {
    const lim = clampLimit(i.limit);
    const { data } = await db(t).from("score_result").select("entity_id, score, band, confidence, completeness, factors, missing, recommended_action, calculated_at").eq("workspace_id", ws(t)).eq("model_key", "lead").eq("is_current", true).eq("disqualified", false).order("score", { ascending: false }).limit(300);
    let rows = (data ?? []) as Row[];
    const orgIds = rows.map((r) => r.entity_id);
    const { data: orgs } = orgIds.length ? await db(t).from("organisation").select("id, display_name, sector").eq("workspace_id", ws(t)).is("archived_at", null).in("id", orgIds.slice(0, 300)) : { data: [] };
    const orgBy = new Map(((orgs ?? []) as Row[]).map((o) => [o.id, o]));
    rows = rows.filter((r) => orgBy.has(r.entity_id));
    if (i.sector) rows = rows.filter((r) => String(orgBy.get(r.entity_id)?.sector ?? "").toLowerCase().includes(i.sector!.toLowerCase()));
    const { data: ov } = await db(t).from("score_override").select("entity_id, value, reason").eq("workspace_id", ws(t)).eq("model_key", "lead").eq("kind", "priority").eq("active", true);
    const ovBy = new Map(((ov ?? []) as Row[]).map((o) => [o.entity_id, o]));
    const pin = (r: Row) => (ovBy.get(r.entity_id)?.value === "high" ? 1 : ovBy.get(r.entity_id)?.value === "low" ? -1 : 0);
    rows.sort((a, b) => pin(b) - pin(a) || b.score - a.score);
    const { count: totalOrgs } = await db(t).from("organisation").select("id", { count: "exact", head: true }).eq("workspace_id", ws(t)).is("archived_at", null);
    const page = rows.slice(0, lim);
    const items = page.map((r, n) => {
      const o = orgBy.get(r.entity_id)!; const e = explain(r); const ovr = ovBy.get(r.entity_id);
      return { rank: n + 1, companyId: o.id, company: o.display_name, score: r.score, band: r.band, confidence: r.confidence, why: [...(ovr ? [`Manual priority ${ovr.value}: ${ovr.reason}`] : []), ...e.strengths].join(" · "), gaps: (r.missing ?? []).slice(0, 3), next: r.recommended_action, href: HREF.company(o.id) };
    });
    const note = `${rows.length} scored companies ranked; ${(totalOrgs ?? 0) - rows.length} companies have no current lead score.`;
    return {
      ok: true, summary: `Top ${items.length} of ${rows.length} scored accounts`, data: { total: rows.length, items, note },
      coverage: { checked: totalOrgs ?? rows.length, withData: rows.length, note },
      entities: items.map((x) => ref("company", x.companyId, x.company, x.href)),
      blocks: [{ kind: "ranked_list", title: "Priority accounts", items: items.map((x) => ({ rank: x.rank, entity: ref("company", x.companyId, x.company, x.href), score: x.score, why: x.why || "Score from rules (see breakdown)", next: x.next ?? undefined })) }],
    };
  },
});

// ---------------------------------------------------------------------------------------------------- decision makers
const findDecisionMakers = defineTool({
  id: "find_decision_makers", module: "contacts", category: "A",
  description: "Who decides on office space at a company: people with role class decision-maker/influencer/evaluator (contact enrichment assessments), stakeholder roles on its requirements, current titles and reachable channels. Never invents people; lists gaps.",
  input: z.object({ companyId: z.string() }),
  async run(i, t) {
    if (!(await assertVisible(t, "find_decision_makers", "organisation", i.companyId, "organisation"))) return NA;
    const [{ data: emp }, { data: roles }, { data: reqs }] = await Promise.all([
      db(t).from("employment").select("person_id, title, seniority, function, fact_status").eq("workspace_id", ws(t)).eq("org_id", i.companyId).eq("is_current", true).is("archived_at", null),
      db(t).from("contact_role_assessment").select("person_id, role_class, department, reason, source").eq("workspace_id", ws(t)).eq("org_id", i.companyId).eq("active", true),
      db(t).from("requirement").select("id").eq("workspace_id", ws(t)).eq("org_id", i.companyId).is("archived_at", null),
    ]);
    const reqIds = ((reqs ?? []) as Row[]).map((r) => r.id);
    const { data: st } = reqIds.length ? await db(t).from("stakeholder").select("person_id, role, access_status").eq("workspace_id", ws(t)).in("requirement_id", reqIds).is("archived_at", null) : { data: [] };
    const ids = [...new Set([...((emp ?? []) as Row[]).map((e) => e.person_id), ...((st ?? []) as Row[]).map((s) => s.person_id)])];
    const names = await namesById(t, "person", ids);
    const { data: methods } = ids.length ? await db(t).from("contact_method").select("person_id, method_type, verify_status, suppressed").eq("workspace_id", ws(t)).in("person_id", ids).is("archived_at", null) : { data: [] };
    const RANK: Record<string, number> = { decision_maker: 0, influencer: 1, evaluator: 2, gatekeeper: 3, operational: 4, unknown: 5 };
    const items = ids.map((pid) => {
      const e = ((emp ?? []) as Row[]).find((x) => x.person_id === pid); const r = ((roles ?? []) as Row[]).find((x) => x.person_id === pid);
      const s = ((st ?? []) as Row[]).filter((x) => x.person_id === pid).map((x) => x.role);
      const ch = ((methods ?? []) as Row[]).filter((m) => m.person_id === pid && !m.suppressed).map((m) => `${m.method_type}:${m.verify_status ?? "unverified"}`);
      const roleClass = r?.role_class ?? (s.some((x) => ["approver", "sponsor"].includes(x)) ? "decision_maker" : "unknown");
      return { personId: pid, name: names.get(pid) ?? null, title: e?.title ?? null, seniority: e?.seniority ?? null, roleClass, roleBasis: r ? `${r.source}: ${r.reason}` : s.length ? `stakeholder role ${s.join(", ")}` : "not assessed", stakeholderRoles: s, channels: ch, href: HREF.person(pid) };
    }).sort((a, b) => (RANK[a.roleClass] ?? 9) - (RANK[b.roleClass] ?? 9));
    const missing: string[] = [];
    if (!items.some((x) => x.roleClass === "decision_maker")) missing.push("No confirmed decision-maker on record");
    if (!items.length) missing.push("No current contacts at this company");
    if (items.length && !items.some((x) => x.channels.length)) missing.push("No usable contact channel for these people");
    const blocks: Block[] = [{ kind: "table", title: "Decision-makers and influencers", columns: ["Name", "Title", "Role", "Basis", "Channels"], rows: items.map((x) => [x.name, x.title, x.roleClass, x.roleBasis, x.channels.join(", ") || null]) }, ...missingBlock(missing)];
    return { ok: true, summary: `${items.filter((x) => x.roleClass === "decision_maker").length} decision-maker(s), ${items.length} people`, data: { items }, missing, entities: items.map((x) => ref("person", x.personId, x.name, x.href)), blocks, coverage: { checked: items.length, withData: items.filter((x) => x.roleClass !== "unknown").length, note: "withData = people with an assessed role" } };
  },
});

export const activityTools = [getUpcomingMeetings, getMeetingHistory, getCommitments, getOutreachHistory, getResearchSignals, getScores, rankPriorityAccounts, findDecisionMakers];
