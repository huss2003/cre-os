/**
 * Module 5 — Outreach Engine: deterministic rules. No AI here: scenario logic, role focus, relationship level,
 * follow-up timing, pause rules and the offline (mock) drafts all live in plain code so they are testable.
 */
import { department } from "@/modules/contacts/rules";

export type Scenario = "lease_renewal" | "expansion" | "consolidation" | "relocation" | "managed_office" | "gcc" | "reconnect" | "meeting_followup";
export type Channel = "email" | "whatsapp" | "linkedin" | "call" | "introduction" | "meeting_followup";
export type Level = "not_interacted" | "spoke_on_call" | "met_once" | "met_few" | "good" | "not_interested";
export type Lang = "en" | "hi" | "hinglish";

export const SCENARIOS: Record<Scenario, { label: string; value: string; questions: string[] }> = {
  lease_renewal: { label: "Lease renewal", value: "Plan the upcoming renewal early and compare it against current alternatives.", questions: [
    "Have renewal discussions with the landlord started?",
    "Are you evaluating alternative locations, or is staying the preference?",
    "Is the current rent and escalation still commercially comfortable?",
    "When does the internal decision need to be made?"] },
  expansion: { label: "Expansion", value: "Evaluate expansion options before space is needed.", questions: [
    "Is the growth planned within the current office or through an additional location?",
    "Roughly how many additional seats are expected?",
    "Which micro-markets are being considered?",
    "What is the expected timeline?"] },
  consolidation: { label: "Consolidation", value: "Reduce occupancy cost and unused capacity by consolidating.", questions: [
    "How many locations are you operating from today?",
    "What does utilisation look like across them?",
    "Which lease events are coming up first?"] },
  relocation: { label: "Relocation", value: "Compare better-value or better-connected building alternatives.", questions: [
    "What are the main reasons for considering a move?",
    "Which operational issues should a new location solve?",
    "What is the preferred move-in timeline?"] },
  managed_office: { label: "Managed office", value: "Get ready-to-move, flexible space without a long commitment.", questions: [
    "How long would the space be needed for?",
    "How many seats, and how soon?",
    "Is a fully managed, ready-to-move space preferred?"] },
  gcc: { label: "GCC set-up", value: "Plan the Pune set-up: locations, timelines and workplace strategy.", questions: [
    "What headcount is planned for the first 12–24 months?",
    "Is Pune confirmed, or still being compared with other cities?",
    "Who else is involved in the location decision?"] },
  reconnect: { label: "Reconnect", value: "Stay current on their plans and share relevant market context.", questions: [
    "Has anything changed in your office plans since we last spoke?",
    "Is there an upcoming lease event we should plan for?"] },
  meeting_followup: { label: "Meeting follow-up", value: "Confirm what was agreed and the next step.", questions: [
    "Is the summary of our discussion accurate?",
    "Who else should receive the requested information?"] },
};

/** What each role cares about — used to steer the draft (spec §4). */
export const ROLE_FOCUS: Record<string, { label: string; focus: string[] }> = {
  finance: { label: "CFO / Finance", focus: ["occupancy cost", "rent savings", "cash-flow implications", "lease economics"] },
  real_estate: { label: "Corporate Real Estate", focus: ["portfolio strategy", "lease planning", "location alternatives", "transaction timelines"] },
  facilities: { label: "Facilities / Administration", focus: ["building operations", "parking and access", "amenities", "space utilisation"] },
  procurement: { label: "Procurement", focus: ["commercial comparisons", "vendor evaluation", "negotiation process", "contract terms"] },
  hr: { label: "HR", focus: ["employee accessibility", "workforce growth", "workplace experience", "seating capacity"] },
  leadership: { label: "CEO / MD / Site head", focus: ["strategic expansion", "business requirements", "flexibility", "long-term value"] },
  other: { label: "Other", focus: ["office plans", "upcoming decisions"] },
};
export function roleKey(title: string | null | undefined): string {
  return department(title)?.key ?? "other";
}

