import "server-only";
import { outreachRepetitionWarnings } from "@/modules/intelligence/memory/integrate/hooks";
import { learnFromDraftEdit } from "@/modules/assistant/engine/learn";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import { classifyReply, type ReplyClass } from "./reply-classifier";
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
const OOO_SUBJECT = "Out-of-office reply";

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
    blocked: await (async () => { if (all) return { all, email: all, whatsapp: all, linkedin: all }; const [e, w, l] = await Promise.all(["email", "whatsapp", "linkedin"].map((ch) => suppressedFor(db, ws, personId, ch))); return { all, email: e, whatsapp: w, linkedin: l }; })(),
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

export interface Warning { kind: string; text: string; by?: string | null; date?: string | null; itemId?: string | null; suggestion?: "follow_up_existing" }
/** "a"/"an" for a channel label or noun ("an email", "a WhatsApp"). */
export const withArticle = (w: string) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
/** Spec §14: warn (don't block) when someone else is already talking to this person. */
export async function duplicateCheck(db: Db, ws: string, personId: string, userId: string, excludePlan?: string): Promise<Warning[]> {
  const w: Warning[] = [];
  const { data: items } = await db.from("outreach_item").select("id, plan_key, status, channel, assigned_user_id, planned_on, sent_at, responded_at, updated_at").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).in("status", [...OPEN, "sent", "replied", "meeting"]).order("updated_at", { ascending: false }).limit(20);
  let thread: Row | null = null;   // most recent conversation that was actually sent (or answered)
  for (const i of (items ?? []) as Row[]) {
    if (excludePlan && i.plan_key === excludePlan) continue;
    const label = R.CHANNEL_LABEL[i.channel as R.Channel] ?? i.channel;
    if (["sent", "replied", "meeting"].includes(i.status)) {
      const when = i.responded_at ?? i.sent_at;
      if ((ago(when) ?? 99) > 21) continue;
      thread ??= i;
      w.push({ kind: i.status === "sent" ? "recent_send" : "recent_reply", text: i.status === "sent"
        ? `${withArticle(label).replace(/^a/, "A")} was sent ${ago(i.sent_at)} day(s) ago${i.assigned_user_id === userId ? " by you" : " by a colleague"}.`
        : `They replied ${ago(i.responded_at)} day(s) ago to ${withArticle(label)}${i.assigned_user_id === userId ? " you sent" : " a colleague sent"}.`, by: i.assigned_user_id, date: when, itemId: i.id });
      continue;
    }
    w.push({ kind: "open_outreach", text: `There is already ${withArticle(`${i.status.replace("_", " ")} ${label}`)}${i.assigned_user_id === userId ? " (yours)" : " by a colleague"}.`, by: i.assigned_user_id, date: i.updated_at, itemId: i.id });
  }
  const { data: links } = await db.from("interaction_link").select("interaction:interaction_id(occurred_at, channel, owner_user_id)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).limit(50);
  let recentInteraction = false;
  for (const l of (links ?? []) as Row[]) {
    const i = l.interaction; if (!i || (ago(i.occurred_at) ?? 99) > 14) continue;
    recentInteraction = true;
    w.push({ kind: "recent_interaction", text: `${i.owner_user_id === userId ? "You" : "A colleague"} had ${withArticle(String(i.channel))} with this person on ${i.occurred_at.slice(0, 10)}.`, by: i.owner_user_id, date: i.occurred_at });
  }
  const { data: drafts } = await db.from("draft").select("id, state, channel, owner_user_id").eq("workspace_id", ws).eq("recipient_person_id", personId).in("state", ["drafted", "approved", "opened_for_send"]).is("archived_at", null).limit(10);
  const known = new Set(((items ?? []) as Row[]).map((i) => i.id));
  if ((drafts ?? []).length && !known.size) w.push({ kind: "other_draft", text: `${drafts!.length} other draft message(s) to this person exist in Drafts.` });
  // Module 13: completed interactions with the person's company (other contacts) — avoid repetitive outreach.
  for (const r of await outreachRepetitionWarnings(db, ws, personId)) w.push({ kind: r.kind, text: r.text, date: r.date });
  if (thread || recentInteraction) w.push({ kind: "suggest_followup", suggestion: "follow_up_existing", itemId: thread?.id ?? null,
    text: thread ? "Instead of a new introduction, reply or follow up in the existing conversation (open it to draft a follow-up)." : "You spoke recently — consider a follow-up that references that conversation instead of a new introduction." });
  return w;
}

