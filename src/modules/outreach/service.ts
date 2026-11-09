import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { createDraft, updateDraft, approveDraft, openDraftForSend, markDraftSent, getDraft, setDraftPaused, assertNotSuppressed, SuppressedRecipientError, } from "@/lib/services/drafts";
import { proposeChange } from "@/lib/services/changes";
import * as R from "./rules";

/**
 * Module 5 — Outreach Engine. Prepares context-grounded drafts; humans approve and send. There is no send code:
 * "send" = open the user's own mail/WhatsApp/LinkedIn with the approved text, then the user records it.
 * Approval/suppression/hash binding are enforced by mudar.draft (DB guard) — this layer adds scenario, context,
 * duplicate checks, follow-up planning with pause rules, responses and analytics.
 */
type Row = Record<string, any>;
export class OutreachError extends Error {}
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const ago = (iso: string | null | undefined) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null);
const OPEN = ["planned", "draft", "pending_approval", "approved"];

export interface Fact { text: string; source_type: string; source_id: string | null; date?: string | null }
export interface Context {
  person: Row; first: string; title: string | null; org: Row | null; roleKey: string; roleClass: string | null; relevance: string | null;
  level: R.Level; interactions: Row[]; lastInteraction: Row | null; promises: string[];
  signals: Row[]; leaseEvents: Row[]; opportunity: Row | null; requirement: Row | null; leadScore: number | null;
  channels: { email: string | null; phone: string | null; linkedin: string | null };
  blocked: { all: string | null; email: string | null; whatsapp: string | null; linkedin: string | null };
  facts: Fact[]; unknowns: string[];
}

async function suppressedFor(db: Db, ws: string, pid: string, ch: string) {
  try { await assertNotSuppressed(db, ws, pid, ch); return null; } catch (e) { if (e instanceof SuppressedRecipientError) return "Suppressed or consent revoked"; throw e; }
}