export const LEVEL_LABEL: Record<Level, string> = { not_interacted: "Not interacted", spoke_on_call: "Spoke on call", met_once: "Met once", met_few: "Met a few times", good: "Good relationship", not_interested: "Not interested" };

/** Relationship level from recorded interactions (+ an explicit "not interested" flag). Never assumed. */
export function relationshipLevel(ints: { channel: string; direction: string | null; is_meaningful: boolean }[], notInterested = false): Level {
  if (notInterested) return "not_interested";
  const meetings = ints.filter((i) => ["meeting", "visit"].includes(i.channel)).length;
  const calls = ints.filter((i) => i.channel === "call").length;
  const twoWay = ints.filter((i) => i.direction === "inbound").length;
  if (meetings >= 3 || (meetings >= 2 && twoWay >= 2)) return "good";
  if (meetings >= 2) return "met_few";
  if (meetings === 1) return "met_once";
  if (calls || twoWay) return "spoke_on_call";
  return "not_interacted";
}

/** Map a Module 2 signal / lease event to an outreach scenario. */
export function scenarioFor(s: { category?: string | null; kind?: string | null; title?: string | null }): Scenario {
  const t = `${s.kind ?? ""} ${s.title ?? ""}`.toLowerCase();
  if (s.category === "lease" || /lease|renewal|expiry|break/.test(t)) return /reloc|move/.test(t) ? "relocation" : "lease_renewal";
  if (/gcc|capability cent|global (in-house|capability)/.test(t)) return "gcc";
  if (/consolidat|downsiz|layoff|restructur/.test(t) || s.category === "restructuring") return "consolidation";
  if (/reloc|move/.test(t)) return "relocation";
  if (/managed|flex|cowork/.test(t)) return "managed_office";
  if (/expan|hiring|new office|growth|funding|headcount/.test(t) || s.category === "expansion") return "expansion";
  return "reconnect";
}

/** Planning suggestions, not a campaign: only the NEXT step is ever planned, and only after a confirmed send. */
export const FOLLOWUP_DAYS = [0, 5, 12, 25];
export function nextFollowupDays(step: number): number | null {
  return step < FOLLOWUP_DAYS.length ? FOLLOWUP_DAYS[step] - FOLLOWUP_DAYS[step - 1] : null;
}

/** Deterministic pause rules (spec §12). Returns the reason to pause, or null. */
export function pauseReason(x: {
  replied?: boolean; meetingScheduled?: boolean; declined?: boolean; doNotContact?: boolean; suppressed?: boolean;
  colleagueContactedSince?: boolean; opportunityStage?: string | null; opportunityOutcome?: string | null; objection?: boolean;
}): string | null {
  if (x.doNotContact) return "Contact is marked do-not-contact";
  if (x.suppressed) return "Channel is suppressed or consent revoked";
  if (x.declined) return "Recipient declined";
  if (x.replied) return "A reply was received";
  if (x.meetingScheduled) return "A meeting is scheduled";
  if (x.objection) return "An objection changes the approach";
  if (x.opportunityOutcome && x.opportunityOutcome !== "open") return `Opportunity is ${x.opportunityOutcome}`;
  if (x.opportunityStage && ["proposal_negotiation", "loi", "documentation", "signed", "possession", "invoiced", "recognised"].includes(x.opportunityStage)) return "Active negotiation is under way";
  if (x.colleagueContactedSince) return "A colleague has contacted this person since";
  return null;
}

export const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", call: "Call script", introduction: "Warm introduction", meeting_followup: "Meeting follow-up" };
/** Draft channel used in mudar.draft (call has no draft). */
export function draftChannel(c: Channel): "email" | "whatsapp" | "linkedin" | "introduction" | null {
  return c === "call" ? null : c === "meeting_followup" ? "email" : c;
}
export const LENGTH_HINT: Record<Channel, string> = {
  email: "Email: subject under 8 words; 80–140 words; one clear question as the call to action.",
  whatsapp: "WhatsApp: 2–4 short sentences, under 60 words, no subject, no formal sign-off.",
  linkedin: "LinkedIn: under 300 characters for a connection note; plain and specific.",
  call: "Call script: opener, reason, 2–3 questions, objection replies, close.",
  introduction: "Introduction request to the mutual contact (under 90 words) + a forwardable 3-sentence blurb.",
  meeting_followup: "Meeting follow-up email: thanks, 2–4 bullet summary, commitments with owners, next step.",
};