// Lenient: only subject/body are essential; everything else defaults so a slightly short AI answer still works.
const Gen = z.object({
  subject: z.string().nullable().optional().default(null), body: z.string(),
  value_prop: z.string().optional().default(""), assumptions: z.array(z.string()).optional().default([]),
  questions: z.array(z.string()).optional().default([]), opening_alternatives: z.array(z.string()).optional().default([]), cta_alternatives: z.array(z.string()).optional().default([]),
  call_script: z.object({ opener: z.string(), reason: z.string(), questions: z.array(z.string()), objections: z.array(z.object({ objection: z.string(), reply: z.string() })), close: z.string() }).nullable().optional().default(null),
  forwardable: z.string().nullable().optional().default(null),
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

async function generate(db: Db, ws: string, userId: string, c: Context, a: { channel: R.Channel; scenario: R.Scenario; reason: string; lang: R.Lang; via?: Row | null; sender: string; instruction?: string; current?: { subject: string | null; body: string }; mock?: () => GenOut; styleHint?: string; mode?: AiMode }, ai: Ai): Promise<{ out: GenOut; mocked: boolean; model: string }> {
  const tpl = R.templateDraft({ channel: a.channel, scenario: a.scenario, first: c.first, company: c.org?.display_name ?? "your company", level: c.level, reason: a.reason, roleKey: c.roleKey, sender: a.sender, via: a.via?.full_name?.split(/\s+/)[0] ?? null, lang: a.lang, facts: c.facts });
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
  ].filter(Boolean).join("\n\n") + await styleNotes(db, ws, userId, a.channel) + (a.styleHint ? `\n\nUser writing style (tone/length only, not content): ${a.styleHint.slice(0, 800)}` : "");
  const mock = a.mock ?? ((): GenOut => a.current ? mockEdit(a.current, a.instruction ?? "", tpl) : { ...tpl, value_prop: R.SCENARIOS[a.scenario].value, assumptions: c.unknowns.map((u) => `Unknown: ${u}`), questions: R.SCENARIOS[a.scenario].questions.slice(0, 3) });
  const pol = await runWithPolicy<{ data: GenOut; mocked: boolean; model: string }>({
    mode: a.mode ?? await getAiMode(db, ws, "outreach.draft"),
    code: () => ({ data: R.noPlaceholders(mock(), a.sender), mocked: false, model: "rules" }),
    ai: () => ai({ workspaceId: ws, workflow: "outreach.draft", tier: "luna", system: SYSTEM, input, schema: Gen, schemaName: "outreach_draft", maxOutputTokens: 2500, classification: "corporate_confidential", mock }),
  });
  if (!pol.value) throw pol.aiError ?? new OutreachError("Could not prepare the draft.");
  const r = pol.value;
  const out = r.data;
  if (a.channel !== "email" && a.channel !== "meeting_followup" && a.channel !== "introduction") out.subject = null;
  return { out, mocked: r.mocked, model: r.model };
}

/** Offline edits so the editor works without an AI key. */
function mockEdit(cur: { subject: string | null; body: string }, op: string, tpl: R.DraftOut): GenOut {
  let body = cur.body;
  const o = op.toLowerCase();
  if (o.startsWith("shorten")) body = body.split(/(?<=[.?!])\s+/).filter((s, i, a) => i === 0 || i >= a.length - 2).join(" ");
  else if (o.startsWith("expand")) body = `${body}\n\nHappy to share a short comparison of options and recent transactions in the area if useful.`;
  else if (o.includes("less sales") || o.includes("reduce")) body = body.replace(/Would a 15-minute call[^?]*\?/, "No pressure at all — happy to share a view whenever useful.");
  else if (o.includes("formal") || o.includes("professional")) body = body.replace(/^Hi ([^,\s]+)/, "Dear $1").replace(/\bHappy to\b/g, "I would be glad to").replace(/\bThanks\b/g, "Thank you");
  else if (o.includes("friendl") || o.includes("warm") || o.includes("casual")) body = body.replace(/^Dear ([^,\s]+)/, "Hi $1").replace(/\bI would be glad to\b/g, "Happy to");
  else if (o.includes("hinglish")) body = `Hi! ${body.replace(/^(?:Hi|Dear) [^,]+,\s*/, "")} Aapke liye ek quick call set kar sakte hain?`;
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

export interface CreateInput { personId: string; channels: R.Channel[]; scenario?: R.Scenario; signalId?: string | null; opportunityId?: string | null; language?: R.Lang; viaPersonId?: string | null; plannedOn?: string; mentionAvailabilityIds?: string[]; ai?: Ai; /** Extra facts from the caller (e.g. a meeting's summary/commitments/next step: source_type meeting_summary | meeting_commitment | meeting_next_step). Used verbatim; never invented. */ extraFacts?: Fact[]; /** Optional writing-style hint (assistant style profile). Wording only — never facts. */ styleHint?: string }
/** Create a conversation plan: one item per chosen channel (e.g. email + WhatsApp alternative), all step 1. */
export async function createOutreach(db: Db, ws: string, userId: string, inp: CreateInput) {
  const ai = inp.ai ?? callStructured;
  const t0 = Date.now();
  const c = await buildContext(db, ws, inp.personId, { signalId: inp.signalId, opportunityId: inp.opportunityId });
  const mentions = inp.mentionAvailabilityIds?.length ? await propertyFacts(db, ws, inp.mentionAvailabilityIds) : [];
  c.facts.push(...mentions, ...(inp.extraFacts ?? []).filter((f) => f.text?.trim()));
  if (c.blocked.all) throw new OutreachError(`Can't prepare outreach: ${c.blocked.all}.`);
  if (c.level === "not_interested") throw new OutreachError("This person said they're not interested. Respect that — record a new reason in Capture before reaching out again.");
  const sig = c.signals.find((s) => s.id === inp.signalId) ?? null;
  const warnings = await duplicateCheck(db, ws, inp.personId, userId);
  // Already in conversation and no scenario chosen → default to a follow-up (reconnect) rather than a cold introduction.
  const inThread = warnings.some((x) => x.suggestion === "follow_up_existing");
  const scenario = inp.scenario ?? (inThread ? "reconnect" : sig ? R.scenarioFor(sig) : c.leaseEvents.length ? "lease_renewal" : "reconnect");
  const reason = reasonFor(c, scenario, inp.signalId);
  const via = inp.viaPersonId ? (await db.from("person").select("id, full_name, contact_method(method_type, value, suppressed)").eq("workspace_id", ws).eq("id", inp.viaPersonId).maybeSingle()).data : null;
  const sender = await senderName(db, ws);
  const planKey = `p:${inp.personId}:${Date.now().toString(36)}`;
  const ids: string[] = []; let mocked = false;
  const chans = [...new Set(inp.channels)].filter((ch) => {
    const dch = R.draftChannel(ch);
    const block = dch && dch !== "introduction" ? c.blocked[dch] : null;
    if (block) warnings.push({ kind: "suppressed", text: `${R.CHANNEL_LABEL[ch]} skipped: ${block}.` });
    return !block;
  });
  if (chans.includes("introduction") && !via) throw new OutreachError("Pick who should make the introduction.");
  // All channels are written at the same time (one AI call each, in parallel) — much faster than one after another.
  const gens = await Promise.all(chans.map((ch) => generate(db, ws, userId, c, { channel: ch, scenario, reason, lang: inp.language ?? "en", via, sender, styleHint: inp.styleHint }, ai)));
  for (const [gi, ch] of chans.entries()) {
    const dch = R.draftChannel(ch);
    const g = gens[gi];
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
      script: { call: g.out.call_script, forwardable: g.out.forwardable, openings: g.out.opening_alternatives, ctas: g.out.cta_alternatives, warnings, mentions },
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
export async function editItem(db: Db, ws: string, userId: string, id: string, e: { subject?: string | null; body: string; recipientAddress?: string | null; learn?: boolean }, kind: "user_edit" | "ai_edit" | "regenerated" = "user_edit", op?: string) {
  const it = await loadItem(db, ws, id);
  if (!it.draft_id) throw new OutreachError("Call scripts are edited in the script panel.");
  if (["sent", "replied", "meeting", "declined", "closed"].includes(it.status)) throw new OutreachError("Already sent — create a follow-up instead.");
  const before = await getDraft(db, ws, it.draft_id);
  if (e.recipientAddress !== undefined) { const bad = R.recipientError(before.channel, e.recipientAddress); if (bad) throw new OutreachError(bad); }
  const patch: Row = { body: e.body };
  if (e.subject !== undefined) patch.subject = e.subject;
  if (e.recipientAddress !== undefined) patch.recipientAddress = e.recipientAddress;
  const after = (await updateDraft(db, ws, it.draft_id, patch, { actorUserId: userId })).draft;
  await version(db, ws, id, kind, after.subject, after.body, userId, op);
  // Module 12: learn the user's preferences from their own edits (best effort, never blocks the edit).
  if (kind === "user_edit") await learnFromDraftEdit({ db, workspaceId: ws, userId }, { draftId: it.draft_id, before: { subject: before.subject, body: before.body }, after: { subject: after.subject, body: after.body } }).catch(() => null);
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
  c.facts.push(...(((it.script ?? {}) as Row).mentions ?? []));
  const via = it.intro_via_person_id ? (await db.from("person").select("id, full_name").eq("id", it.intro_via_person_id).maybeSingle()).data : null;
  const lang: R.Lang = op === "hindi" ? "hi" : op === "hinglish" ? "hinglish" : op === "english" ? "en" : it.language;
  const g = await generate(db, ws, userId, c, { channel: it.channel, scenario: it.scenario, reason: it.reason, lang, via, sender: await senderName(db, ws), instruction: AI_OPS[op] ?? op, current: op === "regenerate" ? undefined : { subject: d.subject, body: d.body } }, ai);
  if (g.mocked && String(g.model).startsWith("fallback:")) throw new OutreachError("The AI couldn't rewrite it this time — nothing was changed. Please try again.");
  if (g.model === "rules" && op !== "regenerate" && g.out.body === d.body) throw new OutreachError("This rewrite needs AI — turn on “Outreach drafts” in AI settings, or edit the text directly. Nothing was changed.");
  if (g.mocked && op !== "regenerate" && g.out.body === d.body) throw new OutreachError("AI is off (no key loaded), so this option can't change the text. Restart the app after adding the key.");
  if (lang !== it.language) await db.from("outreach_item").update({ language: lang }).eq("id", id);
  await db.from("outreach_item").update({ script: { ...(it.script ?? {}), openings: g.out.opening_alternatives, ctas: g.out.cta_alternatives } }).eq("id", id);
  return editItem(db, ws, userId, id, { subject: g.out.subject ?? d.subject, body: g.out.body }, "ai_edit", op);
}

/** Put an earlier version back (saved as a new version, so nothing is lost; approval resets). */
export async function restoreVersion(db: Db, ws: string, userId: string, id: string, version: number) {
  const { data: v } = await db.from("outreach_version").select("subject, body").eq("workspace_id", ws).eq("item_id", id).eq("version", version).maybeSingle();
  if (!v) throw new OutreachError("That version no longer exists.");
  return editItem(db, ws, userId, id, { subject: v.subject, body: v.body }, "user_edit", `restored v${version}`);
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
  const { data: links } = await db.from("interaction_link").select("interaction:interaction_id(occurred_at, direction, channel, owner_user_id, source_message_id, objections, subject)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", it.person_id).limit(100);
  const after = ((links ?? []) as Row[]).map((l) => l.interaction).filter((i) => i && i.occurred_at > since);
  const { data: opp } = it.opportunity_id ? await db.from("opportunity").select("stage, outcome").eq("id", it.opportunity_id).maybeSingle() : { data: null };
  const { data: mtg } = await db.from("meeting_visit").select("id").eq("workspace_id", ws).eq("linked_entity_type", "person").eq("linked_entity_id", it.person_id).gte("start_at", new Date().toISOString()).neq("status", "cancelled").limit(1);
  const ch = R.draftChannel(it.channel);
  const reason = R.pauseReason({
    doNotContact: !!p?.do_not_contact, suppressed: ch ? !!(await suppressedFor(db, ws, it.person_id, ch)) : false,
    replied: after.some((i) => i.direction === "inbound" && i.subject !== OOO_SUBJECT), meetingScheduled: !!mtg?.length,
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
  // Every open item (paged): an unsorted .limit(500) skipped items once the workspace grew, so suppressions were missed.
  const data: Row[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data: page } = await db.from("outreach_item").select("*").eq("workspace_id", ws).is("archived_at", null).in("status", ["planned", "draft", "pending_approval", "approved"]).order("id").range(from, from + 999);
    data.push(...((page ?? []) as Row[]));
    if ((page ?? []).length < 1000) break;
  }
  let paused = 0; let tasks = 0;
  const day = today();
  for (const it of (data ?? []) as Row[]) {
    if (await sweepOne(db, ws, it)) { paused++; continue; }
    // A reminder task for each due/overdue planned follow-up (idempotent per item). It never drafts or sends.
    if (it.status === "planned" && it.planned_on && it.planned_on <= day) if (await followupTask(db, ws, it)) tasks++;
  }
  return { checked: (data ?? []).length, paused, tasks };
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
  outcome: z.enum(["interested", "meeting_scheduled", "info_requested", "not_now", "objection", "declined", "do_not_contact", "referred", "unavailable", "other"]),
  summary: z.string(), objection: z.string().nullable(),
  commitments: z.array(z.object({ who: z.enum(["us", "them"]), what: z.string(), due: z.string().nullable() })),
  next_action: z.string(), next_action_days: z.number().int().nullable(),
  crm_updates: z.array(z.object({ field: z.enum(["next_action", "stage"]), value: z.string(), reason: z.string() })),
  referred: z.object({ name: z.string(), email: z.string().nullable() }).nullable().optional().default(null),
  resume_on: z.string().nullable().optional().default(null),
  contact_updates: z.object({ title: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }).nullable().optional().default(null),
  company_note: z.string().nullable().optional().default(null),
  requirement_updates: z.array(z.object({ field: z.enum(["preferred_micro_market"]), value: z.string(), reason: z.string() })).optional().default([]),
});
type RespOut = z.infer<typeof Resp>;
export const OUTCOME_LABEL: Record<RespOut["outcome"], string> = { interested: "Interested", meeting_scheduled: "Meeting", info_requested: "Wants information", not_now: "Not now", objection: "Objection", declined: "Declined", do_not_contact: "Do not contact", referred: "Referred someone else", unavailable: "Away / out of office", other: "Other" };

/** Offline classifier: deterministic, from the reply text only. */
export function mockResponse(text: string, day = today()): RespOut {
  const t = text.toLowerCase();
  const ex = R.extractReply(text);
  const cls = classifyReply(text);
  const MAP: Record<ReplyClass, RespOut["outcome"]> = { unsubscribe: "do_not_contact", out_of_office: "unavailable", wrong_person: ex.referred ? "referred" : "other", not_interested: "declined", not_now: "not_now", info_requested: "info_requested", meeting: "meeting_scheduled", interested: "interested", unclear: "other" };
  let outcome: RespOut["outcome"] = MAP[cls.label];
  if (cls.label === "unclear") outcome = ex.unavailable ? "unavailable" : ex.referred ? "referred" : /\b(?:monday|tuesday|wednesday|thursday|friday|tomorrow)\b/.test(t) ? "meeting_scheduled" : "other";
  else if (ex.referred && (outcome === "interested" || outcome === "other")) outcome = "referred";
  else if (ex.unavailable && outcome !== "do_not_contact") outcome = "unavailable";
  const resume = outcome === "unavailable" ? R.resumeDateFrom(text, day) : null;
  // "options in Kharadi" / "space near Baner" → the place they asked about (capitalised word(s) after in/near/around).
  const place = /\b(?:in|near|around|at)\s+([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?)/.exec(text)?.[1] ?? null;
  const LABEL: Partial<Record<RespOut["outcome"], string>> = { do_not_contact: "Asked not to be contacted", unavailable: "Out of office", referred: `Pointed us to ${ex.referred?.name ?? "someone else"}`, declined: "Not interested", not_now: "Not now — check back later", info_requested: `Asked for details${place ? ` (${place})` : ""}`, meeting_scheduled: "Wants to meet / talk", interested: "Positive reply", other: cls.label === "wrong_person" ? "Says we have the wrong person" : "Reply received" };
  const firstLine = text.replace(/\s+/g, " ").trim().slice(0, 160);
  return { outcome, summary: `${LABEL[outcome]}: “${firstLine}${text.length > 160 ? "…" : ""}”`.slice(0, 220), objection: outcome === "declined" ? text.slice(0, 120) : null,
    commitments: outcome === "info_requested" ? [{ who: "us", what: "Send the requested details", due: null }] : outcome === "meeting_scheduled" ? [{ who: "us", what: "Prepare for the meeting", due: null }]
      : outcome === "referred" && ex.referred ? [{ who: "us", what: `Contact ${ex.referred.name} (referred)`, due: null }] : [],
    next_action: cls.label === "wrong_person" && outcome === "other" ? "Find the right contact at the company" : outcome === "declined" || outcome === "do_not_contact" ? "Close this conversation" : outcome === "not_now" ? "Check back later" : outcome === "unavailable" ? `Follow up after they're back (${resume})` : outcome === "referred" ? `Reach out to ${ex.referred?.name}, mentioning the referral` : "Reply and confirm next step",
    next_action_days: outcome === "not_now" ? 60 : outcome === "unavailable" ? R.daysBetween(day, resume!) + 1 : 2,
    crm_updates: outcome === "meeting_scheduled" || outcome === "interested" ? [{ field: "stage", value: "engaged", reason: "Prospect replied positively to outreach" }]
      : outcome === "info_requested" ? [{ field: "stage", value: "engaged", reason: "Prospect asked for information" }, { field: "next_action", value: `Send the requested details${place ? ` (${place})` : ""}`, reason: "Prospect asked for information" }] : [],
    requirement_updates: outcome === "info_requested" && place ? [{ field: "preferred_micro_market", value: place, reason: `Reply asks for options in ${place}` }] : [],
    referred: outcome === "referred" ? ex.referred : null, resume_on: resume,
    contact_updates: ex.updates.title || ex.updates.email || ex.updates.phone ? ex.updates : null, company_note: ex.companyNote };
}

/** Spec §13: a reply improves the record — interaction, commitments → tasks, proposed CRM/contact/company updates, pause or replan follow-ups. */
export async function recordResponse(db: Db, ws: string, userId: string, id: string, text: string, ai: Ai = callStructured, mode?: AiMode) {
  const it = await loadItem(db, ws, id);
  if (!text.trim()) throw new OutreachError("Paste or type the reply.");
  const pol = await runWithPolicy<{ data: RespOut }>({ mode: mode ?? await getAiMode(db, ws, "outreach.response"), code: () => ({ data: mockResponse(text) }), ai: () => ai({ workspaceId: ws, workflow: "outreach.response", tier: "luna", schema: Resp, schemaName: "outreach_response", maxOutputTokens: 1100,
    system: "Classify a reply to a commercial real-estate outreach message. Extract only what the reply says. Dates as YYYY-MM-DD only if stated. 'stage' updates may only be one of: engaged, qualified_discussion. outcome 'referred' = they point us to another person (fill referred with the name and an email only if written). 'unavailable' = out of office / on leave (fill resume_on if a return date is stated). contact_updates only for a new title/email/phone the sender states for themselves. company_note only for a factual company update they state. requirement_updates.preferred_micro_market only when they name a location/micro-market they want options in.",
    input: `Our message reason: ${it.reason}. Opportunity: ${it.opportunity_id ? "linked" : "none"}. Today: ${today()}.`, evidence: text, mock: () => mockResponse(text) }) });
  if (!pol.value) throw pol.aiError ?? new OutreachError("Could not read the reply.");
  const x = pol.value.data;
  const now = new Date().toISOString();
  const away = x.outcome === "unavailable";
  const resumeOn = away ? (x.resume_on && /^\d{4}-\d{2}-\d{2}$/.test(x.resume_on) && x.resume_on > today() ? x.resume_on : R.resumeDateFrom(text, today())) : null;
  const { data: inter, error } = await db.from("interaction").insert({ workspace_id: ws, occurred_at: now, channel: it.channel === "whatsapp" ? "whatsapp" : it.channel === "linkedin" ? "linkedin" : it.channel === "call" ? "call" : "email", direction: "inbound", subject: away ? OOO_SUBJECT : "Reply to outreach", summary: x.summary, promises: x.commitments, objections: x.objection ? [{ text: x.objection, outcome: x.outcome }] : [], opportunity_id: it.opportunity_id, is_meaningful: !["other", "unavailable"].includes(x.outcome), owner_user_id: userId }).select("id").single();
  if (error) throw error;
  await db.from("interaction_link").insert([{ workspace_id: ws, interaction_id: inter.id, entity_type: "person", entity_id: it.person_id, role: "from" }, ...(it.org_id ? [{ workspace_id: ws, interaction_id: inter.id, entity_type: "organisation", entity_id: it.org_id, role: "mentioned" }] : [])]);
  const status = x.outcome === "meeting_scheduled" ? "meeting" : x.outcome === "declined" || x.outcome === "do_not_contact" ? "declined" : "replied";
  await db.from("outreach_item").update({ status, responded_at: now, response: { ...x, resume_on: resumeOn, text: text.slice(0, 4000), interaction_id: inter.id } }).eq("id", id);
  await event(db, ws, id, x.outcome === "meeting_scheduled" ? "meeting" : status === "declined" ? "declined" : "response", userId, { outcome: x.outcome });
  // pause every other open/planned item for this person (outdated follow-ups)
  const { data: open } = await db.from("outreach_item").select("id, draft_id").eq("workspace_id", ws).eq("person_id", it.person_id).in("status", OPEN).neq("id", id);
  for (const o of (open ?? []) as Row[]) {
    const why = status === "declined" ? "Recipient declined" : away ? `Away until ${resumeOn} — replanned` : "A reply was received";
    await db.from("outreach_item").update({ status: "paused", pause_reason: why }).eq("id", o.id);
    if (o.draft_id) await setDraftPaused(db, ws, o.draft_id, true, why, userId).catch(() => null);
    await event(db, ws, o.id, "paused", userId, { reason: why, auto: true });
  }
  let replanned: string | null = null;
  if (away && resumeOn) replanned = await replanAfter(db, ws, userId, it, R.plusDays(resumeOn, 1), `They were away until ${resumeOn} — check in after their return`);
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
  const propose = async (input: Parameters<typeof proposeChange>[2]) => { const p = await proposeChange(db, ws, { proposedByKind: "model", ownerUserId: userId, ...input }).catch(() => null); if (p) proposals.push((p as Row).id ?? ""); return p; };
  if (it.opportunity_id) {
    for (const u of x.crm_updates) {
      if (u.field === "stage" && !["engaged", "qualified_discussion"].includes(u.value)) continue;
      await propose({ targetType: "opportunity", targetId: it.opportunity_id, patch: [{ op: "replace", path: `/${u.field}`, value: u.value }], reason: `Outreach reply: ${u.reason}`, idempotencyKey: `outreach:${id}:${u.field}` });
    }
  }
  const proposalKinds: string[] = [];
  // Requirement updates stated in the reply (e.g. preferred micro-market) → proposals on the linked requirement (S4).
  const reqId = it.requirement_id ?? (it.opportunity_id ? (await db.from("opportunity").select("requirement_id").eq("workspace_id", ws).eq("id", it.opportunity_id).maybeSingle()).data?.requirement_id : null);
  if (reqId) {
    for (const u of x.requirement_updates ?? []) {
      if (u.field !== "preferred_micro_market" || !u.value.trim()) continue;
      const { data: rq } = await db.from("requirement").select("preferred_geography_ids, constraints").eq("workspace_id", ws).eq("id", reqId).maybeSingle();
      if (!rq) continue;
      const { data: geo } = await db.from("geography").select("id").eq("workspace_id", ws).ilike("name", u.value.trim()).is("archived_at", null).limit(2);
      const patch = geo?.length === 1
        ? [{ op: "replace" as const, path: "/preferred_geography_ids", value: [...new Set([...(rq.preferred_geography_ids ?? []), geo[0].id])] }]
        : [{ op: "replace" as const, path: "/constraints", value: { ...(rq.constraints ?? {}), preferred_micro_markets: [...new Set([...(((rq.constraints ?? {}) as Row).preferred_micro_markets ?? []), u.value.trim()])] } }];
      if (await propose({ targetType: "requirement", targetId: reqId, patch, reason: `Outreach reply: ${u.reason} ("${text.slice(0, 120)}")`, idempotencyKey: `outreach:${id}:req:${u.field}` })) proposalKinds.push("requirement");
    }
  }
  // Contact updates the sender states about themselves → Review (never written directly).
  const cu = x.contact_updates;
  if (cu?.title) {
    const { data: emp } = await db.from("employment").select("id, title").eq("workspace_id", ws).eq("person_id", it.person_id).eq("is_current", true).limit(1).maybeSingle();
    if (emp && emp.title !== cu.title && await propose({ targetType: "employment", targetId: emp.id, patch: [{ op: "replace", path: "/title", value: cu.title.slice(0, 120) }], reason: `Outreach reply states a new title: "${cu.title}"`, idempotencyKey: `outreach:${id}:title` })) proposalKinds.push("title");
  }
  for (const [kind, value] of [["email", cu?.email], ["phone", cu?.phone]] as const) {
    if (!value) continue;
    const { data: has } = await db.from("contact_method").select("id").eq("workspace_id", ws).eq("person_id", it.person_id).eq("value", value).limit(1);
    if (has?.length) continue;
    if (await propose({ targetType: "contact_method", operation: "create", patch: [{ op: "add", path: "/person_id", value: it.person_id }, { op: "add", path: "/method_type", value: kind }, { op: "add", path: "/value", value }, { op: "add", path: "/verify_status", value: "user_provided" }, { op: "add", path: "/source_name", value: "outreach reply" }], reason: `Outreach reply states a ${kind}: ${value}`, idempotencyKey: `outreach:${id}:${kind}` })) proposalKinds.push(kind);
  }
  if (x.company_note && it.org_id) {
    const { data: org } = await db.from("organisation").select("account_owner_note").eq("id", it.org_id).maybeSingle();
    const note = `${today()} (outreach reply): ${x.company_note}`;
    if (await propose({ targetType: "organisation", targetId: it.org_id, patch: [{ op: "replace", path: "/account_owner_note", value: [org?.account_owner_note, note].filter(Boolean).join("\n").slice(-4000) }], reason: `Company update stated in a reply: ${x.company_note}`, idempotencyKey: `outreach:${id}:company_note` })) proposalKinds.push("company note");
  }
  // Referred person → proposed new contact (never created directly). Email kept in the reason for the reviewer.
  let referred: { name: string; email: string | null; proposalId: string | null } | null = null;
  if (x.outcome === "referred" && x.referred?.name) {
    const p = await propose({ targetType: "person", operation: "create", patch: [{ op: "add", path: "/full_name", value: x.referred.name.slice(0, 120) }], reason: `Referred by the recipient of an outreach reply${x.referred.email ? ` (email given: ${x.referred.email})` : ""}${it.org_id ? "" : ""}`, idempotencyKey: `outreach:${id}:referred` });
    referred = { ...x.referred, proposalId: (p as Row | null)?.id ?? null };
    if (p) proposalKinds.push("referred contact");
  }
  return { outcome: x.outcome, status, tasks, proposals, proposalKinds, referred, resumeOn, replanned, mocked: (pol.value as { mocked?: boolean }).mocked ?? false, source: pol.source, nextAction: x.next_action };
}

/** Plan (or move) the next follow-up of this conversation to a date. Only a plan — drafted when the user asks. */
async function replanAfter(db: Db, ws: string, userId: string, it: Row, on: string, reason: string): Promise<string> {
  const ch = it.channel === "call" ? "email" : it.channel;
  const { data: nx } = await db.from("outreach_item").select("id, status, draft_id").eq("workspace_id", ws).eq("plan_key", it.plan_key).eq("step", it.step + 1).eq("channel", ch).is("archived_at", null).limit(1).maybeSingle();
  if (nx && ["planned", "paused"].includes(nx.status) && !nx.draft_id) {
    await db.from("outreach_item").update({ status: "planned", planned_on: on, pause_reason: null, reason }).eq("id", nx.id);
    await event(db, ws, nx.id, "resumed", userId, { reason: `replanned to ${on}` });
    return nx.id;
  }
  const { data } = await db.from("outreach_item").insert({ workspace_id: ws, person_id: it.person_id, org_id: it.org_id, opportunity_id: it.opportunity_id, requirement_id: it.requirement_id, signal_id: it.signal_id, plan_key: it.plan_key, step: nx ? it.step + 2 : it.step + 1, scenario: it.scenario, channel: ch, reason, value_prop: it.value_prop, facts: it.facts, questions: it.questions, status: "planned", planned_on: on, assigned_user_id: it.assigned_user_id ?? userId, language: it.language, owner_user_id: it.owner_user_id ?? userId }).select("id").single();
  return data?.id ?? "";
}

/** Reminder task for a due/overdue planned follow-up. Idempotent: key outreach-followup:<id>. */
async function followupTask(db: Db, ws: string, it: Row): Promise<boolean> {
  const key = R.followupTaskKey(it.id);
  if ((await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).limit(1)).data?.length) return false;
  const { data: p } = await db.from("person").select("full_name").eq("id", it.person_id).maybeSingle();
  const { error } = await db.from("task").insert({ workspace_id: ws, title: `Follow up with ${p?.full_name ?? "contact"} (${R.CHANNEL_LABEL[it.channel as R.Channel] ?? it.channel})`.slice(0, 200), description: `${it.reason}. Open /outreach/${it.id} to draft it — nothing is sent automatically.`, due_at: `${it.planned_on}T09:00:00+05:30`, assigned_user_id: it.assigned_user_id, linked_entity_type: "person", linked_entity_id: it.person_id, source: "outreach", idempotency_key: key, owner_user_id: it.owner_user_id ?? it.assigned_user_id });
  return !error;
}

/** Different approach after 2+ unanswered sends for this person (warm intro → other channel → pause). */
export async function alternativeFor(db: Db, ws: string, userId: string, personId: string): Promise<R.Alternative | null> {
  const { data } = await db.from("outreach_item").select("channel, sent_at, responded_at, status").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(20);
  const rows = (data ?? []) as Row[];
  if (rows.some((r) => r.responded_at)) { const lastReply = rows.findIndex((r) => r.responded_at); rows.splice(lastReply); }
  if (rows.length < 2) return null;
  const { data: cm } = await db.from("contact_method").select("method_type, suppressed, verify_status").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null);
  const ok = ((cm ?? []) as Row[]).filter((m) => !m.suppressed && m.verify_status !== "invalid");
  const has = (t: string) => ok.some((m) => m.method_type === t);
  const paths = await warmPaths(db, ws, userId, personId);
  return R.alternativeApproach({ unansweredSends: rows.length, channelsUsed: [...new Set(rows.map((r) => r.channel))], available: { email: has("email"), phone: has("phone"), whatsapp: has("whatsapp") || has("phone"), linkedin: has("linkedin") }, warmPath: paths[0] ? { personId: paths[0].personId, name: paths[0].name } : null });
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
  const { data: toT } = await db.from("relationship_edge").select("from_person_id, edge_type, warmth, intro_permission, strength_basis, last_meaningful_contact, from_person:from_person_id(full_name)").eq("workspace_id", ws).eq("to_person_id", targetPersonId).not("from_person_id", "is", null).is("archived_at", null);
  const mids = ((toT ?? []) as Row[]).map((e) => e.from_person_id);
  if (!mids.length) return [];
  const { data: mine } = await db.from("relationship_edge").select("to_person_id, warmth, edge_type, strength_basis, last_meaningful_contact").eq("workspace_id", ws).eq("from_user_id", userId).in("to_person_id", mids).is("archived_at", null);
  const W: Record<string, number> = { trusted: 4, hot: 3, warm: 2, cold: 1 };
  return ((toT ?? []) as Row[]).map((e) => {
    const m = ((mine ?? []) as Row[]).find((x) => x.to_person_id === e.from_person_id);
    const score = (W[e.warmth ?? "cold"] ?? 1) * 2 + (m ? W[m.warmth ?? "cold"] ?? 1 : 0) * 3 + (e.intro_permission ? 2 : 0);
    return { personId: e.from_person_id, name: e.from_person?.full_name ?? "", theirLink: `${e.edge_type}${e.warmth ? `, ${e.warmth}` : ""}`, yourLink: m ? `${m.edge_type}${m.warmth ? `, ${m.warmth}` : ""}` : "No recorded link to you", introPermission: !!e.intro_permission, score,
      // Why we believe each link exists — recorded basis and last meaningful contact; null when nothing was recorded.
      evidence: {
        theirs: e.strength_basis || e.last_meaningful_contact ? { basis: (e.strength_basis ?? null) as string | null, lastContact: (e.last_meaningful_contact ?? null) as string | null } : null,
        yours: m && (m.strength_basis || m.last_meaningful_contact) ? { basis: (m.strength_basis ?? null) as string | null, lastContact: (m.last_meaningful_contact ?? null) as string | null } : null,
      } };
  }).sort((a, b) => b.score - a.score);
}

/** Business-useful analytics with explicit denominators (spec §18). Drafts never count as outreach. */
export async function analytics(db: Db, ws: string, days = 90) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data } = await db.from("outreach_item").select("id, person_id, org_id, status, channel, scenario, step, planned_on, sent_at, sent_evidence, responded_at, response, prep_seconds, created_at, opportunity_id, person:person_id(full_name), org:org_id(display_name)").eq("workspace_id", ws).gte("created_at", since).limit(5000);
  const items = (data ?? []) as Row[];
  const sent = items.filter((i) => i.sent_at);
  const replied = sent.filter((i) => i.responded_at);
  const meaningful = replied.filter((i) => !["other", "unavailable"].includes(i.response?.outcome));
  const meetings = sent.filter((i) => i.status === "meeting" || i.response?.outcome === "meeting_scheduled");
  const { data: ev } = await db.from("outreach_event").select("event").eq("workspace_id", ws).gte("created_at", since).limit(10000);
  const n = (e: string) => ((ev ?? []) as Row[]).filter((x) => x.event === e).length;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const contacts = new Set(sent.map((i) => i.person_id)).size;
  // Follow-ups whose date has arrived: completed = sent; still planned/drafted = open; paused/closed = stopped.
  const dueFu = items.filter((i) => i.step > 1 && i.planned_on && i.planned_on <= today());
  const fuDone = dueFu.filter((i) => i.sent_at).length;
  const fuStopped = dueFu.filter((i) => !i.sent_at && ["paused", "closed"].includes(i.status)).length;
  const fuActionable = dueFu.length - fuStopped;
  // "After outreach": opportunities / requirements created ≤30 days after a send to that company. Not attribution.
  const orgIds = [...new Set(sent.map((i) => i.org_id).filter(Boolean))] as string[];
  const [opps, reqs] = orgIds.length ? await Promise.all([
    db.from("opportunity").select("id, org_id, created_at").eq("workspace_id", ws).in("org_id", orgIds).gte("created_at", since).limit(2000),
    db.from("requirement").select("id, org_id, created_at, status").eq("workspace_id", ws).in("org_id", orgIds).gte("created_at", since).limit(2000),
  ]) : [{ data: [] }, { data: [] }];
  const sends = sent.map((i) => ({ org_id: i.org_id, sent_at: i.sent_at }));
  const oppsAfter = ((opps.data ?? []) as Row[]).filter((o) => R.afterOutreach(sends, o as never));
  const reqsAfter = ((reqs.data ?? []) as Row[]).filter((o) => R.afterOutreach(sends, o as never));
  const qualified = reqsAfter.filter((r) => r.status === "client_confirmed");
  const outcomes: Record<string, number> = {};
  for (const i of replied) { const k = String(i.response?.outcome ?? "other"); outcomes[k] = (outcomes[k] ?? 0) + 1; }
  return {
    days, drafts: n("drafted"), approved: n("approved"), sentManual: sent.filter((i) => i.sent_evidence === "user_assertion").length, sentProvider: sent.filter((i) => String(i.sent_evidence).startsWith("provider:")).length,
    attempts: sent.length, contacts, companies: new Set(sent.map((i) => i.org_id).filter(Boolean)).size,
    replies: replied.length, meaningful: meaningful.length, meetings: meetings.length, paused: items.filter((i) => i.status === "paused").length,
    replyRate: pct(replied.length, sent.length), meetingRate: pct(meetings.length, contacts),
    rates: { reply: R.rate(replied.length, sent.length, "sent"), meaningful: R.rate(meaningful.length, sent.length, "sent"), meeting: R.rate(meetings.length, contacts, "people contacted"), followup: R.rate(fuDone, fuActionable, "due follow-ups"),
      referred: R.rate(outcomes.referred ?? 0, replied.length, "replies"), unavailable: R.rate(outcomes.unavailable ?? 0, replied.length, "replies") },
    outcomes,
    followups: { due: dueFu.length, done: fuDone, stopped: fuStopped, open: fuActionable - fuDone },
    after: { opportunities: oppsAfter.length, requirements: reqsAfter.length, qualified: qualified.length, companies: orgIds.length },
    byChannel: R.breakdown(sent, (i) => R.CHANNEL_LABEL[i.channel as R.Channel] ?? i.channel),
    byScenario: R.breakdown(sent, (i) => R.SCENARIOS[i.scenario as R.Scenario]?.label ?? i.scenario),
    byCompany: R.breakdown(sent, (i) => i.org?.display_name ?? null, 10),
    byContact: R.breakdown(sent, (i) => i.person?.full_name ?? null, 10),
    prepMinutes: Math.round(items.reduce((a, i) => a + (i.prep_seconds ?? 0), 0) / 60),
  };
}

/** "Show 3 versions": 2–3 complete alternatives for the same channel, persisted in script.variants (survive reload). */
export async function generateVariants(db: Db, ws: string, userId: string, id: string, ai: Ai = callStructured, opts: { angles?: R.Angle[] } = {}) {
  const ANG = opts.angles?.length ? R.ALL_ANGLES.filter((a) => opts.angles!.includes(a.key)) : R.VARIANT_ANGLES;
  const it = await loadItem(db, ws, id);
  if (!it.draft_id) throw new OutreachError("Call scripts don't have alternative versions.");
  if (!["draft", "pending_approval", "approved"].includes(it.status)) throw new OutreachError("Already sent — create a follow-up instead.");
  const d = await getDraft(db, ws, it.draft_id);
  const c = await buildContext(db, ws, it.person_id, { signalId: it.signal_id, opportunityId: it.opportunity_id });
  c.facts.push(...(((it.script ?? {}) as Row).mentions ?? []));
  const sender = await senderName(db, ws);
  const q = (it.questions as string[] | null)?.[0] ?? R.SCENARIOS[it.scenario as R.Scenario].questions[0];
  const gens = await Promise.all(ANG.map((v) => generate(db, ws, userId, c, { channel: it.channel, scenario: it.scenario, reason: it.reason, lang: it.language, sender, instruction: v.instruction, current: { subject: d.subject, body: d.body },
    mock: () => ({ ...R.variantMock({ subject: d.subject, body: d.body }, v.key, c.first, q), value_prop: "", assumptions: [], questions: [], opening_alternatives: [], cta_alternatives: [], call_script: null, forwardable: null }) }, ai)));
  const seen = new Set<string>([d.body.trim()]);
  const variants = gens.map((g, i) => ({ n: i + 1, angle: ANG[i].key, label: ANG[i].label, subject: g.out.subject ?? d.subject, body: g.out.body.trim() }))
    .filter((v) => v.body && !seen.has(v.body) && seen.add(v.body)).slice(0, 3);
  if (variants.length < 2) throw new OutreachError("Couldn't produce distinct versions this time — nothing was changed.");
  const fresh = await loadItem(db, ws, id);
  await db.from("outreach_item").update({ script: { ...(fresh.script ?? {}), variants, variants_at: new Date().toISOString(), variants_from_hash: d.content_hash } }).eq("id", id);
  await event(db, ws, id, "variants_generated", userId, { count: variants.length, mocked: gens.some((g) => g.mocked) });
  return variants;
}
/** Pick one alternative → new version (kind regenerated, op variant:<n>). Approval resets as with any edit. */
export async function pickVariant(db: Db, ws: string, userId: string, id: string, n: number) {
  const it = await loadItem(db, ws, id);
  const v = (((it.script ?? {}) as Row).variants ?? []).find((x: Row) => x.n === n);
  if (!v) throw new OutreachError("That version is no longer available — generate them again.");
  const after = await editItem(db, ws, userId, id, { subject: v.subject, body: v.body }, "regenerated", `variant:${n}`);
  const fresh = await loadItem(db, ws, id);
  await db.from("outreach_item").update({ script: { ...(fresh.script ?? {}), picked_variant: n } }).eq("id", id);
  return after;
}

export interface PropertyOption { availabilityId: string; spaceId: string; asset: string; microMarket: string | null; area: number | null; rent: string | null; availableFrom: string | null; label: { verified: boolean; text: string }; fit: number | null; source: "shortlist" | "search" }
/** Up to 3 properties for the company's open requirement: shortlist first (deals matching), else available spaces by micro-market and size. */
export async function propertySuggestions(db: Db, ws: string, orgId: string | null, limit = 3): Promise<{ requirement: Row | null; options: PropertyOption[] }> {
  if (!orgId) return { requirement: null, options: [] };
  const { data: req } = await db.from("requirement").select("id, title, status, area_min_sf, area_target_sf, area_max_sf, preferred_geography_ids").eq("workspace_id", ws).eq("org_id", orgId).neq("status", "closed").is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!req) return { requirement: null, options: [] };
  const day = today();
  const AV = "id, space_id, status, as_of, available_from, asking_rent_min, asking_rent_max, rent_basis, fact_status, space:space_id(id, carpet_sf, chargeable_sf, asset:asset_id(name, micro_market:micro_market_id(name)))";
  const toOpt = (a: Row, fit: number | null, source: PropertyOption["source"]): PropertyOption => ({ availabilityId: a.id, spaceId: a.space_id, asset: a.space?.asset?.name ?? "Building", microMarket: a.space?.asset?.micro_market?.name ?? null, area: a.space?.chargeable_sf ?? a.space?.carpet_sf ?? null,
    rent: a.asking_rent_min != null ? `₹${a.asking_rent_min}${a.asking_rent_max && a.asking_rent_max !== a.asking_rent_min ? `–${a.asking_rent_max}` : ""}/${a.rent_basis === "seat" ? "seat" : "sq ft"}` : null, availableFrom: a.available_from, label: R.availabilityLabel(a as never, day), fit, source });
  const { data: sl } = await db.from("shortlist_option").select(`fit_score, eligible, option_status, availability:availability_id(${AV})`).eq("workspace_id", ws).eq("requirement_id", req.id).neq("option_status", "rejected").is("archived_at", null).order("fit_score", { ascending: false, nullsFirst: false }).limit(limit);
  const out: PropertyOption[] = ((sl ?? []) as Row[]).filter((o) => o.availability && o.eligible !== false).map((o) => toOpt(o.availability, o.fit_score, "shortlist"));
  if (out.length >= limit) return { requirement: req, options: out.slice(0, limit) };
  const lo = Number(req.area_min_sf ?? (req.area_target_sf ? req.area_target_sf * 0.8 : 0)); const hi = Number(req.area_max_sf ?? (req.area_target_sf ? req.area_target_sf * 1.25 : 1e12));
  const geos = (req.preferred_geography_ids ?? []) as string[];
  const { data: assetsInGeo } = geos.length ? await db.from("asset").select("id").eq("workspace_id", ws).or(`micro_market_id.in.(${geos.join(",")}),locality_id.in.(${geos.join(",")})`).limit(1000) : { data: null };
  const inGeo = assetsInGeo ? new Set(((assetsInGeo ?? []) as Row[]).map((a) => a.id)) : null;
  const { data: spaces } = inGeo ? await db.from("space").select("id, asset_id").eq("workspace_id", ws).in("asset_id", [...inGeo].slice(0, 500)) : { data: null };
  const okSpace = spaces ? new Set(((spaces ?? []) as Row[]).map((x) => x.id)) : null;
  const seen = new Set(out.map((o) => o.spaceId));
  // Page through newest snapshots (size/geo filters run in code), so a busy workspace can't hide fitting options behind one page cap.
  const PAGE = 300;
  for (let page = 0; page < 10 && out.length < limit; page++) {
    const { data: av } = await db.from("availability").select(AV).eq("workspace_id", ws).in("status", ["available", "unverified"]).is("archived_at", null).gte("as_of", addDays(day, -180))
      .order("as_of", { ascending: false }).order("created_at", { ascending: false }).order("id").range(page * PAGE, page * PAGE + PAGE - 1); // newest snapshot first on same-day ties
    const rows = (av ?? []) as Row[];
    for (const a of rows) {
      if (out.length >= limit) break;
      if (seen.has(a.space_id)) continue; seen.add(a.space_id);   // latest snapshot per space only
      if (okSpace && !okSpace.has(a.space_id)) continue;
      const area = Number(a.space?.chargeable_sf ?? a.space?.carpet_sf ?? NaN);
      if ((lo || hi < 1e12) && (Number.isNaN(area) || area < lo || area > hi)) continue;
      out.push(toOpt(a, null, "search"));
    }
    if (rows.length < PAGE) break;
  }
  return { requirement: req, options: out };
}
/** Facts for "mention in draft" — the AI may use them; it never gets more than what's on the record. */
export async function propertyFacts(db: Db, ws: string, availabilityIds: string[]): Promise<Fact[]> {
  if (!availabilityIds.length) return [];
  const { data } = await db.from("availability").select("id, status, as_of, fact_status, available_from, space:space_id(carpet_sf, chargeable_sf, asset:asset_id(name, micro_market:micro_market_id(name)))").eq("workspace_id", ws).in("id", availabilityIds.slice(0, 3));
  return ((data ?? []) as Row[]).map((a) => {
    const l = R.availabilityLabel(a as never, today()); const area = a.space?.chargeable_sf ?? a.space?.carpet_sf;
    return { text: `Option: ${a.space?.asset?.name ?? "a building"}${a.space?.asset?.micro_market?.name ? ` (${a.space.asset.micro_market.name})` : ""}${area ? `, ~${Number(area).toLocaleString("en-IN")} sq ft` : ""} — ${l.verified ? "availability verified" : "availability NOT verified: say 'may be available' or omit"}`, source_type: "availability", source_id: a.id, date: a.as_of };
  });
}
/** Toggle a property in the facts the AI may use for this message's next rewrite. Doesn't change the text itself. */
export async function toggleMention(db: Db, ws: string, userId: string, id: string, availabilityId: string) {
  const it = await loadItem(db, ws, id);
  const sc = (it.script ?? {}) as Row;
  const cur = (sc.mentions ?? []) as Fact[];
  const has = cur.some((f) => f.source_id === availabilityId);
  const mentions = has ? cur.filter((f) => f.source_id !== availabilityId) : [...cur, ...(await propertyFacts(db, ws, [availabilityId]))].slice(-3);
  await db.from("outreach_item").update({ script: { ...sc, mentions } }).eq("id", id);
  await event(db, ws, id, "edited", userId, { mention: availabilityId, on: !has });
  return !has;
}

