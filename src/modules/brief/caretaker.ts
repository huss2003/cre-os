/**
 * Relationship Caretaker (workflow 18). PURE and deterministic: turns permitted relationship context into human
 * follow-up SUGGESTIONS. It never sends anything (S3), never marks a promise complete (a promise only changes when a
 * person edits it), and drops every suggestion that touches an opted-out / suppressed / contact-restricted person or
 * company. No personal profiling: only interaction promises, visit feedback, lease windows and deal outcomes are read.
 */
import { addDays, daysBetween } from "./dates";
import type { RadarItem } from "./lease-radar";

export type PromiseStatus = "open" | "done" | "cancelled";
export type PromiseParty = "us" | "them" | "unknown";

export interface ParsedPromise {
  index: number;
  key: string;            // stable across re-ordering of the promises array
  who: string | null;
  party: PromiseParty;
  what: string;
  due: string | null;     // ISO date or null (unknown stays unknown: no due -> no overdue alert)
  status: PromiseStatus;
}

const OUR = new Set(["me", "i", "us", "we", "user", "self", "adviser", "advisor", "broker", "our team", "owner", "myself"]);
const DONE = new Set(["done", "completed", "complete", "fulfilled", "kept", "closed", "delivered", "resolved"]);
const CANCELLED = new Set(["cancelled", "canceled", "dropped", "withdrawn", "void", "superseded"]);

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Small deterministic string hash (FNV-1a, hex) — keeps this module dependency-free. */
export function keyHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Parse interaction.promises ({who, what, due, status}[]); tolerant of aliases, never invents values. */
export function parsePromises(raw: unknown): ParsedPromise[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedPromise[] = [];
  raw.forEach((p, index) => {
    if (!p || typeof p !== "object") {
      if (typeof p === "string" && p.trim()) out.push({ index, key: keyHash(`|${norm(p)}|`), who: null, party: "unknown", what: p.trim(), due: null, status: "open" });
      return;
    }
    const o = p as Record<string, unknown>;
    const what = [o.what, o.text, o.description, o.promise].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    if (!what) return;
    const who = typeof o.who === "string" && o.who.trim() ? o.who.trim() : null;
    const dueRaw = [o.due, o.due_date, o.dueDate, o.by].find((v) => typeof v === "string") as string | undefined;
    const due = dueRaw && /^\d{4}-\d{2}-\d{2}/.test(dueRaw) && !Number.isNaN(Date.parse(dueRaw.slice(0, 10))) ? dueRaw.slice(0, 10) : null;
    const st = typeof o.status === "string" ? norm(o.status) : "";
    const status: PromiseStatus = DONE.has(st) ? "done" : CANCELLED.has(st) ? "cancelled" : "open";
    const party: PromiseParty = who == null ? "unknown" : OUR.has(norm(who)) ? "us" : "them";
    out.push({ index, key: keyHash(`${norm(who ?? "")}|${norm(what)}|${due ?? ""}`), who, party, what: what.trim(), due, status });
  });
  return out;
}

export type SuggestionKind = "promise_overdue" | "promise_due" | "visit_concern" | "renewal" | "referral";

export interface RelSuggestion {
  key: string;                 // dedupe key (alerts + task idempotency)
  kind: SuggestionKind;
  title: string;
  why: string;                 // explainable rule
  due: string | null;          // ISO date
  priority: number;
  createTask: boolean;         // overdue promises + post-visit concerns become tasks; renewals/referrals stay suggestions
  link: { type: "interaction" | "meeting_visit" | "lease" | "opportunity" | "organisation"; id: string };
  orgIds: string[];
  personIds: string[];
  ownerUserId: string | null;
  href: string;
}

export interface InteractionCtx {
  id: string;
  occurredAt: string;
  subject: string | null;
  channel: string | null;
  promises: unknown;
  ownerUserId: string | null;
  personIds: string[];
  orgIds: string[];
  orgName?: string | null;
}

export const PROMISE_DUE_SOON_DAYS = 2;