export interface DraftOut { subject: string | null; body: string; opening_alternatives: string[]; cta_alternatives: string[]; call_script: { opener: string; reason: string; questions: string[]; objections: { objection: string; reply: string }[]; close: string } | null; forwardable: string | null }

/** Offline draft (used when no AI key) — built only from the facts passed in, never inventing history. */
export function templateDraft(i: { channel: Channel; scenario: Scenario; first: string; company: string; level: Level; reason: string; roleKey: string; sender: string; via?: string | null; lang?: Lang; facts?: { text: string; source_type: string }[] }): DraftOut {
  const sc = SCENARIOS[i.scenario];
  const focus = (ROLE_FOCUS[i.roleKey] ?? ROLE_FOCUS.other).focus[0];
  const known = i.level !== "not_interacted" && i.level !== "not_interested";
  const opener = known ? `Hi ${i.first}, hope things are going well since we last spoke.` : `Hi ${i.first}, I'm ${i.sender}, an office-space adviser in Pune.`;
  const why = `${i.reason.replace(/\.$/, "")}.`;
  const ask = `Would a 15-minute call next week be useful to understand whether ${sc.label.toLowerCase() === "reconnect" ? "anything has changed in your office plans" : "this is on your radar"}?`;
  const q = sc.questions.slice(0, 3);
  let body: string; let subject: string | null = null; let forwardable: string | null = null;
  switch (i.channel) {
    case "whatsapp": body = `${known ? `Hi ${i.first}` : `Hi ${i.first}, ${i.sender} here (office space, Pune)`}. ${why} Happy to share a quick view on options — would a short call this week work?`; break;
    case "linkedin": body = `Hi ${i.first} — ${why} I advise companies on office space in Pune and would value connecting.`; break;
    case "introduction":
      body = `Hi ${i.via ?? "there"}, could you introduce me to ${i.first} at ${i.company}? ${why} I'd like to understand their plans and see if I can help with ${focus}. Only if you're comfortable — happy to send a short note you can forward.`;
      forwardable = `${i.sender} advises companies on office space in Pune. ${why} He'd welcome a short call with ${i.first} to understand ${i.company}'s plans.`; break;
    case "meeting_followup": {
      // Filled only from the meeting's own facts (summary, commitments, next step) — no placeholders, nothing invented.
      const of = (t: string) => (i.facts ?? []).filter((f) => f.source_type === t).map((f) => f.text.trim()).filter(Boolean);
      const summary = of("meeting_summary"), commitments = of("meeting_commitment"), next = of("meeting_next_step")[0];
      subject = `Thanks — next steps for ${i.company}`;
      body = [`Hi ${i.first},`, "",
        summary.length ? `Thank you for your time. As discussed:\n${summary.map((x) => `- ${x}`).join("\n")}` : "Thank you for your time today.",
        ...(commitments.length ? ["", `Agreed actions:\n${commitments.map((x) => `- ${x}`).join("\n")}`] : []),
        "", next ? `Next step: ${next.replace(/\.$/, "")}.` : "Next step: I will confirm the next step with you shortly.",
        "", `Regards,\n${i.sender}`].join("\n");
      break;
    }
    case "call": body = `${opener} ${why} ${ask}`; break;
    default: subject = `${i.company}: ${sc.label.toLowerCase()} in Pune`; body = `${opener}\n\n${why} Given your focus on ${focus}, I thought it may be useful to compare options early rather than when timelines are tight.\n\n${ask}\n\nRegards,\n${i.sender}`;
  }
  const call_script = i.channel === "call" ? { opener, reason: why, questions: q, objections: [
    { objection: "We're not looking right now.", reply: "Understood — is there a lease date or headcount change coming up that would be worth planning for?" },
    { objection: "We already have a broker.", reply: "That's fine — I'm happy to share market data you can compare against, with no obligation." }], close: ask } : null;
  return { subject, body, opening_alternatives: [opener, known ? `Hi ${i.first}, a quick one about ${i.company}.` : `Hi ${i.first}, reaching out with a specific reason.`], cta_alternatives: [ask, "Would it help if I sent a one-page comparison of current options?"], call_script, forwardable };
}

