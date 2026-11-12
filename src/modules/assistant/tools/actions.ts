import { styleHintFor } from "../outputs/style";
/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { createHash } from "node:crypto";
import { z } from "zod";
import { generateBrief } from "@/modules/meetings/service";
import { createOutreach } from "@/modules/outreach/service";
import { createTask } from "@/lib/services/tasks";
import { stakeholderGaps, missingQuestions, type RequirementRow } from "@/modules/deals/requirements/contract";
import type { Block, ToolContext } from "../types";
import { loadOpportunityBundle } from "./database";
import { HREF, db, defineTool, denied, failed, getOne, isUuid, namesById, ref, today, ws, type Row } from "./shared";

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x?.text ?? x?.question ?? x?.label ?? JSON.stringify(x))) : []);

// ---------------------------------------------------------------------------------------------------- meeting brief
const generateMeetingBrief = defineTool({
  id: "generate_meeting_brief", module: "meetings", category: "B", timeoutMs: 90_000,
  description: "Generate (or regenerate) the pre-meeting brief with the Meetings module: purpose, company facts, attendees and why they matter, history and earlier promises, questions, objections, strategy, target outcome. Facts are tagged fact/history/inference/unknown. Pass the prep id or meeting id from get_upcoming_meetings.",
  input: z.object({ prepId: z.string().optional(), meetingId: z.string().optional().describe("meeting_visit id (if no prep id)") }).refine((v) => v.prepId || v.meetingId, "prepId or meetingId required"),
  async run(i, t) {
    let prep: Row | null = null;
    if (i.prepId && isUuid(i.prepId)) prep = await getOne(t, "meeting_prep", i.prepId, "id");
    if (!prep && i.meetingId && isUuid(i.meetingId)) prep = ((await db(t).from("meeting_prep").select("id").eq("workspace_id", ws(t)).eq("meeting_visit_id", i.meetingId).maybeSingle()).data as Row | null);
    if (!prep) {
      if (i.meetingId && isUuid(i.meetingId) && (await getOne(t, "meeting_visit", i.meetingId, "id"))) return { ok: false, error: "no_prep", summary: "This meeting has no preparation record yet — open it in Meetings to set it up.", missing: ["Meeting preparation record"] };
      return denied(t, "generate_meeting_brief", { entity: "meeting_prep", id: i.prepId ?? i.meetingId });
    }
    try {
      const r = await generateBrief(db(t), ws(t), t.ctx.userId, prep.id);
      const p = (await getOne(t, "meeting_prep", prep.id, "id, brief, readiness, readiness_detail"))!;
      const b = (p.brief ?? {}) as Row; const ov = (b.overview ?? {}) as Row;
      const q = (b.questions ?? {}) as Row;
      const sections = [
        { heading: "Purpose", bullets: asList([b.purpose?.why ?? b.purpose?.summary ?? b.purpose].filter(Boolean)) },
        { heading: "Company", bullets: [b.company?.summary, ...asList(b.company?.unknowns).map((u) => `Unknown: ${u}`)].filter(Boolean) as string[] },
        { heading: "Attendees", bullets: ((b.attendees ?? []) as Row[]).map((a) => `${a.name}${a.title ? ` — ${a.title}` : ""}${a.why_matters ? `: ${a.why_matters}` : ""}`) },
        { heading: "Earlier promises", bullets: ((b.history?.commitments ?? []) as Row[]).map((c) => `${c.date}: ${c.text}`) },
        { heading: "Key questions", bullets: asList(q.essential).slice(0, 5) },
        { heading: "Strategy", bullets: asList(b.strategy) },
        { heading: "Target outcome", bullets: asList([b.outcome].flat().filter(Boolean)) },
      ].filter((s) => s.bullets.length);
      const missing = asList((p.readiness_detail as Row)?.gaps ?? (p.readiness_detail as Row)?.critical ?? []);
      return {
        ok: true, summary: `Brief v${r.version} ready (readiness: ${String(r.readiness ?? "unknown").replace(/_/g, " ")})${r.mocked ? " — rule-based wording (mock AI)" : ""}`, missing,
        entities: [ref("meeting", prep.id, ov.title ?? "Meeting", HREF.meeting(prep.id))],
        data: { prepId: prep.id, version: r.version, readiness: r.readiness, mocked: r.mocked, title: ov.title, start: ov.start, company: ov.company, href: HREF.meeting(prep.id) },
        blocks: [{ kind: "brief", title: `Meeting brief — ${ov.title ?? ""}`.trim(), sections, href: HREF.meeting(prep.id) }],
        sources: [{ label: `Meeting brief v${r.version}`, href: HREF.meeting(prep.id), observedAt: today(), status: "verified" }],
      };
    } catch (e) { return failed("Brief generation failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- outreach draft
const generateOutreachDraft = defineTool({
  id: "generate_outreach_draft", module: "outreach", category: "B", timeoutMs: 90_000,
  description: "Prepare an outreach DRAFT for a person with the Outreach module (one per channel). Respects do-not-contact, suppression and 'not interested'; warns about duplicates. Never sends — the user reviews, approves and sends from their own app.",
  input: z.object({
    personId: z.string(),
    channels: z.array(z.enum(["email", "whatsapp", "linkedin", "call"])).min(1).max(3).describe("Channels to draft for (call = call script)"),
    scenario: z.enum(["lease_renewal", "expansion", "consolidation", "relocation", "managed_office", "gcc", "reconnect", "meeting_followup"]).optional().describe("Default: inferred from signals/lease events"),
    signalId: z.string().optional(), opportunityId: z.string().optional(),
    language: z.enum(["en", "hi", "hinglish"]).optional(),
  }),
  async run(i, t) {
    if (!isUuid(i.personId) || !(await getOne(t, "person", i.personId, "id"))) return denied(t, "generate_outreach_draft", { entity: "person", id: i.personId });
    if (i.opportunityId && (!isUuid(i.opportunityId) || !(await getOne(t, "opportunity", i.opportunityId, "id")))) return denied(t, "generate_outreach_draft", { entity: "opportunity", id: i.opportunityId });
    if (i.signalId && (!isUuid(i.signalId) || !(await getOne(t, "signal", i.signalId, "id")))) return denied(t, "generate_outreach_draft", { entity: "signal", id: i.signalId });
    try {
      const r = await createOutreach(db(t), ws(t), t.ctx.userId, { personId: i.personId, channels: i.channels, scenario: i.scenario, signalId: i.signalId ?? null, opportunityId: i.opportunityId ?? null, language: i.language, styleHint: (await styleHintFor(db(t), ws(t), t.ctx.userId)) ?? undefined });
      const { data: items } = await db(t).from("outreach_item").select("id, channel, scenario, reason, draft_id").eq("workspace_id", ws(t)).in("id", r.ids);
      const drafts = ((items ?? []) as Row[]).filter((x) => x.draft_id).map((x) => x.draft_id);
      const { data: dr } = drafts.length ? await db(t).from("draft").select("id, subject, body, channel").eq("workspace_id", ws(t)).in("id", drafts) : { data: [] };
      const blocks: Block[] = ((items ?? []) as Row[]).map((x) => {
        const d = ((dr ?? []) as Row[]).find((y) => y.id === x.draft_id);
        return { kind: "draft", draftHref: HREF.outreach(x.id), channel: x.channel, subject: d?.subject ?? null, preview: String(d?.body ?? "(call script — open to view)").slice(0, 600) };
      });
      if (r.warnings.length) blocks.push({ kind: "missing", items: r.warnings.map((w) => w.text) });
      return {
        ok: true, summary: `Drafted ${r.ids.length} outreach item(s) — not sent${r.mocked ? " (mock AI wording)" : ""}`,
        data: { outreachIds: r.ids, warnings: r.warnings.map((w) => w.text), mocked: r.mocked, reason: ((items ?? []) as Row[])[0]?.reason ?? null, note: "Drafts only. The user approves and sends manually." },
        entities: ((items ?? []) as Row[]).map((x) => ref("outreach", x.id, `${x.channel} draft`, HREF.outreach(x.id))), blocks,
      };
    } catch (e) { return failed("Could not prepare outreach", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- task
const LINKABLE = { company: "organisation", person: "person", opportunity: "opportunity", requirement: "requirement", lease: "lease", asset: "asset", meeting: "meeting_visit" } as const;
export function taskDedupeKey(title: string, entityType: string | null, entityId: string | null, due: string | null) {
  const norm = title.trim().toLowerCase().replace(/\s+/g, " ");
  return `assistant:${createHash("sha256").update([norm, entityType ?? "", entityId ?? "", due ?? ""].join("|")).digest("hex").slice(0, 32)}`;
}
const createInternalTask = defineTool({
  id: "create_internal_task", module: "tasks", category: "B",
  description: "Create an internal task/reminder for the user (never sent to anyone). Deduplicated on title + linked record + due date: asking twice returns the existing task.",
  input: z.object({
    title: z.string().min(3).max(300), description: z.string().max(2000).optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Due date YYYY-MM-DD"),
    entityType: z.enum(["company", "person", "opportunity", "requirement", "lease", "asset", "meeting"]).optional(), entityId: z.string().optional(),
    priority: z.number().int().min(0).max(100).optional(),
  }),
  async run(i, t) {
    const table = i.entityType ? LINKABLE[i.entityType] : null;
    if (table && (!i.entityId || !isUuid(i.entityId) || !(await getOne(t, table, i.entityId, "id")))) return denied(t, "create_internal_task", { entity: table, id: i.entityId });
    const key = taskDedupeKey(i.title, table, i.entityId ?? null, i.due ?? null);
    const { data: existing } = await db(t).from("task").select("id, title, due_at, status").eq("workspace_id", ws(t)).eq("idempotency_key", key).maybeSingle();
    try {
      const row = (existing as Row | null) ?? (await createTask(db(t), ws(t), {
        title: i.title.trim(), description: i.description ?? "Created by the AI assistant", dueAt: i.due ? `${i.due}T12:30:00Z` : null, priority: i.priority ?? 50,
        source: "assistant", linkedEntityType: table, linkedEntityId: table ? i.entityId! : null, assignedUserId: t.ctx.userId, ownerUserId: t.ctx.userId, idempotencyKey: key,
      } as never)) as Row;
      const dup = !!existing;
      return {
        ok: true, summary: dup ? `Task already exists: ${row.title}` : `Task created: ${row.title}`, data: { taskId: row.id, duplicate: dup, title: row.title, due: row.due_at ? String(row.due_at).slice(0, 10) : null, status: row.status },
        entities: [ref("task", row.id, row.title, HREF.tasks())],
        blocks: [{ kind: "tasks", title: dup ? "Existing task" : "Task created", items: [{ title: row.title, due: row.due_at ? String(row.due_at).slice(0, 10) : null, done: row.status === "done", href: HREF.tasks() }] }],
      };
    } catch (e) { return failed("Could not create task", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- deal review
const generateDealReview = defineTool({
  id: "generate_deal_review", module: "assistant", category: "B",
  description: "Assemble a deal review from records: account, research signals (with counter-evidence counts), lead score and deal health, stakeholders (roles, gaps), requirement (and unanswered questions), property options, commercial comparison (quotes, occupancy cost from the saved comparison), outreach history, meetings and open commitments, open issues, next actions. Facts only, each section from its source record; nothing is written.",
  input: z.object({ opportunityId: z.string() }),
  async run(i, t) {
    const b = isUuid(i.opportunityId) ? await loadOpportunityBundle(t, i.opportunityId) : null;
    if (!b) return denied(t, "generate_deal_review", { entity: "opportunity", id: i.opportunityId });
    const { o, d } = b; const now = today();
    const org = (o.organisation ?? null) as Row | null;
    const req = o.requirement_id ? await getOne(t, "requirement", o.requirement_id) : null;
    const [{ data: opts }, { data: analyses }] = await Promise.all([
      req ? db(t).from("shortlist_option").select("asset_id, version, option_status, eligible, fit_score, disqualifiers").eq("workspace_id", ws(t)).eq("requirement_id", req.id).is("archived_at", null).order("version", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
      db(t).from("deal_analysis").select("id, kind, title, status, formula_version, updated_at").eq("workspace_id", ws(t)).is("archived_at", null).or(`opportunity_id.eq.${o.id}${req ? `,requirement_id.eq.${req.id}` : ""}`).order("updated_at", { ascending: false }).limit(10),
    ]);
    const orgId = (org?.id ?? o.org_id ?? null) as string | null;
    // M2 signals, M3 scores, M4 roles, M5 outreach, M7 meetings — read through RLS (db(t)), workspace-filtered.
    const [{ data: sigs }, { data: scores }, { data: roles }, { data: outreach }, { data: preps }] = await Promise.all([
      orgId ? db(t).from("signal").select("id, title, verification, confidence, latest_evidence_on, event_date, priority_band").eq("workspace_id", ws(t)).eq("org_id", orgId).is("archived_at", null).not("status", "in", "(dismissed,closed)").order("priority", { ascending: false }).limit(3) : Promise.resolve({ data: [] }),
      db(t).from("score_result").select("model_key, entity_id, score, band, completeness, missing, recommended_action, calculated_at").eq("workspace_id", ws(t)).eq("is_current", true).in("entity_id", [o.id, ...(orgId ? [orgId] : [])]).in("model_key", ["lead", "opportunity"]),
      orgId ? db(t).from("contact_role_assessment").select("person_id, role_class").eq("workspace_id", ws(t)).eq("org_id", orgId).eq("active", true) : Promise.resolve({ data: [] }),
      orgId ? db(t).from("outreach_item").select("id, channel, status, scenario, person_id, updated_at").eq("workspace_id", ws(t)).eq("org_id", orgId).is("archived_at", null).order("updated_at", { ascending: false }).limit(3) : Promise.resolve({ data: [] }),
      db(t).from("meeting_prep").select("id, meeting_visit_id, purpose, status").eq("workspace_id", ws(t)).eq("opportunity_id", o.id).limit(50),
    ]);
    const sigRows = (sigs ?? []) as Row[];
    const { data: sigEv } = sigRows.length ? await db(t).from("signal_evidence").select("signal_id, role").eq("workspace_id", ws(t)).in("signal_id", sigRows.map((x) => x.id)).is("archived_at", null) : { data: [] };
    const prepRows = (preps ?? []) as Row[];
    const [{ data: visits }, { data: mnotes }] = await Promise.all([
      prepRows.length ? db(t).from("meeting_visit").select("id, title, start_at, status").eq("workspace_id", ws(t)).in("id", prepRows.map((p) => p.meeting_visit_id)) : Promise.resolve({ data: [] }),
      prepRows.length ? db(t).from("meeting_note").select("prep_id, kind, text").eq("workspace_id", ws(t)).in("prep_id", prepRows.map((p) => p.id)).eq("kind", "commitment") : Promise.resolve({ data: [] }),
    ]);
    const nowIso = new Date().toISOString();
    const vis = ((visits ?? []) as Row[]).filter((x) => x.status !== "cancelled").sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
    const pastV = vis.filter((x) => x.start_at < nowIso); const nextV = vis.filter((x) => x.start_at >= nowIso);
    const people = await namesById(t, "person", ((outreach ?? []) as Row[]).map((x) => x.person_id));
    const roleOf = new Map(((roles ?? []) as Row[]).map((r) => [r.person_id, r.role_class]));
    const quoteRows = b.quotes.map((q) => ({ v: q.version, space: q.space_id, terms: (q.terms_json ?? {}) as Row }));
    const spaceAsset = quoteRows.length ? new Map(((((await db(t).from("space").select("id, asset_id").eq("workspace_id", ws(t)).in("id", quoteRows.map((q) => q.space).filter(Boolean))).data) ?? []) as Row[]).map((x) => [x.id, x.asset_id])) : new Map<string, string>();
    const qNames = await namesById(t, "asset", [...spaceAsset.values()]);
    const latestCmp = ((analyses ?? []) as Row[]).find((a) => a.kind === "property_comparison");
    const cmpOut = latestCmp ? ((((await db(t).from("deal_analysis").select("outputs").eq("workspace_id", ws(t)).eq("id", latestCmp.id).maybeSingle()).data as Row | null)?.outputs ?? {}) as Row) : null;
    const optRows = (opts ?? []) as Row[]; const v = optRows[0]?.version;
    const latest = optRows.filter((x) => x.version === v);
    const an = await namesById(t, "asset", latest.map((x) => x.asset_id));
    const promises = b.interactions.flatMap((it) => ((it.promises ?? []) as Row[]).filter((p) => p && !["done", "closed", "kept"].includes(String(p.status ?? "open"))).map((p) => `${p.who === "them" ? "Client" : "We"}: ${p.what}${p.due ? ` (due ${p.due}${p.due < now ? ", OVERDUE" : ""})` : ""}`));
    const issues = [
      ...(d.objections as Row[]).filter((x) => !x.outcome).map((x) => `Objection: ${x.objection}`),
      ...(d.milestones as Row[]).filter((m) => m.required_for_stage && !["done", "waived", "not_applicable"].includes(m.status)).map((m) => `Closing item open: ${m.title}`),
      ...b.quotes.filter((q) => q.valid_until && q.valid_until < now).map((q) => `Quote v${q.version} expired ${q.valid_until}`),
      ...(o.risks ? [`Recorded risks: ${o.risks}`] : []),
    ];
    const sections = [
      { heading: "Account", bullets: [`${org?.display_name ?? "Company unknown"} — ${o.name}`, `Stage ${o.stage}${o.stage_entered_at ? ` since ${String(o.stage_entered_at).slice(0, 10)}` : ""}; temperature ${o.temperature ?? "unknown"}; mandate ${o.mandate_status ?? "unknown"}`, `Expected fee: ${o.expected_fee ?? "unknown"}; expected close: ${o.expected_close ?? "unknown"}`] },
      { heading: "Stakeholders", bullets: [...b.stakeholders.map((s) => `${s.name ?? "?"} — ${s.role}${roleOf.get(s.personId) ? `, ${roleOf.get(s.personId)}` : ""}${s.access ? ` (${s.access})` : ""}`), ...stakeholderGaps(b.stakeholders.map((s) => s.role)).map((g) => `Gap: ${g}`)] },
      { heading: "Requirement", bullets: req ? [`${req.title} — ${req.status}`, `Seats ${req.seats_target ?? "?"}; area ${req.area_target_sf ?? `${req.area_min_sf ?? "?"}–${req.area_max_sf ?? "?"}`} SF; budget ${req.budget_max ?? "?"} ${req.budget_basis ?? ""}; move-in ${req.occupation_date ?? "?"}`, ...missingQuestions(req as RequirementRow).filter((q) => q.priority === "mandatory").slice(0, 5).map((q) => `Open: ${q.label}`)] : ["No requirement linked"] },
      { heading: "Options", bullets: latest.length ? latest.map((x) => `${an.get(x.asset_id) ?? "Building"} — ${x.option_status}${x.eligible === false ? ` (ineligible: ${(x.disqualifiers ?? []).join(", ")})` : ""}${x.fit_score != null ? `, fit ${x.fit_score}` : ""}`) : ["No shortlist yet"] },
      { heading: "Commercials", bullets: [...((analyses ?? []) as Row[]).map((a) => `${a.title} (${a.kind}, ${a.status}, ${a.formula_version})`), ...b.quotes.map((q) => `Quote v${q.version}${q.valid_until ? ` valid until ${q.valid_until}` : ""}${q.approved_at ? ", approved" : ""}`)].slice(0, 10) },
      { heading: "Commercial comparison", bullets: [
        ...quoteRows.map((q) => `${qNames.get(spaceAsset.get(q.space) ?? "") ?? "Space"} (quote v${q.v}): rent ${q.terms.rent ?? "?"} ₹/SF/mo, CAM ${q.terms.cam_per_sf ?? "?"}, rent-free ${q.terms.rent_free_months ?? "?"} mo, escalation ${q.terms.escalation_pct ?? "?"}% / ${q.terms.escalation_every_months ?? "?"} mo, term ${q.terms.tenure_months ?? "?"} mo (quoted)`),
        ...(cmpOut?.properties ? (cmpOut.properties as Row[]).slice().filter((p) => p.occupancyCost != null).sort((x, y) => Number(x.occupancyCost) - Number(y.occupancyCost)).map((p, k) => `Occupancy cost #${k + 1}: ${p.name} — ${p.occupancyCost} (weighted rating rank ${p.rank}; ${latestCmp!.formula_version})`) : ["No saved property comparison — run compare_properties for occupancy cost"]),
      ].slice(0, 12) },
      { heading: "Signals", bullets: sigRows.map((x) => { const e = ((sigEv ?? []) as Row[]).filter((y) => y.signal_id === x.id); return `${x.title} — ${x.verification} (${x.confidence ?? "?"}), evidence ${x.latest_evidence_on ?? x.event_date ?? "undated"}; ${e.filter((y) => y.role !== "counter").length} supporting, ${e.filter((y) => y.role === "counter").length} counter`; }) },
      { heading: "Priority and deal health", bullets: ((scores ?? []) as Row[]).map((x) => `${x.model_key === "lead" ? "Lead score" : "Deal health"} ${x.score} (${x.band}, completeness ${x.completeness ?? "?"})${(x.missing ?? []).length ? `; missing: ${(x.missing as string[]).slice(0, 4).join(", ")}` : ""}`) },
      { heading: "Outreach history", bullets: ((outreach ?? []) as Row[]).map((x) => `${String(x.updated_at).slice(0, 10)}: ${x.channel} to ${people.get(x.person_id) ?? "contact"}${roleOf.get(x.person_id) ? ` (${roleOf.get(x.person_id)})` : ""} — ${x.status}`) },
      { heading: "Meetings", bullets: [...pastV.slice(-2).map((x) => `Last: ${x.title} on ${String(x.start_at).slice(0, 10)}`), ...nextV.slice(0, 1).map((x) => `Next: ${x.title} on ${String(x.start_at).slice(0, 10)}`), ...((mnotes ?? []) as Row[]).map((n) => `Open commitment: ${n.text}`)] },
      { heading: "Open issues", bullets: issues },
      { heading: "Commitments", bullets: promises.slice(0, 10) },
      { heading: "Next actions", bullets: [...(o.next_action ? [`${o.next_action}${o.next_action_due ? ` (due ${o.next_action_due}${o.next_action_due < now ? ", OVERDUE" : ""})` : ""}`] : ["No next action recorded"]), ...b.tasks.map((tk) => `Task: ${tk.title}${tk.due_at ? ` (due ${String(tk.due_at).slice(0, 10)})` : ""}`)] },
    ].map((s) => ({ ...s, bullets: s.bullets.length ? s.bullets : ["Nothing recorded"] }));
    return {
      ok: true, summary: `Deal review for ${o.name}`, entities: [ref("opportunity", o.id, o.name, HREF.opportunity(o.id))],
      data: { opportunityId: o.id, sections, href: HREF.opportunity(o.id) },
      blocks: [{ kind: "brief", title: `Deal review — ${o.name}`, sections, href: HREF.opportunity(o.id) }],
      sources: [{ label: "Opportunity, requirement, shortlist, analyses, interactions", href: HREF.opportunity(o.id), retrievedAt: new Date().toISOString(), status: "verified" }],
    };
  },
});

export const actionTools = [generateMeetingBrief, generateOutreachDraft, createInternalTask, generateDealReview];
export type { ToolContext };