export function promiseSuggestions(items: InteractionCtx[], today: string): RelSuggestion[] {
  const out: RelSuggestion[] = [];
  for (const i of items) {
    for (const p of parsePromises(i.promises)) {
      if (p.status !== "open" || !p.due) continue;
      const days = daysBetween(today, p.due);
      if (days > PROMISE_DUE_SOON_DAYS) continue;
      const overdue = days < 0;
      const ctx = `${i.channel ?? "interaction"} ${i.occurredAt.slice(0, 10)}${i.orgName ? ` with ${i.orgName}` : ""}`;
      const verb = p.party === "them" ? `Chase ${p.who}` : p.party === "us" ? "Deliver" : "Follow up";
      out.push({
        key: `caretaker:promise:${i.id}:${p.key}`,
        kind: overdue ? "promise_overdue" : "promise_due",
        title: `${verb}: ${p.what}`,
        why: overdue
          ? `Promise from ${ctx} was due ${p.due} (${-days} day${days === -1 ? "" : "s"} overdue) and is still open — it stays open until you record it as kept`
          : `Promise from ${ctx} is due ${p.due}${days === 0 ? " (today)" : ` (in ${days} day${days === 1 ? "" : "s"})`}`,
        due: p.due, priority: overdue ? 85 : 65, createTask: overdue,
        link: { type: "interaction", id: i.id }, orgIds: i.orgIds, personIds: i.personIds, ownerUserId: i.ownerUserId,
        href: i.orgIds[0] ? `/companies/${i.orgIds[0]}` : `/tasks?q=${encodeURIComponent(p.what.slice(0, 40))}`,
      });
    }
  }
  return out;
}

export interface VisitFeedbackCtx {
  id: string;
  meetingVisitId: string;
  meetingTitle: string | null;
  visitDate: string;          // ISO date of the visit
  concerns: string | null;
  dealbreakers: string | null;
  nextStep: string | null;
  followUpDue: string | null;
  rating: number | null;      // client rating 1..5 when recorded
  ownerUserId: string | null;
  orgIds: string[];
  personIds: string[];
}

export const REFERRAL_MIN_RATING = 4;
export const VISIT_FOLLOWUP_DAYS = 2;

export function visitSuggestions(items: VisitFeedbackCtx[], today: string): RelSuggestion[] {
  const out: RelSuggestion[] = [];
  for (const f of items) {
    const name = f.meetingTitle ?? "site visit";
    const concern = [f.concerns, f.dealbreakers].filter((x) => x && x.trim()).join("; ");
    if (concern || (f.nextStep && f.nextStep.trim())) {
      const due = f.followUpDue ?? addDays(f.visitDate, VISIT_FOLLOWUP_DAYS);
      out.push({
        key: `caretaker:visit:${f.id}`, kind: "visit_concern",
        title: concern ? `Address visit concerns — ${name}` : `Post-visit next step — ${name}`,
        why: `Visit ${f.visitDate}: ${concern ? `concerns “${concern.slice(0, 160)}”` : ""}${concern && f.nextStep ? "; " : ""}${f.nextStep ? `agreed next step “${f.nextStep.slice(0, 120)}”` : ""}. Follow up by ${due}${f.followUpDue ? " (recorded follow-up date)" : ` (visit + ${VISIT_FOLLOWUP_DAYS} days)`}`,
        due, priority: due < today ? 80 : 70, createTask: true,
        link: { type: "meeting_visit", id: f.meetingVisitId }, orgIds: f.orgIds, personIds: f.personIds, ownerUserId: f.ownerUserId,
        href: f.orgIds[0] ? `/companies/${f.orgIds[0]}` : "/calendar",
      });
    }
    if (f.rating != null && f.rating >= REFERRAL_MIN_RATING && daysBetween(f.visitDate, today) <= 30) {
      out.push({
        key: `caretaker:referral:visit:${f.id}`, kind: "referral", title: `Ask for a referral — ${name}`,
        why: `Client rated the ${f.visitDate} visit ${f.rating}/5 (≥ ${REFERRAL_MIN_RATING}) — a good moment to ask who else is looking`,
        due: null, priority: 30, createTask: false,
        link: { type: "meeting_visit", id: f.meetingVisitId }, orgIds: f.orgIds, personIds: f.personIds, ownerUserId: f.ownerUserId,
        href: f.orgIds[0] ? `/companies/${f.orgIds[0]}` : "/calendar",
      });
    }
  }
  return out;
}