// ───────────────────────────── Round 2: variants, follow-ups, replies, relationships, analytics, properties ──
const DAY = 864e5;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY);
export const plusDays = (d: string, n: number) => new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** "Show 3 versions": complete alternatives for the same channel, each a different tone/angle. */
export type Angle = "professional" | "conversational" | "very_short" | "concise" | "value" | "question";
export const ALL_ANGLES: { key: Angle; label: string; instruction: string }[] = [
  { key: "professional", label: "Professional", instruction: "Write a complete alternative in a formal, professional tone: courteous greeting, the reason, one clear ask. Use only the listed facts." },
  { key: "conversational", label: "Conversational", instruction: "Write a complete alternative in a warm, conversational tone, as you would write to someone you know. Use only the listed facts." },
  { key: "very_short", label: "Very short", instruction: "Write a complete alternative of at most two short sentences: the reason and one question only." },
  { key: "concise", label: "Concise", instruction: "Write a complete alternative that is as short as possible: the reason and one question only." },
  { key: "value", label: "Value-led", instruction: "Write a complete alternative that leads with the concrete value for this role, using only the listed facts." },
  { key: "question", label: "Question-led", instruction: "Write a complete alternative that opens with a specific, easy-to-answer question about their plans." },
];
/** Default "3 versions": the tones users ask for. Other angles can be requested via generateVariants(..., { angles }). */
export const VARIANT_ANGLES = ALL_ANGLES.filter((a) => ["professional", "conversational", "very_short"].includes(a.key));
/** Offline variant built from the current text — never adds facts that weren't in it. */
export function variantMock(cur: { subject: string | null; body: string }, angle: Angle, first: string, question: string): { subject: string | null; body: string } {
  const sentences = cur.body.replace(/\n+/g, " ").split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  const reason = sentences.find((s) => /noticed|lease|reports|since we last|came up/i.test(s)) ?? sentences[1] ?? sentences[0] ?? "";
  const ask = sentences.find((s) => s.endsWith("?")) ?? "Would a short call be useful?";
  const signoff = /\nRegards,\n(.+)$/.exec(cur.body)?.[1];
  const end = signoff ? `\n\nRegards,\n${signoff}` : "";
  const bare = reason.replace(/^(Hi|Dear) [^,]+,\s*/, "");
  if (angle === "professional") return { subject: cur.subject, body: `Dear ${first},\n\nI hope this finds you well. ${bare}\n\n${ask}\n\nThank you for your time.${end}` };
  if (angle === "conversational") return { subject: cur.subject, body: `Hi ${first}, hope things are going well!\n\n${bare} Thought it was worth a quick note. ${ask.replace(/\?$/, "")} — no pressure either way?${end}` };
  if (angle === "very_short") return { subject: cur.subject, body: `${first} — ${bare} ${ask}${end}` };
  if (angle === "concise") return { subject: cur.subject, body: `Hi ${first}, ${reason.replace(/^Hi [^,]+,\s*/, "")} ${ask}${end}`.trim() };
  if (angle === "question") return { subject: cur.subject ? `Quick question, ${first}` : null, body: `Hi ${first}, quick question: ${question.charAt(0).toLowerCase()}${question.slice(1)}\n\n${reason} If useful, I can share what comparable companies are doing.${end}` };
  return { subject: cur.subject, body: `Hi ${first},\n\n${reason} Planning early usually means more options and better terms than deciding when timelines are tight.\n\n${ask}${end}` };
}

/** Follow-up timing state for a planned item. */
export function followupState(plannedOn: string | null, today: string): "overdue" | "due" | "upcoming" | null {
  if (!plannedOn) return null;
  const d = daysBetween(today, plannedOn);
  return d < 0 ? "overdue" : d === 0 ? "due" : "upcoming";
}
export const followupTaskKey = (itemId: string) => `outreach-followup:${itemId}`;

