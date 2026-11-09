/**
 * Contact Enrichment — deterministic rules (no AI, no network): email & phone checks, department / role / CRE relevance
 * classification, identity matching and completeness. AI only proposes; these rules decide statuses.
 */
export type EmailStatus = "verified" | "likely_valid" | "unverified" | "invalid" | "risky" | "generic" | "unknown";
export type PhoneStatus = "published_business" | "switchboard" | "business_mobile" | "user_provided" | "unverified" | "invalid" | "unknown";
export type RoleClass = "decision_maker" | "economic_buyer" | "technical_evaluator" | "operational" | "influencer" | "gatekeeper" | "procurement" | "administrative" | "unknown";
export type Relevance = "high" | "medium" | "low" | "none" | "unknown";
export interface Ev { check: string; ok: boolean | null; note: string; at: string }

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ROLE_BOX = /^(info|contact|hello|sales|support|admin|office|hr|careers|jobs|enquiries|enquiry|reception|marketing|press|media|accounts|billing|team|mail|noreply|no-reply)@/i;
const FREE = /@(gmail|yahoo|hotmail|outlook|live|icloud|rediffmail|proton|protonmail|aol|zoho)\./i;

/**
 * Email status from evidence only. Syntax and MX never prove a mailbox exists; a guessed address is never "verified".
 * verified = confirmed by the person / a licensed provider; likely_valid = published on an official source + MX ok.
 */
export function emailStatus(i: { email: string; companyDomain?: string | null; mx?: boolean | null; published?: boolean; confirmedBy?: "person" | "provider" | null; guessed?: boolean }): { status: EmailStatus; evidence: Ev[] } {
  const at = new Date().toISOString();
  const ev: Ev[] = [];
  const e = i.email.trim().toLowerCase();
  const syntax = EMAIL_RE.test(e);
  ev.push({ check: "syntax", ok: syntax, note: syntax ? "Valid format (does not prove the mailbox exists)" : "Not a valid email format", at });
  if (!syntax) return { status: "invalid", evidence: ev };
  const domain = e.split("@")[1];
  if (i.mx !== undefined) ev.push({ check: "mx", ok: i.mx, note: i.mx === null ? "MX lookup not available" : i.mx ? `${domain} accepts mail (does not prove this mailbox exists)` : `${domain} has no mail servers`, at });
  if (i.mx === false) return { status: "invalid", evidence: ev };
  const cd = (i.companyDomain ?? "").replace(/^www\./, "").toLowerCase();
  if (cd) ev.push({ check: "domain", ok: domain === cd || domain.endsWith(`.${cd}`), note: domain === cd || domain.endsWith(`.${cd}`) ? `Matches company domain ${cd}` : `Domain ${domain} differs from company domain ${cd}`, at });
  if (ROLE_BOX.test(e)) { ev.push({ check: "role_address", ok: null, note: "Shared / role inbox, not a personal business address", at }); return { status: "generic", evidence: ev }; }
  if (FREE.test(e)) { ev.push({ check: "free_provider", ok: false, note: "Personal webmail — not a business address", at }); return { status: "risky", evidence: ev }; }
  if (i.confirmedBy) { ev.push({ check: "confirmed", ok: true, note: i.confirmedBy === "person" ? "Confirmed by the person / user" : "Confirmed by a licensed provider", at }); return { status: "verified", evidence: ev }; }
  if (i.guessed) { ev.push({ check: "guessed", ok: null, note: "Pattern guess — never treated as verified", at }); return { status: "unverified", evidence: ev }; }
  if (i.published && (!cd || domain === cd || domain.endsWith(`.${cd}`))) { ev.push({ check: "published", ok: true, note: "Published on the cited source", at }); return { status: "likely_valid", evidence: ev }; }
  if (cd && domain !== cd && !domain.endsWith(`.${cd}`)) return { status: "risky", evidence: ev };
  return { status: "unverified", evidence: ev };
}