export interface WonDealCtx { id: string; name: string; orgId: string; orgName: string | null; outcome: string | null; stage: string; stageEnteredAt: string; ownerUserId: string | null }

const LATE_STAGES = new Set(["possession", "invoiced", "recognised", "collected"]);
export const REFERRAL_WINDOW_DAYS = 60;

export function referralSuggestions(deals: WonDealCtx[], today: string): RelSuggestion[] {
  const out: RelSuggestion[] = [];
  for (const d of deals) {
    const won = d.outcome === "won" || LATE_STAGES.has(d.stage);
    if (!won) continue;
    const since = daysBetween(d.stageEnteredAt.slice(0, 10), today);
    if (since < 0 || since > REFERRAL_WINDOW_DAYS) continue;
    out.push({
      key: `caretaker:referral:opp:${d.id}`, kind: "referral", title: `Ask ${d.orgName ?? "the client"} for a referral`,
      why: `${d.name} reached ${d.outcome === "won" ? "a won outcome" : d.stage} ${since} day${since === 1 ? "" : "s"} ago (within ${REFERRAL_WINDOW_DAYS} days) — milestone completed`,
      due: null, priority: 35, createTask: false,
      link: { type: "opportunity", id: d.id }, orgIds: [d.orgId], personIds: [], ownerUserId: d.ownerUserId, href: `/deals/${d.id}`,
    });
  }
  return out;
}

/** Renewal prompts from lease-radar call windows that are open or closing (tenant org known). */
export function renewalSuggestions(items: Pick<RadarItem, "leaseId" | "tenantOrgId" | "tenantName" | "assetName" | "callWindow" | "plan" | "status">[]): RelSuggestion[] {
  const out: RelSuggestion[] = [];
  for (const it of items) {
    if (it.status !== "active" || !it.tenantOrgId || !it.callWindow) continue;
    if (it.callWindow.state !== "open" && it.callWindow.state !== "closing") continue;
    out.push({
      key: `caretaker:renewal:${it.leaseId}:${it.callWindow.closes}`, kind: "renewal",
      title: `Renewal / relocation conversation — ${it.tenantName ?? "tenant"}${it.assetName ? ` (${it.assetName})` : ""}`,
      why: `Lease-radar call window ${it.callWindow.state}: ${it.callWindow.opens} → ${it.callWindow.closes}; last decision ${it.plan?.lastDecision ?? "—"}`,
      due: it.callWindow.closes, priority: it.callWindow.state === "closing" ? 60 : 45, createTask: false,
      link: { type: "lease", id: it.leaseId }, orgIds: [it.tenantOrgId], personIds: [], ownerUserId: null, href: `/leases?lease=${it.leaseId}`,
    });
  }
  return out;
}

const RESTRICTIVE = /do\s*not\s*(contact|call|email|approach)|don'?t\s*(contact|call|email)|no\s*(further\s*)?(contact|outreach|calls?)|opt(ed)?[\s-]*out|unsubscrib|\bdnc\b|suppress|stop\s*contact/i;

/** A free-text contact restriction that forbids proactive contact (conservative: any opt-out wording counts). */
export function isRestrictive(text: string | null | undefined): boolean {
  return !!text && RESTRICTIVE.test(text);
}

export interface Restrictions { persons: Set<string>; orgs: Set<string> }

/** Drop suggestions touching a suppressed/opted-out person or a contact-restricted company. */
export function applyRestrictions(items: RelSuggestion[], r: Restrictions): { kept: RelSuggestion[]; withheld: { key: string; kind: SuggestionKind; reason: string }[] } {
  const kept: RelSuggestion[] = [];
  const withheld: { key: string; kind: SuggestionKind; reason: string }[] = [];
  for (const s of items) {
    const p = s.personIds.find((x) => r.persons.has(x));
    const o = s.orgIds.find((x) => r.orgs.has(x));
    if (p || o) withheld.push({ key: s.key, kind: s.kind, reason: p ? "contact opted out / suppressed" : "company contact restriction" });
    else kept.push(s);
  }
  return { kept, withheld };
}

export function sortSuggestions(items: RelSuggestion[]): RelSuggestion[] {
  return [...items].sort((a, b) => b.priority - a.priority || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
}