/** Everything the draft may use, each fact tied to a record. Only rows the user can read (RLS) are returned. */
export async function buildContext(db: Db, ws: string, personId: string, opts: { signalId?: string | null; opportunityId?: string | null } = {}): Promise<Context> {
  const { data: person } = await db.from("person").select("id, full_name, do_not_contact, employment(title, is_current, org_id, org:org_id(id, display_name, sector)), contact_method(method_type, value, verify_status, suppressed), contact_role_assessment(role_class, cre_relevance, active)").eq("workspace_id", ws).eq("id", personId).maybeSingle();
  if (!person) throw new OutreachError("Contact not found or not visible to you.");
  const emp = ((person.employment ?? []) as Row[]).find((e) => e.is_current) ?? null;
  const org: Row | null = emp?.org ?? null;
  const ra = (person.contact_role_assessment ?? []).find((x: Row) => x.active) ?? null;
  const cm = (person.contact_method ?? []).filter((m: Row) => !m.suppressed && m.verify_status !== "invalid");
  const pick = (t: string) => cm.find((m: Row) => m.method_type === t && ["verified", "likely_valid", "published_business", "business_mobile", "user_provided"].includes(m.verify_status))?.value ?? cm.find((m: Row) => m.method_type === t)?.value ?? null;
  const { data: links } = await db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, direction, subject, summary, promises, objections, is_meaningful, owner_user_id)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).limit(200);
  const ints = ((links ?? []) as Row[]).map((l) => l.interaction).filter(Boolean).sort((a: Row, b: Row) => b.occurred_at.localeCompare(a.occurred_at));
  const notInterested = ints.slice(0, 3).some((i: Row) => (i.objections ?? []).some((o: Row) => /not interested|do not contact|stop/i.test(JSON.stringify(o))));
  const [sig, opp, score] = await Promise.all([
    org ? db.from("signal").select("id, title, summary, category, kind, event_date, verification, confidence, status, latest_evidence_on").eq("workspace_id", ws).eq("org_id", org.id).not("status", "in", "(rejected,dismissed)").order("detected_at", { ascending: false }).limit(5) : Promise.resolve({ data: [] }),
    opts.opportunityId ? db.from("opportunity").select("id, name, stage, outcome, next_action, requirement_id").eq("workspace_id", ws).eq("id", opts.opportunityId).maybeSingle()
      : org ? db.from("opportunity").select("id, name, stage, outcome, next_action, requirement_id").eq("workspace_id", ws).eq("org_id", org.id).eq("outcome", "open").order("updated_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    org ? db.from("score_result").select("score").eq("workspace_id", ws).eq("model_key", "lead").eq("entity_id", org.id).eq("is_current", true).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  let signals = (sig.data ?? []) as Row[];
  if (opts.signalId && !signals.some((s) => s.id === opts.signalId)) {
    const { data } = await db.from("signal").select("id, title, summary, category, kind, event_date, verification, confidence, status, latest_evidence_on").eq("workspace_id", ws).eq("id", opts.signalId).maybeSingle();
    if (data) signals = [data, ...signals];
  }
  const leaseEvents: Row[] = [];
  if (org) {
    const { data: leases } = await db.from("lease").select("id, contractual_expiry, area_sf, asset:asset_id(name)").eq("workspace_id", ws).eq("tenant_org_id", org.id).limit(20);
    const ids = (leases ?? []).map((l: Row) => l.id);
    if (ids.length) {
      const { data: ev } = await db.from("lease_event").select("id, lease_id, event_type, event_date, confirmed, date_basis").eq("workspace_id", ws).in("lease_id", ids).gte("event_date", today()).lte("event_date", addDays(today(), 540)).order("event_date").limit(5);
      for (const e of ev ?? []) leaseEvents.push({ ...e, asset: ((leases ?? []) as Row[]).find((l) => l.id === e.lease_id)?.asset?.name ?? null });
    }
  }
  const opportunity = (opp.data as Row) ?? null;
  const requirement = opportunity?.requirement_id ? (await db.from("requirement").select("id, title, objective, status, seats_target, area_target_sf, occupation_date").eq("workspace_id", ws).eq("id", opportunity.requirement_id).maybeSingle()).data : null;
  const facts: Fact[] = [];
  if (emp) facts.push({ text: `${person.full_name} is ${emp.title ?? "employed"} at ${org?.display_name ?? "their company"}`, source_type: "employment", source_id: null });
  for (const s of signals.slice(0, 3)) facts.push({ text: `${s.title}${s.event_date ? ` (${s.event_date})` : ""} — ${s.verification === "fact" ? "confirmed" : "reported, not confirmed"}`, source_type: "signal", source_id: s.id, date: s.latest_evidence_on });
  for (const e of leaseEvents.slice(0, 2)) facts.push({ text: `Lease ${e.event_type.replace(/_/g, " ")} on ${e.event_date}${e.asset ? ` at ${e.asset}` : ""} (${e.confirmed ? "confirmed" : e.date_basis.replace(/_/g, " ")})`, source_type: "lease_event", source_id: e.id });
  if (ints[0]) facts.push({ text: `Last interaction ${ints[0].occurred_at.slice(0, 10)} by ${ints[0].channel}${ints[0].summary ? `: ${String(ints[0].summary).slice(0, 160)}` : ""}`, source_type: "interaction", source_id: ints[0].id });
  const promises = ints.slice(0, 5).flatMap((i: Row) => (i.promises ?? []).map((p: Row) => (typeof p === "string" ? p : p.what ?? p.text ?? JSON.stringify(p))));
  for (const p of promises.slice(0, 2)) facts.push({ text: `Earlier commitment: ${p}`, source_type: "interaction", source_id: ints[0]?.id ?? null });
  if (requirement) facts.push({ text: `Requirement: ${requirement.title} (${requirement.status})`, source_type: "requirement", source_id: requirement.id });
  if (opportunity) facts.push({ text: `Opportunity: ${opportunity.name}, stage ${opportunity.stage.replace(/_/g, " ")}`, source_type: "opportunity", source_id: opportunity.id });
  const unknowns = [!emp?.title && "current designation", !leaseEvents.length && "lease dates", !requirement && "space requirement", !ints.length && "any previous conversation"].filter(Boolean) as string[];
  const all = person.do_not_contact ? "Marked do-not-contact" : await suppressedFor(db, ws, personId, "any");
  return {
    person, first: String(person.full_name).split(/\s+/)[0], title: emp?.title ?? null, org, roleKey: R.roleKey(emp?.title), roleClass: ra?.role_class ?? null, relevance: ra?.cre_relevance ?? null,
    level: R.relationshipLevel(ints, notInterested), interactions: ints.slice(0, 5), lastInteraction: ints[0] ?? null, promises,
    signals, leaseEvents, opportunity, requirement, leadScore: (score.data as Row)?.score ?? null,
    channels: { email: pick("email"), phone: pick("phone"), linkedin: pick("linkedin") ?? pick("profile") },
    blocked: { all, email: all ?? (await suppressedFor(db, ws, personId, "email")), whatsapp: all ?? (await suppressedFor(db, ws, personId, "whatsapp")), linkedin: all ?? (await suppressedFor(db, ws, personId, "linkedin")) },
    facts, unknowns,
  };
}

/** Why contact them now — from records only. */
export function reasonFor(c: Context, scenario: R.Scenario, signalId?: string | null): string {
  const s = c.signals.find((x) => x.id === signalId) ?? c.signals[0];
  const e = c.leaseEvents[0];
  const co = c.org?.display_name ?? "your company";
  if (scenario === "lease_renewal" && e) return `${co}'s lease ${e.event_type.replace(/_/g, " ")} is due around ${e.event_date}, so it may be a good time to plan`;
  if (scenario === "meeting_followup" && c.lastInteraction) return `Following up on our ${c.lastInteraction.channel} on ${c.lastInteraction.occurred_at.slice(0, 10)}`;
  if (s) return `I noticed ${s.verification === "fact" ? "" : "reports of "}${s.title.replace(/\.$/, "")}${s.title.toLowerCase().includes(co.toLowerCase()) ? "" : ` at ${co}`}`;
  if (c.lastInteraction) return `It has been ${ago(c.lastInteraction.occurred_at)} days since we last spoke about ${co}'s office plans`;
  return `I work with companies in Pune on office space and ${co} came up in my research`;
}

export interface Warning { kind: string; text: string; by?: string | null; date?: string | null; itemId?: string | null }
/** Spec §14: warn (don't block) when someone else is already talking to this person. */
export async function duplicateCheck(db: Db, ws: string, personId: string, userId: string, excludePlan?: string): Promise<Warning[]> {
  const w: Warning[] = [];
  const { data: items } = await db.from("outreach_item").select("id, plan_key, status, channel, assigned_user_id, planned_on, sent_at, updated_at").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).in("status", [...OPEN, "sent"]).order("updated_at", { ascending: false }).limit(20);
  for (const i of (items ?? []) as Row[]) {
    if (excludePlan && i.plan_key === excludePlan) continue;
    if (i.status === "sent" && (ago(i.sent_at) ?? 99) > 21) continue;
    w.push({ kind: i.status === "sent" ? "recent_send" : "open_outreach", text: i.status === "sent" ? `A ${R.CHANNEL_LABEL[i.channel as R.Channel]} was sent ${ago(i.sent_at)} day(s) ago${i.assigned_user_id === userId ? " by you" : " by a colleague"}.` : `There is already a ${i.status.replace("_", " ")} ${R.CHANNEL_LABEL[i.channel as R.Channel]}${i.assigned_user_id === userId ? " (yours)" : " by a colleague"}.`, by: i.assigned_user_id, date: i.sent_at ?? i.updated_at, itemId: i.id });
  }
  const { data: links } = await db.from("interaction_link").select("interaction:interaction_id(occurred_at, channel, owner_user_id)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).limit(50);
  for (const l of (links ?? []) as Row[]) {
    const i = l.interaction; if (!i || (ago(i.occurred_at) ?? 99) > 14) continue;
    w.push({ kind: "recent_interaction", text: `${i.owner_user_id === userId ? "You" : "A colleague"} had a ${i.channel} with this person on ${i.occurred_at.slice(0, 10)}.`, by: i.owner_user_id, date: i.occurred_at });
  }
  const { data: drafts } = await db.from("draft").select("id, state, channel, owner_user_id").eq("workspace_id", ws).eq("recipient_person_id", personId).in("state", ["drafted", "approved", "opened_for_send"]).is("archived_at", null).limit(10);
  const known = new Set(((items ?? []) as Row[]).map((i) => i.id));
  if ((drafts ?? []).length && !known.size) w.push({ kind: "other_draft", text: `${drafts!.length} other draft message(s) to this person exist in Drafts.` });
  return w;
}

const Gen = z.object({
  subject: z.string().nullable(), body: z.string(),
  value_prop: z.string(), assumptions: z.array(z.string()),
  questions: z.array(z.string()), opening_alternatives: z.array(z.string()), cta_alternatives: z.array(z.string()),
  call_script: z.object({ opener: z.string(), reason: z.string(), questions: z.array(z.string()), objections: z.array(z.object({ objection: z.string(), reply: z.string() })), close: z.string() }).nullable(),
  forwardable: z.string().nullable(),
});
type GenOut = z.infer<typeof Gen>;
type Ai = typeof callStructured;

const SYSTEM = `You draft professional outreach for a commercial-real-estate (office space) adviser in Pune, India.
Rules: use ONLY the facts provided. Never invent previous conversations, relationships, announcements, lease details, availability, commitments or contact details.
Reported signals must be described as reported ("I noticed reports that…"), never as confirmed needs. Never claim the company needs space — use the event as a reason to ask.
No generic lines ("leading consultancy", "hope you are doing well" alone). One specific reason, one value, one question. Respect the relationship level: don't imply familiarity that doesn't exist.
Put anything you had to assume into "assumptions". Use [placeholders] for anything unknown. Write in the requested language (en = English; hi = Hindi in Devanagari; hinglish = Hindi in Latin script mixed with English).`;

async function styleNotes(db: Db, ws: string, userId: string, channel: string): Promise<string> {
  const { data } = await db.from("outreach_version").select("body, item:item_id(channel)").eq("workspace_id", ws).eq("learn", true).eq("owner_user_id", userId).order("created_at", { ascending: false }).limit(10);
  const mine = ((data ?? []) as Row[]).filter((v) => v.item?.channel === channel).slice(0, 2);
  return mine.length ? `\nThe user approved these as examples of their style (match tone and length, not content):\n${mine.map((v) => `---\n${String(v.body).slice(0, 600)}`).join("\n")}` : "";
}

async function generate(db: Db, ws: string, userId: string, c: Context, a: { channel: R.Channel; scenario: R.Scenario; reason: string; lang: R.Lang; via?: Row | null; sender: string; instruction?: string; current?: { subject: string | null; body: string } }, ai: Ai): Promise<{ out: GenOut; mocked: boolean }> {
  const tpl = R.templateDraft({ channel: a.channel, scenario: a.scenario, first: c.first, company: c.org?.display_name ?? "your company", level: c.level, reason: a.reason, roleKey: c.roleKey, sender: a.sender, via: a.via?.full_name?.split(/\s+/)[0] ?? null, lang: a.lang });
  const focus = R.ROLE_FOCUS[c.roleKey] ?? R.ROLE_FOCUS.other;
  const input = [
    `Channel: ${R.CHANNEL_LABEL[a.channel]}. ${R.LENGTH_HINT[a.channel]}`,
    `Scenario: ${R.SCENARIOS[a.scenario].label}. Suggested value: ${R.SCENARIOS[a.scenario].value}`,
    `Recipient: ${c.person.full_name}, ${c.title ?? "designation unknown"}, ${c.org?.display_name ?? "company unknown"}. Role focus (${focus.label}): ${focus.focus.join(", ")}. Decision role: ${c.roleClass ?? "unknown — do not assume authority"}.`,
    `Relationship: ${R.LEVEL_LABEL[c.level]}.`,
    `Reason to contact now: ${a.reason}.`,
    `Facts you may use:\n${c.facts.map((f) => `- ${f.text}`).join("\n") || "- (none beyond the reason)"}`,
    `Unknown (do not state): ${c.unknowns.join(", ") || "—"}.`,
    a.via ? `Introduction via: ${a.via.full_name}. Write the request TO them and a short forwardable blurb. Do not imply they agreed.` : "",
    `Sender name: ${a.sender}. Language: ${a.lang}.`,
    a.current ? `Rewrite this draft — instruction: ${a.instruction}\nSubject: ${a.current.subject ?? ""}\n${a.current.body}` : `Suggest up to 3 discovery questions from: ${R.SCENARIOS[a.scenario].questions.join(" | ")}`,
  ].filter(Boolean).join("\n\n") + await styleNotes(db, ws, userId, a.channel);
  const mock = (): GenOut => a.current ? mockEdit(a.current, a.instruction ?? "", tpl) : { ...tpl, value_prop: R.SCENARIOS[a.scenario].value, assumptions: c.unknowns.map((u) => `Unknown: ${u}`), questions: R.SCENARIOS[a.scenario].questions.slice(0, 3) };
  const r = await ai({ workspaceId: ws, workflow: "outreach.draft", tier: "luna", system: SYSTEM, input, schema: Gen, schemaName: "outreach_draft", maxOutputTokens: 1800, classification: "corporate_confidential", mock });
  const out = r.data;
  if (a.channel !== "email" && a.channel !== "meeting_followup" && a.channel !== "introduction") out.subject = null;
  return { out, mocked: r.mocked };
}

/** Offline edits so the editor works without an AI key. */
function mockEdit(cur: { subject: string | null; body: string }, op: string, tpl: R.DraftOut): GenOut {
  let body = cur.body;
  const o = op.toLowerCase();
  if (o.startsWith("shorten")) body = body.split(/(?<=[.?!])\s+/).filter((s, i, a) => i === 0 || i >= a.length - 2).join(" ");
  else if (o.startsWith("expand")) body = `${body}\n\nHappy to share a short comparison of options and recent transactions in the area if useful.`;
  else if (o.includes("less sales") || o.includes("reduce")) body = body.replace(/Would a 15-minute call[^?]*\?/, "No pressure at all — happy to share a view whenever useful.");
  else if (o.includes("hinglish")) body = `Hi! ${body.replace(/^Hi [^,]+,\s*/, "")} Aapke liye ek quick call set kar sakte hain?`;
  else if (o.includes("hindi")) body = `नमस्ते, ${body}`;
  return { subject: cur.subject, body, value_prop: "", assumptions: [], questions: [], opening_alternatives: tpl.opening_alternatives, cta_alternatives: tpl.cta_alternatives, call_script: tpl.call_script, forwardable: tpl.forwardable };
}

async function event(db: Db, ws: string, itemId: string, ev: string, userId: string | null, detail: Row = {}) {
  await db.from("outreach_event").insert({ workspace_id: ws, item_id: itemId, event: ev, actor_user_id: userId, detail, owner_user_id: userId });
}
async function version(db: Db, ws: string, itemId: string, kind: string, subject: string | null, body: string, userId: string, op?: string) {
  const { data: last } = await db.from("outreach_version").select("version").eq("item_id", itemId).order("version", { ascending: false }).limit(1).maybeSingle();
  await db.from("outreach_version").insert({ workspace_id: ws, item_id: itemId, version: (last?.version ?? 0) + 1, kind, op: op ?? null, subject, body, owner_user_id: userId });
}
export async function senderName(db: Db, ws: string): Promise<string> {
  const { data } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", "outreach").maybeSingle();
  return (data?.value as Row)?.sender_name ?? "[Your name]";
}

export interface CreateInput { personId: string; channels: R.Channel[]; scenario?: R.Scenario; signalId?: string | null; opportunityId?: string | null; language?: R.Lang; viaPersonId?: string | null; plannedOn?: string; ai?: Ai }
/** Create a conversation plan: one item per chosen channel (e.g. email + WhatsApp alternative), all step 1. */
export async function createOutreach(db: Db, ws: string, userId: string, inp: CreateInput) {
  const ai = inp.ai ?? callStructured;
  const t0 = Date.now();
  const c = await buildContext(db, ws, inp.personId, { signalId: inp.signalId, opportunityId: inp.opportunityId });
  if (c.blocked.all) throw new OutreachError(`Can't prepare outreach: ${c.blocked.all}.`);
  if (c.level === "not_interested") throw new OutreachError("This person said they're not interested. Respect that — record a new reason in Capture before reaching out again.");
  const sig = c.signals.find((s) => s.id === inp.signalId) ?? null;
  const scenario = inp.scenario ?? (sig ? R.scenarioFor(sig) : c.leaseEvents.length ? "lease_renewal" : "reconnect");
  const reason = reasonFor(c, scenario, inp.signalId);
  const warnings = await duplicateCheck(db, ws, inp.personId, userId);
  const via = inp.viaPersonId ? (await db.from("person").select("id, full_name, contact_method(method_type, value, suppressed)").eq("workspace_id", ws).eq("id", inp.viaPersonId).maybeSingle()).data : null;
  const sender = await senderName(db, ws);
  const planKey = `p:${inp.personId}:${Date.now().toString(36)}`;
  const ids: string[] = []; let mocked = false;
  for (const ch of [...new Set(inp.channels)]) {
    const dch = R.draftChannel(ch);
    const block = dch && dch !== "introduction" ? c.blocked[dch] : null;
    if (block) { warnings.push({ kind: "suppressed", text: `${R.CHANNEL_LABEL[ch]} skipped: ${block}.` }); continue; }
    if (ch === "introduction" && !via) throw new OutreachError("Pick who should make the introduction.");
    const g = await generate(db, ws, userId, c, { channel: ch, scenario, reason, lang: inp.language ?? "en", via, sender }, ai);
    mocked ||= g.mocked;
    const addr = ch === "email" || ch === "meeting_followup" ? c.channels.email : ch === "whatsapp" ? c.channels.phone : ch === "linkedin" ? c.channels.linkedin
      : ch === "introduction" ? ((via?.contact_method ?? []) as Row[]).find((m) => !m.suppressed && m.method_type === "email")?.value ?? null : null;
    let draftId: string | null = null;
    if (dch) {
      const d = await createDraft(db, ws, { channel: dch, recipientPersonId: ch === "introduction" ? via!.id : inp.personId, recipientDisplay: ch === "introduction" ? via!.full_name : c.person.full_name, recipientAddress: addr, subject: g.out.subject, body: g.out.body, orgId: c.org?.id ?? null, opportunityId: c.opportunity?.id ?? null, purpose: `outreach:${scenario}`, sequenceKey: planKey, sequenceStep: 1, createdByKind: "model", ownerUserId: userId });
      draftId = d.id;
    }
    const { data: item, error } = await db.from("outreach_item").insert({
      workspace_id: ws, person_id: inp.personId, org_id: c.org?.id ?? null, opportunity_id: c.opportunity?.id ?? null, requirement_id: c.requirement?.id ?? null, signal_id: sig?.id ?? null,
      plan_key: planKey, step: 1, scenario, channel: ch, reason, value_prop: g.out.value_prop || R.SCENARIOS[scenario].value, facts: c.facts, assumptions: g.out.assumptions, questions: g.out.questions.slice(0, 4),
      script: { call: g.out.call_script, forwardable: g.out.forwardable, openings: g.out.opening_alternatives, ctas: g.out.cta_alternatives, warnings },
      draft_id: draftId, language: inp.language ?? "en", status: "draft", assigned_user_id: userId, planned_on: inp.plannedOn ?? today(), intro_via_person_id: via?.id ?? null, owner_user_id: userId, prep_seconds: Math.round((Date.now() - t0) / 1000),
    }).select("id").single();
    if (error) throw error;
    ids.push(item.id);
    await version(db, ws, item.id, "generated", g.out.subject, g.out.body, userId);
    await event(db, ws, item.id, "drafted", userId, { scenario, reason, warnings: warnings.length, mocked: g.mocked });
  }
  if (!ids.length) throw new OutreachError(warnings.map((w) => w.text).join(" ") || "No channel available.");
  return { ids, planKey, warnings, mocked };
}

async function loadItem(db: Db, ws: string, id: string) {
  const { data } = await db.from("outreach_item").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!data) throw new OutreachError("Outreach not found.");
  return data as Row;
}

/** Manual edit → new immutable version; any earlier approval is invalidated (the DB guard drops it on content change). */
export async function editItem(db: Db, ws: string, userId: string, id: string, e: { subject?: string | null; body: string; recipientAddress?: string | null; learn?: boolean }, kind: "user_edit" | "ai_edit" = "user_edit", op?: string) {
  const it = await loadItem(db, ws, id);
  if (!it.draft_id) throw new OutreachError("Call scripts are edited in the script panel.");
  if (["sent", "replied", "meeting", "declined", "closed"].includes(it.status)) throw new OutreachError("Already sent — create a follow-up instead.");
  const before = await getDraft(db, ws, it.draft_id);
  const patch: Row = { body: e.body };
  if (e.subject !== undefined) patch.subject = e.subject;
  if (e.recipientAddress !== undefined) patch.recipientAddress = e.recipientAddress;
  const after = (await updateDraft(db, ws, it.draft_id, patch, { actorUserId: userId })).draft;
  await version(db, ws, id, kind, after.subject, after.body, userId, op);
  if (e.learn) await db.from("outreach_version").update({ learn: true }).eq("item_id", id).eq("body", after.body);
  const invalidated = before.approved_hash && before.content_hash !== after.content_hash;
  if (["pending_approval", "approved"].includes(it.status) || invalidated) {
    await db.from("outreach_item").update({ status: "draft" }).eq("id", id);
    await event(db, ws, id, "approval_invalidated", userId, { reason: e.recipientAddress !== undefined && e.recipientAddress !== before.recipient_address ? "recipient changed" : "content changed" });
  }
  await event(db, ws, id, "edited", userId, { kind, op: op ?? null });
  return after;
}

export const AI_OPS: Record<string, string> = {
  regenerate: "Write a fresh version with a different angle.", shorten: "Shorten: keep the reason and the question.", expand: "Expand slightly with one relevant, factual detail.",
  professional: "Make it more professional.", conversational: "Make it more conversational.", persuasive: "Make the value clearer and more persuasive, without pressure or invented claims.",
  less_sales: "Reduce sales pressure.", hindi: "Translate to Hindi (Devanagari).", hinglish: "Rewrite in natural Hinglish.", english: "Translate to English.",
  personalise: "Personalise further using only the listed facts.", trim: "Remove unnecessary information.",
};
export async function aiEdit(db: Db, ws: string, userId: string, id: string, op: string, ai: Ai = callStructured) {
  const it = await loadItem(db, ws, id);
  if (!it.draft_id) throw new OutreachError("Nothing to rewrite.");
  const d = await getDraft(db, ws, it.draft_id);
  const c = await buildContext(db, ws, it.person_id, { signalId: it.signal_id, opportunityId: it.opportunity_id });
  const via = it.intro_via_person_id ? (await db.from("person").select("id, full_name").eq("id", it.intro_via_person_id).maybeSingle()).data : null;
  const lang: R.Lang = op === "hindi" ? "hi" : op === "hinglish" ? "hinglish" : op === "english" ? "en" : it.language;
  const g = await generate(db, ws, userId, c, { channel: it.channel, scenario: it.scenario, reason: it.reason, lang, via, sender: await senderName(db, ws), instruction: AI_OPS[op] ?? op, current: op === "regenerate" ? undefined : { subject: d.subject, body: d.body } }, ai);
  if (lang !== it.language) await db.from("outreach_item").update({ language: lang }).eq("id", id);
  await db.from("outreach_item").update({ script: { ...(it.script ?? {}), openings: g.out.opening_alternatives, ctas: g.out.cta_alternatives } }).eq("id", id);
  return editItem(db, ws, userId, id, { subject: g.out.subject ?? d.subject, body: g.out.body }, "ai_edit", op);
}

export async function requestApproval(db: Db, ws: string, userId: string, id: string) {
  const it = await loadItem(db, ws, id);
  if (it.status !== "draft") throw new OutreachError("Only drafts can be sent for approval.");
  await db.from("outreach_item").update({ status: "pending_approval" }).eq("id", id);
  await event(db, ws, id, "approval_requested", userId);
}

/** Approval binds to the exact recipient + content + attachments the approver reviewed (reviewedHash). */
export async function approve(db: Db, ws: string, userId: string, id: string, reviewedHash: string) {
  const it = await loadItem(db, ws, id);
  if (!["draft", "pending_approval"].includes(it.status)) throw new OutreachError("Nothing to approve.");
  if (it.draft_id) await approveDraft(db, ws, it.draft_id, userId, { reviewedHash });
  await db.from("outreach_item").update({ status: "approved" }).eq("id", id);
  await event(db, ws, id, "approved", userId, { hash: reviewedHash });
}

export async function reject(db: Db, ws: string, userId: string, id: string, note: string) {
  await loadItem(db, ws, id);
  await db.from("outreach_item").update({ status: "draft" }).eq("id", id);
  await event(db, ws, id, "approval_rejected", userId, { note });
}

/** Hand-off: confirm exact recipient & content (hash), re-check suppression, return the link to the user's own app. */
export async function openForSend(db: Db, ws: string, userId: string, id: string, confirmedHash: string) {
  const it = await loadItem(db, ws, id);
  if (it.status !== "approved") throw new OutreachError("Approve it first.");
  const d = await getDraft(db, ws, it.draft_id);
  if (d.content_hash !== confirmedHash) throw new OutreachError("The message or recipient changed after you confirmed — review it again.");
  const r = await openDraftForSend(db, ws, it.draft_id, userId).catch(async (e) => {
    if (e instanceof SuppressedRecipientError) { await db.from("outreach_item").update({ status: "paused", pause_reason: "Recipient became suppressed" }).eq("id", id); await event(db, ws, id, "paused", userId, { reason: "suppressed at hand-off" }); }
    throw e;
  });
  await event(db, ws, id, "opened_for_send", userId);
  return r;
}

/** User says "I sent it" (or a provider observed it). Records the interaction and plans ONE next follow-up. Idempotent. */
export async function markSent(db: Db, ws: string, userId: string, id: string, opts: { evidence?: string; providerMessageId?: string } = {}) {
  const it = await loadItem(db, ws, id);
  if (it.sent_at) return { already: true };
  if (it.channel === "call") { if (!["draft", "approved", "pending_approval"].includes(it.status)) throw new OutreachError("Not ready."); }
  else {
    if (it.status !== "approved") throw new OutreachError("Only approved messages can be marked sent.");
    await markDraftSent(db, ws, it.draft_id, userId);
  }
  const now = new Date().toISOString();
  const evidence = opts.providerMessageId ? `provider:${opts.providerMessageId}` : "user_assertion";
  const d = it.draft_id ? await getDraft(db, ws, it.draft_id) : null;
  const ich = it.channel === "meeting_followup" || it.channel === "introduction" ? "email" : it.channel;
  const prevI = (await db.from("interaction").select("id").eq("workspace_id", ws).eq("source_message_id", `outreach:${id}`).maybeSingle()).data;
  const { data: inter, error } = prevI ? { data: prevI, error: null } : await db.from("interaction").insert({ workspace_id: ws, occurred_at: now, channel: ich, direction: "outbound", subject: d?.subject ?? `${R.CHANNEL_LABEL[it.channel as R.Channel]}: ${R.SCENARIOS[it.scenario as R.Scenario].label}`, summary: (d?.body ?? it.reason).slice(0, 500), source_message_id: `outreach:${id}`, opportunity_id: it.opportunity_id, owner_user_id: userId }).select("id").single();
  if (error) throw error;
  await db.from("interaction_link").insert([
    { workspace_id: ws, interaction_id: inter.id, entity_type: "person", entity_id: it.intro_via_person_id ?? it.person_id, role: "to" },
    ...(it.org_id ? [{ workspace_id: ws, interaction_id: inter.id, entity_type: "organisation", entity_id: it.org_id, role: "mentioned" }] : []),
  ]);
  await db.from("outreach_item").update({ status: "sent", sent_at: now, sent_evidence: evidence }).eq("id", id);
  await event(db, ws, id, opts.providerMessageId ? "sent_provider" : "sent_manual", userId, { evidence });
  // Pause sibling channel alternatives of the same step (one message per step is enough).
  await db.from("outreach_item").update({ status: "paused", pause_reason: "Another channel was used for this step" }).eq("workspace_id", ws).eq("plan_key", it.plan_key).eq("step", it.step).neq("id", id).in("status", OPEN);
  const gap = R.nextFollowupDays(it.step);
  const nextCh = it.channel === "call" ? "email" : it.channel;
  const exists = (await db.from("outreach_item").select("id").eq("workspace_id", ws).eq("plan_key", it.plan_key).eq("step", it.step + 1).eq("channel", nextCh).is("archived_at", null).limit(1)).data?.length;
  if (gap !== null && !exists && it.channel !== "introduction" && it.channel !== "meeting_followup") {
    await db.from("outreach_item").insert({ workspace_id: ws, person_id: it.person_id, org_id: it.org_id, opportunity_id: it.opportunity_id, requirement_id: it.requirement_id, signal_id: it.signal_id, plan_key: it.plan_key, step: it.step + 1, scenario: it.scenario, channel: nextCh,
      reason: it.step + 1 >= 4 ? "Reassess: is another follow-up appropriate, or should this pause?" : it.step + 1 === 3 ? "Share a useful market insight or a relevant comparison" : `Follow-up on the ${R.CHANNEL_LABEL[it.channel as R.Channel]} sent ${now.slice(0, 10)}`,
      value_prop: it.value_prop, facts: it.facts, questions: it.questions, status: "planned", planned_on: addDays(today(), gap), assigned_user_id: it.assigned_user_id, language: it.language, owner_user_id: it.owner_user_id ?? userId });
  }
  return { already: false, interactionId: inter.id };
}

/** Turn a planned follow-up into a real draft (generated only when the user opens it — never automatically). */
export async function prepareFollowup(db: Db, ws: string, userId: string, id: string, ai: Ai = callStructured) {
  const it = await loadItem(db, ws, id);
  if (it.status !== "planned") throw new OutreachError("Already prepared.");
  const reason = await sweepOne(db, ws, it);
  if (reason) throw new OutreachError(`Paused: ${reason}.`);
  const c = await buildContext(db, ws, it.person_id, { signalId: it.signal_id, opportunityId: it.opportunity_id });
  const g = await generate(db, ws, userId, c, { channel: it.channel, scenario: it.scenario, reason: it.reason, lang: it.language, sender: await senderName(db, ws) }, ai);
  const addr = it.channel === "whatsapp" ? c.channels.phone : it.channel === "linkedin" ? c.channels.linkedin : c.channels.email;
  const d = await createDraft(db, ws, { channel: R.draftChannel(it.channel)!, recipientPersonId: it.person_id, recipientDisplay: c.person.full_name, recipientAddress: addr, subject: g.out.subject, body: g.out.body, orgId: it.org_id, opportunityId: it.opportunity_id, purpose: `outreach:${it.scenario}:followup`, sequenceKey: it.plan_key, sequenceStep: it.step, createdByKind: "model", ownerUserId: userId });
  await db.from("outreach_item").update({ draft_id: d.id, status: "draft", script: { openings: g.out.opening_alternatives, ctas: g.out.cta_alternatives } }).eq("id", id);
  await version(db, ws, id, "generated", g.out.subject, g.out.body, userId);
  await event(db, ws, id, "drafted", userId, { followup: true });
}

/** Re-evaluate one open/planned item against the pause rules. Returns the reason if paused. */
async function sweepOne(db: Db, ws: string, it: Row): Promise<string | null> {
  const { data: p } = await db.from("person").select("do_not_contact").eq("id", it.person_id).maybeSingle();
  const { data: first } = await db.from("outreach_item").select("sent_at").eq("workspace_id", ws).eq("plan_key", it.plan_key).not("sent_at", "is", null).order("sent_at").limit(1).maybeSingle();
  const since = first?.sent_at ?? it.created_at;
  const { data: links } = await db.from("interaction_link").select("interaction:interaction_id(occurred_at, direction, channel, owner_user_id, source_message_id, objections)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", it.person_id).limit(100);
  const after = ((links ?? []) as Row[]).map((l) => l.interaction).filter((i) => i && i.occurred_at > since);
  const { data: opp } = it.opportunity_id ? await db.from("opportunity").select("stage, outcome").eq("id", it.opportunity_id).maybeSingle() : { data: null };
  const { data: mtg } = await db.from("meeting_visit").select("id").eq("workspace_id", ws).eq("linked_entity_type", "person").eq("linked_entity_id", it.person_id).gte("start_at", new Date().toISOString()).neq("status", "cancelled").limit(1);
  const ch = R.draftChannel(it.channel);
  const reason = R.pauseReason({
    doNotContact: !!p?.do_not_contact, suppressed: ch ? !!(await suppressedFor(db, ws, it.person_id, ch)) : false,
    replied: after.some((i) => i.direction === "inbound"), meetingScheduled: !!mtg?.length,
    objection: after.some((i) => (i.objections ?? []).length), declined: false,
    colleagueContactedSince: after.some((i) => i.direction === "outbound" && i.owner_user_id !== it.assigned_user_id && !String(i.source_message_id ?? "").startsWith(`outreach:`)),
    opportunityStage: opp?.stage, opportunityOutcome: opp?.outcome,
  });
  if (reason) {
    await db.from("outreach_item").update({ status: "paused", pause_reason: reason }).eq("id", it.id);
    if (it.draft_id) await setDraftPaused(db, ws, it.draft_id, true, reason).catch(() => null);
    await event(db, ws, it.id, "paused", null, { reason, auto: true });
  }
  return reason;
}
/** Daily job + on-demand: never let a sequence continue just because its date arrived. */
export async function sweep(db: Db, ws: string) {
  const { data } = await db.from("outreach_item").select("*").eq("workspace_id", ws).is("archived_at", null).in("status", ["planned", "draft", "pending_approval", "approved"]).limit(500);
  let paused = 0;
  for (const it of (data ?? []) as Row[]) if (await sweepOne(db, ws, it)) paused++;
  return { checked: (data ?? []).length, paused };
}

export async function pauseItem(db: Db, ws: string, userId: string, id: string, reason: string) {
  const it = await loadItem(db, ws, id);
  await db.from("outreach_item").update({ status: "paused", pause_reason: reason || "Paused by user" }).eq("id", id);
  if (it.draft_id) await setDraftPaused(db, ws, it.draft_id, true, reason || "paused", userId).catch(() => null);
  await event(db, ws, id, "paused", userId, { reason });
}
export async function resumeItem(db: Db, ws: string, userId: string, id: string) {
  const it = await loadItem(db, ws, id);
  if (it.status !== "paused") return;
  const c = await buildContext(db, ws, it.person_id);
  if (c.blocked.all) throw new OutreachError(`Can't resume: ${c.blocked.all}.`);
  if (it.draft_id) await setDraftPaused(db, ws, it.draft_id, false, null, userId).catch(() => null);
  await db.from("outreach_item").update({ status: it.draft_id ? "draft" : "planned", pause_reason: null }).eq("id", id);
  await event(db, ws, id, "resumed", userId);
}

const Resp = z.object({
  outcome: z.enum(["interested", "meeting_scheduled", "info_requested", "not_now", "objection", "declined", "do_not_contact", "other"]),
  summary: z.string(), objection: z.string().nullable(),
  commitments: z.array(z.object({ who: z.enum(["us", "them"]), what: z.string(), due: z.string().nullable() })),
  next_action: z.string(), next_action_days: z.number().int().nullable(),
  crm_updates: z.array(z.object({ field: z.enum(["next_action", "stage"]), value: z.string(), reason: z.string() })),
});
/** Spec §13: a reply improves the record — interaction, commitments → tasks, proposed CRM updates, pause outdated follow-ups. */
export async function recordResponse(db: Db, ws: string, userId: string, id: string, text: string, ai: Ai = callStructured) {
  const it = await loadItem(db, ws, id);
  if (!text.trim()) throw new OutreachError("Paste or type the reply.");
  const r = await ai({ workspaceId: ws, workflow: "outreach.response", tier: "luna", schema: Resp, schemaName: "outreach_response", maxOutputTokens: 900,
    system: "Classify a reply to a commercial real-estate outreach message. Extract only what the reply says. Dates as YYYY-MM-DD only if stated. 'stage' updates may only be one of: engaged, qualified_discussion.",
    input: `Our message reason: ${it.reason}. Opportunity: ${it.opportunity_id ? "linked" : "none"}.`, evidence: text,
    mock: () => {
      const t = text.toLowerCase();
      const outcome = /do not contact|unsubscribe|stop messag/.test(t) ? "do_not_contact" : /not interested|no thanks|no need/.test(t) ? "declined" : /meet|call on|tuesday|monday|wednesday|thursday|friday|tomorrow/.test(t) ? "meeting_scheduled" : /send|share|details|brochure/.test(t) ? "info_requested" : /later|next quarter|not now/.test(t) ? "not_now" : "interested";
      return { outcome: outcome as z.infer<typeof Resp>["outcome"], summary: text.slice(0, 200), objection: outcome === "declined" ? text.slice(0, 120) : null,
        commitments: outcome === "info_requested" ? [{ who: "us" as const, what: "Send the requested details", due: null }] : outcome === "meeting_scheduled" ? [{ who: "us" as const, what: "Prepare for the meeting", due: null }] : [],
        next_action: outcome === "declined" || outcome === "do_not_contact" ? "Close this conversation" : outcome === "not_now" ? "Check back later" : "Reply and confirm next step", next_action_days: outcome === "not_now" ? 60 : 2,
        crm_updates: outcome === "meeting_scheduled" || outcome === "interested" ? [{ field: "stage" as const, value: "engaged", reason: "Prospect replied positively to outreach" }] : [] };
    } });
  const x = r.data;
  const now = new Date().toISOString();
  const { data: inter, error } = await db.from("interaction").insert({ workspace_id: ws, occurred_at: now, channel: it.channel === "whatsapp" ? "whatsapp" : it.channel === "linkedin" ? "linkedin" : it.channel === "call" ? "call" : "email", direction: "inbound", subject: "Reply to outreach", summary: x.summary, promises: x.commitments, objections: x.objection ? [{ text: x.objection, outcome: x.outcome }] : [], opportunity_id: it.opportunity_id, is_meaningful: !["other"].includes(x.outcome), owner_user_id: userId }).select("id").single();
  if (error) throw error;
  await db.from("interaction_link").insert([{ workspace_id: ws, interaction_id: inter.id, entity_type: "person", entity_id: it.person_id, role: "from" }, ...(it.org_id ? [{ workspace_id: ws, interaction_id: inter.id, entity_type: "organisation", entity_id: it.org_id, role: "mentioned" }] : [])]);
  const status = x.outcome === "meeting_scheduled" ? "meeting" : x.outcome === "declined" || x.outcome === "do_not_contact" ? "declined" : "replied";
  await db.from("outreach_item").update({ status, responded_at: now, response: { ...x, text: text.slice(0, 4000), interaction_id: inter.id } }).eq("id", id);
  await event(db, ws, id, x.outcome === "meeting_scheduled" ? "meeting" : status === "declined" ? "declined" : "response", userId, { outcome: x.outcome });
  // pause every other open/planned item for this person (outdated follow-ups)
  const { data: open } = await db.from("outreach_item").select("id, draft_id").eq("workspace_id", ws).eq("person_id", it.person_id).in("status", OPEN).neq("id", id);
  for (const o of (open ?? []) as Row[]) {
    await db.from("outreach_item").update({ status: "paused", pause_reason: status === "declined" ? "Recipient declined" : "A reply was received" }).eq("id", o.id);
    if (o.draft_id) await setDraftPaused(db, ws, o.draft_id, true, "reply received", userId).catch(() => null);
    await event(db, ws, o.id, "paused", userId, { reason: "reply received", auto: true });
  }
  if (x.outcome === "do_not_contact") await db.from("person").update({ do_not_contact: true }).eq("workspace_id", ws).eq("id", it.person_id);
  const tasks: string[] = [];
  for (const [i, cmt] of x.commitments.entries()) {
    if (cmt.who !== "us") continue;
    const key = `outreach:${id}:${i}`;
    if ((await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).limit(1)).data?.length) continue;
    const { data: t } = await db.from("task").insert({ workspace_id: ws, title: cmt.what.slice(0, 200), due_at: cmt.due && /^\d{4}-\d{2}-\d{2}$/.test(cmt.due) ? `${cmt.due}T09:00:00+05:30` : `${addDays(today(), x.next_action_days ?? 2)}T09:00:00+05:30`, assigned_user_id: userId, linked_entity_type: "person", linked_entity_id: it.person_id, source: "outreach", idempotency_key: key, owner_user_id: userId }).select("id").maybeSingle();
    if (t) tasks.push(t.id);
  }
  const proposals: string[] = [];
  if (it.opportunity_id) {
    for (const u of x.crm_updates) {
      if (u.field === "stage" && !["engaged", "qualified_discussion"].includes(u.value)) continue;
      const p = await proposeChange(db, ws, { targetType: "opportunity", targetId: it.opportunity_id, patch: [{ op: "replace", path: `/${u.field}`, value: u.value }], reason: `Outreach reply: ${u.reason}`, proposedByKind: "model", idempotencyKey: `outreach:${id}:${u.field}`, ownerUserId: userId }).catch(() => null);
      if (p) proposals.push((p as Row).id ?? "");
    }
  }
  return { outcome: x.outcome, status, tasks, proposals, mocked: r.mocked, nextAction: x.next_action };
}

