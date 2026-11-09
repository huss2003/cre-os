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
export function templateDraft(i: { channel: Channel; scenario: Scenario; first: string; company: string; level: Level; reason: string; roleKey: string; sender: string; via?: string | null; lang?: Lang }): DraftOut {
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
    case "meeting_followup": subject = `Thanks — next steps for ${i.company}`; body = `Hi ${i.first},\n\nThank you for your time. As discussed:\n- [summary point]\n- [commitment and owner]\n\nNext step: [agreed action and date].\n\nRegards,\n${i.sender}`; break;
    case "call": body = `${opener} ${why} ${ask}`; break;
    default: subject = `${i.company}: ${sc.label.toLowerCase()} in Pune`; body = `${opener}\n\n${why} Given your focus on ${focus}, I thought it may be useful to compare options early rather than when timelines are tight.\n\n${ask}\n\nRegards,\n${i.sender}`;
  }
  const call_script = i.channel === "call" ? { opener, reason: why, questions: q, objections: [
    { objection: "We're not looking right now.", reply: "Understood — is there a lease date or headcount change coming up that would be worth planning for?" },
    { objection: "We already have a broker.", reply: "That's fine — I'm happy to share market data you can compare against, with no obligation." }], close: ask } : null;
  return { subject, body, opening_alternatives: [opener, known ? `Hi ${i.first}, a quick one about ${i.company}.` : `Hi ${i.first}, reaching out with a specific reason.`], cta_alternatives: [ask, "Would it help if I sent a one-page comparison of current options?"], call_script, forwardable };
}