export interface RelRow { personId: string; name: string; title: string | null; org: string | null; orgId: string | null; lastAt: string | null; last90: number; status: R.RelStatus; commitments: string[]; unansweredInbound: boolean; warmIntros: number; openOutreach: number }
/** Relationships tab: everyone with a recorded interaction or outreach, with deterministic status. */
export async function relationships(db: Db, ws: string, limit = 200): Promise<RelRow[]> {
  const day = today();
  const [{ data: links }, { data: items }, { data: tasks }] = await Promise.all([
    db.from("interaction_link").select("entity_id, interaction:interaction_id(occurred_at, direction, promises)").eq("workspace_id", ws).eq("entity_type", "person").order("created_at", { ascending: false }).limit(10000),
    db.from("outreach_item").select("person_id, status").eq("workspace_id", ws).is("archived_at", null).limit(5000),
    db.from("task").select("title, linked_entity_id, status").eq("workspace_id", ws).eq("linked_entity_type", "person").in("status", ["open", "snoozed"]).is("archived_at", null).limit(5000),
  ]);
  const byP = new Map<string, Row[]>();
  for (const l of (links ?? []) as Row[]) if (l.interaction) byP.set(l.entity_id, [...(byP.get(l.entity_id) ?? []), l.interaction]);
  for (const i of (items ?? []) as Row[]) if (i.person_id && !byP.has(i.person_id)) byP.set(i.person_id, []);
  const ids = [...byP.keys()].slice(0, 1000);
  if (!ids.length) return [];
  // ~100 uuids per request keeps the PostgREST URL under proxy limits (1000 ids in one in.() fails as "URI too long").
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, i * 100 + 100));
  const parts = await Promise.all(chunks.map((c) => Promise.all([
    db.from("person").select("id, full_name, do_not_contact, archived_at, employment(title, is_current, org:org_id(id, display_name))").eq("workspace_id", ws).in("id", c),
    db.from("relationship_edge").select("to_person_id").eq("workspace_id", ws).in("to_person_id", c).not("from_person_id", "is", null).is("archived_at", null),
  ])));
  const failed = parts.flat().find((r) => r.error);
  if (failed?.error) throw new Error(`relationships: ${failed.error.message}`);
  const people = parts.flatMap(([p]) => (p.data ?? []) as Row[]);
  const edges = parts.flatMap(([, e]) => (e.data ?? []) as Row[]);
  const rows: RelRow[] = [];
  for (const p of (people ?? []) as Row[]) {
    if (p.archived_at) continue;
    const e = R.engagement((byP.get(p.id) ?? []) as never, day);
    const openTasks = ((tasks ?? []) as Row[]).filter((t) => t.linked_entity_id === p.id).map((t) => String(t.title));
    const commitments = [...new Set([...openTasks, ...e.promises])].slice(0, 5);
    const emp = (p.employment ?? []).find((x: Row) => x.is_current);
    rows.push({ personId: p.id, name: p.full_name, title: emp?.title ?? null, org: emp?.org?.display_name ?? null, orgId: emp?.org?.id ?? null, lastAt: e.lastAt, last90: e.last90,
      status: R.relationshipStatus({ lastAt: e.lastAt, today: day, openCommitments: commitments.length, unansweredInbound: e.unansweredInbound }), commitments, unansweredInbound: e.unansweredInbound,
      warmIntros: ((edges ?? []) as Row[]).filter((x) => x.to_person_id === p.id).length, openOutreach: ((items ?? []) as Row[]).filter((i) => i.person_id === p.id && OPEN.includes(i.status)).length });
  }
  const ord: Record<R.RelStatus, number> = { needs_attention: 0, cooling: 1, active: 2, inactive: 3 };
  return rows.sort((a, b) => ord[a.status] - ord[b.status] || (b.lastAt ?? "").localeCompare(a.lastAt ?? "")).slice(0, limit);
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