export async function closeItem(db: Db, ws: string, userId: string, id: string, outcome: "no_response" | "closed") {
  await loadItem(db, ws, id);
  await db.from("outreach_item").update({ status: outcome }).eq("id", id);
  await event(db, ws, id, outcome, userId);
}

export interface Suggestion { personId: string; name: string; title: string | null; orgId: string; org: string; reason: string; scenario: R.Scenario; signalId: string | null; score: number | null; relevance: string | null; why: string[] }
/** "Here are today's five conversations to start": new reasons (signals, lease events) × best contact, ranked by lead score. */
export async function suggestions(db: Db, ws: string, limit = 5): Promise<Suggestion[]> {
  const since = addDays(today(), -45);
  const [{ data: sig }, { data: ev }] = await Promise.all([
    db.from("signal").select("id, org_id, title, category, kind, verification, confidence, latest_evidence_on, detected_at").eq("workspace_id", ws).not("org_id", "is", null).not("status", "in", "(rejected,dismissed,snoozed)").gte("detected_at", since).order("detected_at", { ascending: false }).limit(200),
    db.from("lease_event").select("id, event_type, event_date, lease:lease_id(tenant_org_id)").eq("workspace_id", ws).in("event_type", ["expiry", "notice_deadline", "lockin_end", "break"]).gte("event_date", today()).lte("event_date", addDays(today(), 365)).order("event_date").limit(200),
  ]);
  const byOrg = new Map<string, { reason: string; scenario: R.Scenario; signalId: string | null; why: string[] }>();
  for (const s of (sig ?? []) as Row[]) if (!byOrg.has(s.org_id)) byOrg.set(s.org_id, { reason: s.title, scenario: R.scenarioFor(s), signalId: s.id, why: [`Signal: ${s.title} (${s.verification === "fact" ? "confirmed" : "reported"})`] });
  for (const e of (ev ?? []) as Row[]) { const o = e.lease?.tenant_org_id; if (!o) continue; const cur = byOrg.get(o); const w = `Lease ${e.event_type.replace(/_/g, " ")} on ${e.event_date}`; if (cur) cur.why.push(w); else byOrg.set(o, { reason: w, scenario: "lease_renewal", signalId: null, why: [w] }); }
  const orgIds = [...byOrg.keys()].slice(0, 150);
  if (!orgIds.length) return [];
  const [{ data: orgs }, { data: emp }, { data: scores }, { data: busy }] = await Promise.all([
    db.from("organisation").select("id, display_name").in("id", orgIds),
    db.from("employment").select("person_id, title, org_id, person:person_id(id, full_name, do_not_contact, archived_at, contact_role_assessment(role_class, cre_relevance, active))").eq("workspace_id", ws).eq("is_current", true).in("org_id", orgIds).limit(2000),
    db.from("score_result").select("entity_id, score").eq("workspace_id", ws).eq("model_key", "lead").eq("is_current", true).in("entity_id", orgIds),
    db.from("outreach_item").select("person_id, org_id, status, sent_at, updated_at").eq("workspace_id", ws).is("archived_at", null).gte("updated_at", addDays(today(), -21)),
  ]);
  const busyP = new Set(((busy ?? []) as Row[]).filter((b) => [...OPEN, "sent", "replied", "meeting"].includes(b.status)).map((b) => b.person_id));
  const busyO = new Set(((busy ?? []) as Row[]).filter((b) => OPEN.includes(b.status)).map((b) => b.org_id));
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const out: Suggestion[] = [];
  for (const oid of orgIds) {
    if (busyO.has(oid)) continue;
    const people = ((emp ?? []) as Row[]).filter((e) => e.org_id === oid && e.person && !e.person.do_not_contact && !e.person.archived_at && !busyP.has(e.person_id))
      .map((e) => ({ e, ra: (e.person.contact_role_assessment ?? []).find((x: Row) => x.active) ?? null }))
      .filter((x) => !x.ra || x.ra.cre_relevance !== "none")
      .sort((a, b) => (rank[a.ra?.cre_relevance ?? "x"] ?? 3) - (rank[b.ra?.cre_relevance ?? "x"] ?? 3));
    const best = people[0]; if (!best) continue;
    const r = byOrg.get(oid)!;
    out.push({ personId: best.e.person_id, name: best.e.person.full_name, title: best.e.title, orgId: oid, org: ((orgs ?? []) as Row[]).find((o) => o.id === oid)?.display_name ?? "", reason: r.reason, scenario: r.scenario, signalId: r.signalId, score: ((scores ?? []) as Row[]).find((s) => s.entity_id === oid)?.score ?? null, relevance: best.ra?.cre_relevance ?? null, why: r.why.slice(0, 3) });
  }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (rank[a.relevance ?? "x"] ?? 3) - (rank[b.relevance ?? "x"] ?? 3)).slice(0, limit);
}