/** MX lookup (server only). Returns null when DNS is unavailable — never guesses. */
export async function hasMx(domain: string): Promise<boolean | null> {
  try {
    const dns = await import("node:dns/promises");
    const r = await Promise.race([dns.resolveMx(domain), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    return Array.isArray(r) && r.length > 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? false : null;
  }
}

const CC: [string, string][] = [["+91", "India"], ["+1", "US/Canada"], ["+44", "UK"], ["+65", "Singapore"], ["+971", "UAE"], ["+61", "Australia"], ["+49", "Germany"], ["+33", "France"], ["+81", "Japan"]];
/** Normalises a phone; keeps extension; classifies by where it was published. Never infers who owns a number. */
export function phoneInfo(raw: string, ctx: { published?: boolean; onCompanyContactPage?: boolean; userProvided?: boolean; mobileExplicit?: boolean } = {}): { e164: string | null; display: string; country: string | null; ext: string | null; status: PhoneStatus; note: string } {
  const ext = raw.match(/(?:ext\.?|x|extension)\s*(\d{1,6})/i)?.[1] ?? null;
  let d = raw.replace(/(?:ext\.?|x|extension)\s*\d{1,6}/i, "").replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = `+${d.slice(2)}`;
  if (!d.startsWith("+")) { const digits = d.replace(/^0+/, ""); d = digits.length === 10 ? `+91${digits}` : digits.length >= 11 && digits.startsWith("91") ? `+${digits}` : `+${digits}`; }
  const digits = d.slice(1);
  const valid = digits.length >= 8 && digits.length <= 15;
  const cc = CC.find(([p]) => d.startsWith(p));
  const isInMobile = d.startsWith("+91") && /^[6-9]\d{9}$/.test(digits.slice(2));
  const display = d.startsWith("+91") && digits.length === 12 ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : d;
  if (!valid) return { e164: null, display: raw, country: null, ext, status: "invalid", note: "Not a valid phone number length" };
  const status: PhoneStatus = ctx.userProvided ? "user_provided" : ctx.onCompanyContactPage ? "switchboard" : ctx.published && isInMobile && ctx.mobileExplicit ? "business_mobile" : ctx.published ? "published_business" : "unverified";
  return { e164: d, display: ext ? `${display} ext ${ext}` : display, country: cc?.[1] ?? null, ext, status,
    note: status === "unverified" ? "Source does not show it is this person's business number" : status === "switchboard" ? "Company switchboard (not a direct line)" : status === "user_provided" ? "Provided by a user" : "Published on the cited source" };
}

// ---------------------------------------------------------------- departments, roles and CRE relevance

export const DEPARTMENTS: { key: string; label: string; re: RegExp; relevance: Relevance }[] = [
  { key: "real_estate", label: "Corporate Real Estate", re: /(corporate real estate|\bcre\b|real estate|workplace strategy|workplace experience|portfolio manager)/i, relevance: "high" },
  { key: "facilities", label: "Facilities & Administration", re: /(facilit|administration|\badmin\b|general admin|workplace operations|office admin|infrastructure manager)/i, relevance: "high" },
  { key: "procurement", label: "Procurement", re: /(procure|sourcing|vendor management|purchas)/i, relevance: "medium" },
  { key: "finance", label: "Finance", re: /(\bcfo\b|chief financial|finance|financial controller|controller|treasur)/i, relevance: "medium" },
  { key: "hr", label: "Human Resources", re: /(\bchro\b|human resources|\bhr\b|people|talent|workforce)/i, relevance: "low" },
  { key: "leadership", label: "Business Leadership", re: /(managing director|\bmd\b|\bceo\b|chief executive|\bcoo\b|chief operating|country head|india head|gcc head|head of gcc|business unit head|regional head|site head|centre head|center head)/i, relevance: "medium" },
];
export function department(title: string | null | undefined): { key: string; label: string; relevance: Relevance } | null {
  const t = title ?? "";
  const d = DEPARTMENTS.find((x) => x.re.test(t));
  return d ? { key: d.key, label: d.label, relevance: d.relevance } : null;
}

const SENIOR = /(head|director|chief|\bvp\b|vice president|lead|country|india|\bgm\b|general manager|president|\bc[a-z]o\b|controller)/i;
const JUNIOR = /(assistant|associate|executive|coordinator|intern|trainee|analyst)/i;

/** Role in a CRE transaction. A designation alone never establishes purchasing authority — reasons say so. */
export function classify(title: string | null | undefined, extra: { transactionInvolved?: boolean } = {}): { role: RoleClass; relevance: Relevance; department: string | null; reason: string } {
  const t = (title ?? "").trim();
  if (!t) return { role: "unknown", relevance: "unknown", department: null, reason: "No designation recorded — role unknown." };
  const d = department(t);
  const senior = SENIOR.test(t) && !/assistant to/i.test(t);
  if (/(executive assistant|personal assistant|secretary|receptionist|front office)/i.test(t)) return { role: "gatekeeper", relevance: "low", department: d?.label ?? null, reason: `${t}: controls access, not a decision role.` };
  if (extra.transactionInvolved) return { role: "decision_maker", relevance: "high", department: d?.label ?? null, reason: `${t}: involvement in a transaction is verified.` };
  if (!d) return { role: "unknown", relevance: "none", department: null, reason: `${t}: no known link to property decisions.` };
  switch (d.key) {
    case "real_estate": return senior ? { role: "decision_maker", relevance: "high", department: d.label, reason: `${t}: leads real estate / workplace — usually owns office decisions (confirm sign-off).` }
      : { role: "technical_evaluator", relevance: "high", department: d.label, reason: `${t}: works on real estate / workplace; evaluates options.` };
    case "facilities": return senior ? { role: "technical_evaluator", relevance: "high", department: d.label, reason: `${t}: senior facilities/admin role — typically runs office moves; approval may sit elsewhere.` }
      : { role: JUNIOR.test(t) ? "administrative" : "operational", relevance: "medium", department: d.label, reason: `${t}: operational facilities/admin role.` };
    case "procurement": return { role: "procurement", relevance: senior ? "medium" : "low", department: d.label, reason: `${t}: runs the buying process; not the space decision.` };
    case "finance": return senior ? { role: "economic_buyer", relevance: "medium", department: d.label, reason: `${t}: senior finance — likely approves cost; not confirmed for property.` }
      : { role: "influencer", relevance: "low", department: d.label, reason: `${t}: finance team member.` };
    case "hr": return { role: "influencer", relevance: senior ? "low" : "none", department: d.label, reason: `${t}: shapes headcount and workplace policy; rarely decides space.` };
    case "leadership": return /(country head|india head|gcc head|head of gcc|site head|centre head|center head|managing director)/i.test(t)
      ? { role: "decision_maker", relevance: "medium", department: d.label, reason: `${t}: local leadership — often signs off on sites (seniority alone is not proof).` }
      : { role: "influencer", relevance: "low", department: d.label, reason: `${t}: senior, but property decisions usually sit with real estate / facilities / finance.` };
  }
  return { role: "unknown", relevance: "unknown", department: d.label, reason: t };
}

// ---------------------------------------------------------------- identity matching (never by name alone)

export const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\b(mr|mrs|ms|dr|shri|smt)\.?\s+/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

export interface Existing { id: string; full_name: string; aliases: string[]; emails: string[]; profile: string | null; current_org_ids: string[]; past_org_ids: string[] }
export interface Cand { full_name: string; emails: string[]; profile: string | null; org_id: string | null }
export type Match = { kind: "existing" | "possible_duplicate" | "job_change" | "new"; person_id: string | null; reason: string; candidates: { id: string; name: string; why: string }[] };

export function matchIdentity(c: Cand, people: Existing[]): Match {
  const emails = new Set(c.emails.map((e) => e.toLowerCase()));
  const byEmail = people.filter((p) => p.emails.some((e) => emails.has(e.toLowerCase())));
  if (byEmail.length === 1) return { kind: "existing", person_id: byEmail[0].id, reason: "Same email address as an existing contact.", candidates: [] };
  const prof = c.profile?.replace(/\/+$/, "").toLowerCase();
  const byProfile = prof ? people.filter((p) => p.profile?.replace(/\/+$/, "").toLowerCase() === prof) : [];
  if (byProfile.length === 1) return { kind: "existing", person_id: byProfile[0].id, reason: "Same professional profile link.", candidates: [] };
  const n = normName(c.full_name);
  const same = people.filter((p) => normName(p.full_name) === n || p.aliases.some((a) => normName(a) === n));
  if (!same.length) return { kind: "new", person_id: null, reason: "No existing contact with this email, profile or name.", candidates: [] };
  const atOrg = c.org_id ? same.filter((p) => p.current_org_ids.includes(c.org_id!)) : [];
  if (atOrg.length === 1) return { kind: "existing", person_id: atOrg[0].id, reason: "Same name and already recorded at this company (name + company context).", candidates: [] };
  const elsewhere = same.filter((p) => p.current_org_ids.length && !p.current_org_ids.includes(c.org_id ?? ""));
  if (elsewhere.length === 1 && !same.some((p) => p.current_org_ids.includes(c.org_id ?? ""))) return { kind: "job_change", person_id: null, reason: "Same name currently recorded at another company — possible job change or a different person. Needs review.", candidates: elsewhere.map((p) => ({ id: p.id, name: p.full_name, why: "Same name, different current employer" })) };
  return { kind: "possible_duplicate", person_id: null, reason: "Same name as existing contact(s); name alone is not enough to merge.", candidates: same.map((p) => ({ id: p.id, name: p.full_name, why: p.current_org_ids.length ? "Same name" : "Same name, no current employer" })) };
}

export const FIELD_WEIGHTS: Record<string, number> = { full_name: 10, designation: 20, employer: 20, department: 10, email: 20, phone: 10, profile: 5, location: 5 };
export function completeness(fields: { field: string; value: unknown; status: string }[]): number {
  const have = new Set(fields.filter((f) => f.value != null && f.value !== "" && !["invalid", "missing"].includes(f.status)).map((f) => f.field));
  const tot = Object.values(FIELD_WEIGHTS).reduce((a, b) => a + b, 0);
  return Math.round((Object.entries(FIELD_WEIGHTS).filter(([k]) => have.has(k)).reduce((a, [, w]) => a + w, 0) / tot) * 100);
}