/** After 2+ sends with no reply: suggest a different approach instead of another identical follow-up. */
export interface Alternative { kind: "warm_intro" | "switch_channel" | "pause"; text: string; channel?: Channel; viaPersonId?: string }
export function alternativeApproach(x: { unansweredSends: number; channelsUsed: string[]; available: { email?: boolean; whatsapp?: boolean; linkedin?: boolean; phone?: boolean }; warmPath?: { personId: string; name: string } | null }): Alternative | null {
  if (x.unansweredSends < 2) return null;
  if (x.warmPath) return { kind: "warm_intro", text: `${x.unansweredSends} messages without a reply. Ask ${x.warmPath.name} for an introduction instead (they haven't agreed yet — ask first).`, channel: "introduction", viaPersonId: x.warmPath.personId };
  const order: [Channel, keyof typeof x.available][] = [["call", "phone"], ["whatsapp", "whatsapp"], ["linkedin", "linkedin"], ["email", "email"]];
  const used = new Set(x.channelsUsed);
  const next = order.find(([c, k]) => !used.has(c) && (x.available[k] || (c === "whatsapp" && x.available.phone)));
  if (next) return { kind: "switch_channel", text: `${x.unansweredSends} ${[...used].map((c) => CHANNEL_LABEL[c as Channel] ?? c).join("/")} messages without a reply. Try a ${CHANNEL_LABEL[next[0]]} instead of another one.`, channel: next[0] };
  return { kind: "pause", text: `${x.unansweredSends} messages without a reply and no other channel or introduction path. Pause and revisit when there's a new reason.` };
}