/** Spec §15: introduction paths from relationship_edge — who can introduce the user to the target. Never assumes consent. */
export async function warmPaths(db: Db, ws: string, userId: string, targetPersonId: string) {
  const { data: toT } = await db.from("relationship_edge").select("from_person_id, edge_type, warmth, intro_permission, last_meaningful_contact, from_person:from_person_id(full_name)").eq("workspace_id", ws).eq("to_person_id", targetPersonId).not("from_person_id", "is", null).is("archived_at", null);
  const mids = ((toT ?? []) as Row[]).map((e) => e.from_person_id);
  if (!mids.length) return [];
  const { data: mine } = await db.from("relationship_edge").select("to_person_id, warmth, edge_type").eq("workspace_id", ws).eq("from_user_id", userId).in("to_person_id", mids).is("archived_at", null);
  const W: Record<string, number> = { trusted: 4, hot: 3, warm: 2, cold: 1 };
  return ((toT ?? []) as Row[]).map((e) => {
    const m = ((mine ?? []) as Row[]).find((x) => x.to_person_id === e.from_person_id);
    const score = (W[e.warmth ?? "cold"] ?? 1) * 2 + (m ? W[m.warmth ?? "cold"] ?? 1 : 0) * 3 + (e.intro_permission ? 2 : 0);
    return { personId: e.from_person_id, name: e.from_person?.full_name ?? "", theirLink: `${e.edge_type}${e.warmth ? `, ${e.warmth}` : ""}`, yourLink: m ? `${m.edge_type}${m.warmth ? `, ${m.warmth}` : ""}` : "No recorded link to you", introPermission: !!e.intro_permission, score };
  }).sort((a, b) => b.score - a.score);
}