/** Today: people with 2+ unanswered sends and nothing open → suggest a different approach. */
export async function alternativesToday(db: Db, ws: string, userId: string, limit = 5) {
  const { data } = await db.from("outreach_item").select("person_id, status, sent_at, responded_at, person:person_id(full_name), org:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null).not("sent_at", "is", null).gte("sent_at", addDays(today(), -120)).order("sent_at", { ascending: false }).limit(2000);
  const { data: open } = await db.from("outreach_item").select("person_id").eq("workspace_id", ws).is("archived_at", null).in("status", ["draft", "pending_approval", "approved"]).limit(2000);
  const busy = new Set(((open ?? []) as Row[]).map((o) => o.person_id));
  const by = new Map<string, Row[]>();
  for (const r of (data ?? []) as Row[]) by.set(r.person_id, [...(by.get(r.person_id) ?? []), r]);
  const cands = [...by.entries()].filter(([pid, rs]) => !busy.has(pid) && !rs.some((r) => r.responded_at) && rs.length >= 2).slice(0, limit);
  const out: { personId: string; name: string; org: string | null; alt: R.Alternative }[] = [];
  for (const [pid, rs] of cands) { const alt = await alternativeFor(db, ws, userId, pid); if (alt) out.push({ personId: pid, name: rs[0].person?.full_name ?? "—", org: rs[0].org?.display_name ?? null, alt }); }
  return out;
}