/** Out-of-office: resume date stated in the reply, else a safe default (+14 days). Dates as YYYY-MM-DD or "20 Nov"/"Nov 20". */
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function resumeDateFrom(text: string, today: string): string {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1];
  if (iso && iso > today) return iso;
  const m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\b|\b([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (m) {
    const day = Number(m[1] ?? m[4]); const mon = MON.indexOf(String(m[2] ?? m[3]).toLowerCase());
    if (mon >= 0 && day >= 1 && day <= 31) {
      let y = Number(today.slice(0, 4)); let d = `${y}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (d <= today) { y++; d = `${y}-${d.slice(5)}`; }
      return d;
    }
  }
  if (/next week/i.test(text)) return plusDays(today, 7);
  if (/next month/i.test(text)) return plusDays(today, 30);
  return plusDays(today, 14);
}

/** Deterministic extraction used by the offline (mock) reply classifier. Only what the reply literally states. */
export function extractReply(text: string): { referred: { name: string; email: string | null } | null; unavailable: boolean; updates: { title: string | null; email: string | null; phone: string | null }; companyNote: string | null } {
  const emails = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
  const ref = /(?:reach out to|get in touch with|speak (?:to|with)|talk to|contact|looping in|loop in|cc'?ing|refer(?:ring)? you to)\s+(?:my colleague\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})/.exec(text);
  const unavailable = /out of (?:the )?office|on leave|away until|on vacation|on holiday|back on|returning on|limited access to email/i.test(text);
  const title = /(?:[Mm]y new (?:role|title|designation) is|I(?:'m| am) now (?:the )?|I have moved to the role of )\s*([A-Z][^.,;\n]{2,60})/.exec(text)?.[1]?.trim() ?? null;
  const phone = /(\+?\d[\d\s-]{8,}\d)/.exec(text)?.[1]?.replace(/[\s-]/g, "") ?? null;
  const note = /\b(we (?:have|are|'ve|'re) (?:moved|moving|relocat\w+|expand\w*|consolidat\w*|shift\w*|hiring)[^.\n]*)/i.exec(text)?.[1] ?? null;
  const referred = ref ? { name: ref[1].trim(), email: emails[0] ?? null } : null;
  return { referred, unavailable, updates: { title, email: referred ? null : emails[0] ?? null, phone }, companyNote: note ? `${note.charAt(0).toUpperCase()}${note.slice(1)}`.slice(0, 300) : null };
}

/** Relationship status for the Relationships tab. Needs-attention wins over recency. */
export type RelStatus = "needs_attention" | "active" | "cooling" | "inactive";
export const REL_LABEL: Record<RelStatus, string> = { needs_attention: "Needs attention", active: "Active", cooling: "Cooling", inactive: "Inactive" };
export function relationshipStatus(x: { lastAt: string | null; today: string; openCommitments: number; unansweredInbound: boolean }): RelStatus {
  if (x.openCommitments > 0 || x.unansweredInbound) return "needs_attention";
  if (!x.lastAt) return "inactive";
  const d = daysBetween(x.lastAt, x.today);
  return d < 45 ? "active" : d <= 90 ? "cooling" : "inactive";
}
/** Engagement summary from a person's interactions (newest first or any order). */
export function engagement(ints: { occurred_at: string; direction: string | null; promises?: unknown[] | null }[], today: string) {
  const s = [...ints].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const last = s[0] ?? null;
  const lastOut = s.find((i) => i.direction === "outbound");
  const unansweredInbound = !!last && last.direction === "inbound";
  const since = lastOut?.occurred_at ?? "";
  const promises = s.filter((i) => i.occurred_at > since).flatMap((i) => (i.promises ?? []) as unknown[])
    .filter((p) => typeof p === "string" || (p as { who?: string }).who !== "them")
    .map((p) => (typeof p === "string" ? p : String((p as { what?: string }).what ?? (p as { text?: string }).text ?? "")).trim()).filter(Boolean);
  return { lastAt: last?.occurred_at ?? null, last90: s.filter((i) => daysBetween(i.occurred_at, today) <= 90).length, unansweredInbound, promises };
}

/** Rate that always carries its denominator. */
export interface Rate { n: number; d: number; pct: string; label: string }
export function rate(n: number, d: number, of: string): Rate {
  const pct = d ? `${Math.round((n / d) * 100)}%` : "—";
  return { n, d, pct, label: d ? `${pct} (${n} of ${d} ${of})` : `— (no ${of} yet)` };
}
/** Group sent items by a key → sends, replies, meetings, reply rate. */
export function breakdown<T extends { sent_at?: string | null; responded_at?: string | null; status?: string; response?: { outcome?: string } | null }>(items: T[], key: (i: T) => string | null, top = 10) {
  const m = new Map<string, T[]>();
  for (const i of items) { if (!i.sent_at) continue; const k = key(i) ?? "Unknown"; m.set(k, [...(m.get(k) ?? []), i]); }
  return [...m.entries()].map(([k, xs]) => {
    const replies = xs.filter((x) => x.responded_at).length;
    const meetings = xs.filter((x) => x.status === "meeting" || x.response?.outcome === "meeting_scheduled").length;
    return { key: k, sends: xs.length, replies, meetings, replyRate: rate(replies, xs.length, "sent") };
  }).sort((a, b) => b.sends - a.sends || b.replies - a.replies).slice(0, top);
}
/** "After outreach" window: a record created within `days` after a send to that org (never claimed as caused by it). */
export function afterOutreach(sends: { org_id: string | null; sent_at: string }[], rec: { org_id: string | null; created_at: string }, days = 30): boolean {
  if (!rec.org_id) return false;
  return sends.some((s) => s.org_id === rec.org_id && rec.created_at >= s.sent_at && daysBetween(s.sent_at, rec.created_at) <= days);
}

/** Availability label for property suggestions — verified only if confirmed within 30 days. */
export function availabilityLabel(a: { status: string; as_of: string; fact_status?: string | null }, today: string): { verified: boolean; text: string } {
  const age = daysBetween(a.as_of, today);
  if (a.status === "available" && a.fact_status === "currently_confirmed" && age <= 30) return { verified: true, text: `Availability verified ${a.as_of}` };
  if (a.status === "unverified") return { verified: false, text: `Availability not verified (reported ${a.as_of}) — check before mentioning` };
  return { verified: false, text: `Reported ${a.status.replace(/_/g, " ")} as of ${a.as_of} (${age} days ago) — confirm before mentioning` };
}

export { recipientError } from "@/lib/services/drafts";