/** Business-useful analytics with explicit denominators (spec §18). Drafts never count as outreach. */
export async function analytics(db: Db, ws: string, days = 90) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data } = await db.from("outreach_item").select("id, person_id, org_id, status, sent_at, sent_evidence, responded_at, response, prep_seconds, created_at, opportunity_id").eq("workspace_id", ws).gte("created_at", since).limit(5000);
  const items = (data ?? []) as Row[];
  const sent = items.filter((i) => i.sent_at);
  const replied = sent.filter((i) => i.responded_at);
  const meaningful = replied.filter((i) => !["other"].includes(i.response?.outcome));
  const meetings = sent.filter((i) => i.status === "meeting" || i.response?.outcome === "meeting_scheduled");
  const { data: ev } = await db.from("outreach_event").select("event").eq("workspace_id", ws).gte("created_at", since).limit(10000);
  const n = (e: string) => ((ev ?? []) as Row[]).filter((x) => x.event === e).length;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  return {
    days, drafts: n("drafted"), approved: n("approved"), sentManual: sent.filter((i) => i.sent_evidence === "user_assertion").length, sentProvider: sent.filter((i) => String(i.sent_evidence).startsWith("provider:")).length,
    attempts: sent.length, contacts: new Set(sent.map((i) => i.person_id)).size, companies: new Set(sent.map((i) => i.org_id).filter(Boolean)).size,
    replies: replied.length, meaningful: meaningful.length, meetings: meetings.length, paused: items.filter((i) => i.status === "paused").length,
    replyRate: pct(replied.length, sent.length), meetingRate: pct(meetings.length, new Set(sent.map((i) => i.person_id)).size),
    prepMinutes: Math.round(items.reduce((a, i) => a + (i.prep_seconds ?? 0), 0) / 60),
  };
}

export async function detail(db: Db, ws: string, id: string) {
  const it = await loadItem(db, ws, id);
  const [d, versions, events, siblings, person] = await Promise.all([
    it.draft_id ? getDraft(db, ws, it.draft_id) : Promise.resolve(null),
    db.from("outreach_version").select("version, kind, op, subject, body, created_at, learn").eq("item_id", id).order("version", { ascending: false }).limit(30),
    db.from("outreach_event").select("event, detail, actor_user_id, created_at").eq("item_id", id).order("created_at", { ascending: false }).limit(50),
    db.from("outreach_item").select("id, step, channel, status, planned_on").eq("workspace_id", ws).eq("plan_key", it.plan_key).neq("id", id).order("step"),
    db.from("person").select("id, full_name").eq("id", it.person_id).maybeSingle(),
  ]);
  return { item: it, draft: d, versions: versions.data ?? [], events: events.data ?? [], siblings: siblings.data ?? [], person: person.data };
}
