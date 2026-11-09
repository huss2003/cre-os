/**
 * Module 7 — Meeting Preparation: deterministic rules (meeting types, question bank with "already answered" checks,
 * objection bank, site-visit checklist, readiness score, .ics parsing). No AI in this file.
 */
export type Kind = "fact" | "history" | "inference" | "suggestion" | "unknown";
export interface Q { key: string; text: string; group: "company" | "requirement" | "decision" | "financial" | "landlord" | "strategic"; answered?: string | null }

export const MEETING_TYPES: Record<string, { label: string; purpose: string; groups: Q["group"][]; outcome: string; visitKind: "meeting" | "site_visit" | "internal" }> = {
  discovery: { label: "Client discovery", purpose: "Understand the business, current office situation and future plans.", groups: ["company", "requirement", "decision"], outcome: "Agree whether there is a requirement worth working on, and a next conversation.", visitKind: "meeting" },
  requirement: { label: "Requirement discussion", purpose: "Pin down area, location, budget and timeline.", groups: ["requirement", "financial", "decision"], outcome: "A confirmed requirement brief and a shortlist date.", visitKind: "meeting" },
  property_presentation: { label: "Property presentation", purpose: "Present suitable buildings and spaces.", groups: ["requirement", "financial", "decision"], outcome: "A ranked shortlist and site visits booked.", visitKind: "meeting" },
  site_visit: { label: "Site visit", purpose: "Evaluate a property physically with the client.", groups: ["requirement", "decision"], outcome: "Clear go / no-go per property and the next step.", visitKind: "site_visit" },
  landlord: { label: "Landlord meeting", purpose: "Availability, commercial terms, mandate and leasing.", groups: ["landlord"], outcome: "Verified availability and terms, and mandate status.", visitKind: "meeting" },
  renewal: { label: "Lease renewal", purpose: "Discuss the upcoming expiry, renewal or alternatives.", groups: ["requirement", "financial", "decision"], outcome: "Agreement to benchmark the renewal against the market.", visitKind: "meeting" },
  negotiation: { label: "Negotiation", purpose: "Rent, deposit, escalation, incentives and conditions.", groups: ["financial", "decision"], outcome: "Agreed or narrowed commercial terms and a sign-off path.", visitKind: "meeting" },
  introduction: { label: "Corporate introduction", purpose: "Establish a relationship with a company or decision-maker.", groups: ["company", "decision"], outcome: "Permission to stay in touch and one useful follow-up.", visitKind: "meeting" },
  gcc: { label: "GCC set-up", purpose: "Requirements for setting up or expanding a GCC.", groups: ["company", "requirement", "decision", "financial"], outcome: "Headcount ramp, location shortlist criteria and decision timeline.", visitKind: "meeting" },
  internal: { label: "Internal strategy", purpose: "Review status, strategy, risks and next steps.", groups: ["strategic"], outcome: "Agreed owner and next action for each open item.", visitKind: "internal" },
};

/** Question bank. `check` decides from records whether the question is already answered (so it isn't repeated). */
type Rec = { req: Record<string, any> | null; stakeholders: number; leases: number; offices: number };
export const QUESTIONS: (Q & { check?: (r: Rec) => string | null; priority: number })[] = [
  { key: "pune_ops", group: "company", priority: 1, text: "How are your Pune operations structured today?", check: (r) => (r.offices ? `${r.offices} office(s) on record` : null) },
  { key: "footprint_change", group: "company", priority: 2, text: "Are any changes planned to your office footprint in the next 12–24 months?" },
  { key: "fit", group: "company", priority: 3, text: "Is your current space meeting your operational needs?" },
  { key: "lease_dates", group: "company", priority: 4, text: "When do your current leases expire or reach lock-in end?", check: (r) => (r.leases ? `${r.leases} lease(s) on record` : null) },
  { key: "seats", group: "requirement", priority: 1, text: "What seating capacity do you need?", check: (r) => (r.req?.seats_target ? `${r.req.seats_target} seats on record` : null) },
  { key: "area", group: "requirement", priority: 2, text: "What office area are you looking for?", check: (r) => (r.req?.area_target_sf ? `${r.req.area_target_sf} sq ft on record` : null) },
  { key: "locations", group: "requirement", priority: 3, text: "Which micro-markets are preferred, and which are ruled out?", check: (r) => (r.req?.preferred_geography_ids?.length ? "Preferred locations on record" : null) },
  { key: "move_in", group: "requirement", priority: 4, text: "What is the target move-in date?", check: (r) => (r.req?.occupation_date ? `Move-in ${r.req.occupation_date} on record` : null) },
  { key: "objective", group: "requirement", priority: 5, text: "Is this an expansion, a relocation or a consolidation?", check: (r) => (r.req?.objective ? `Objective: ${r.req.objective}` : null) },
  { key: "tenure", group: "requirement", priority: 6, text: "What lease length and lock-in would you prefer?" },
  { key: "who_else", group: "decision", priority: 1, text: "Who else is involved in the property decision?", check: (r) => (r.stakeholders >= 2 ? `${r.stakeholders} stakeholders on record` : null) },
  { key: "approval", group: "decision", priority: 2, text: "What is the internal approval process?" },
  { key: "decision_date", group: "decision", priority: 3, text: "When does a decision need to be made?", check: (r) => (r.req?.decision_date ? `Decision ${r.req.decision_date} on record` : null) },
  { key: "evaluator", group: "decision", priority: 4, text: "Who evaluates the commercial proposal?" },
  { key: "budget", group: "financial", priority: 1, text: "What rental range are you working with?", check: (r) => (r.req?.budget_max ? `Budget up to ${r.req.budget_max} on record` : null) },
  { key: "deposit", group: "financial", priority: 2, text: "What security-deposit structure is acceptable?" },
  { key: "all_in", group: "financial", priority: 3, text: "Does the budget include CAM, parking and fit-out?" },
  { key: "commitments", group: "financial", priority: 4, text: "Are there existing contractual commitments we should know about?" },
  { key: "ll_area", group: "landlord", priority: 1, text: "What is the actual available area right now?" },
  { key: "ll_possession", group: "landlord", priority: 2, text: "When can possession be offered?" },
  { key: "ll_flex", group: "landlord", priority: 3, text: "What commercial flexibility is available?" },
  { key: "ll_mandate", group: "landlord", priority: 4, text: "Is the property exclusively mandated?" },
  { key: "ll_incentives", group: "landlord", priority: 5, text: "What incentives (rent-free, fit-out) are available?" },
  { key: "st_risk", group: "strategic", priority: 1, text: "What is the biggest risk to this deal right now?" },
  { key: "st_owner", group: "strategic", priority: 2, text: "Who owns each next action, and by when?" },
  { key: "st_why_us", group: "strategic", priority: 3, text: "Why would this client choose us over doing it themselves or another adviser?" },
];

/** 5 essential + 5 additional + up to 3 strategic; answered questions are kept but flagged and pushed down. */
export function pickQuestions(type: string, rec: Rec) {
  const groups = MEETING_TYPES[type]?.groups ?? ["company", "requirement"];
  const all = QUESTIONS.filter((q) => groups.includes(q.group)).map((q) => ({ key: q.key, text: q.text, group: q.group, answered: q.check?.(rec) ?? null, priority: q.priority }));
  const open = all.filter((q) => !q.answered).sort((a, b) => a.priority - b.priority || groups.indexOf(a.group) - groups.indexOf(b.group));
  const answered = all.filter((q) => q.answered);
  const essential = open.slice(0, 5);
  const additional = [...open.slice(5, 8), ...answered].slice(0, 5);   // answered ones stay visible, flagged
  const strategic = type === "internal" ? [] : QUESTIONS.filter((q) => q.group === "strategic").slice(0, 3).map((q) => ({ key: q.key, text: q.text, group: q.group, answered: null, priority: q.priority }));
  return { essential, additional, strategic };
}

export const OBJECTIONS: Record<string, { objection: string; meaning: string; response: string; follow_up: string; evidence: string; types: string[] }> = {
  broker: { objection: "We already have a broker", meaning: "They may be committed, or only loosely engaged.", response: "Understand the scope of the current engagement and offer independent market data where it helps.", follow_up: "What would you want from an adviser that you're not getting today?", evidence: "Recent comparable deals in their micro-market", types: ["discovery", "introduction", "requirement", "gcc"] },
  not_looking: { objection: "We are not looking for space", meaning: "No active need yet; timing may be the issue.", response: "Respect it; ask about lease dates or headcount changes that could trigger a need.", follow_up: "When is your next lease event?", evidence: "Their lease expiry / lock-in dates if on record", types: ["discovery", "introduction", "renewal"] },
  rent_high: { objection: "The proposed rent is high", meaning: "Budget gap, or the cost basis isn't clear.", response: "Show comparable evidence and clarify carpet vs chargeable and what's included.", follow_up: "What all-in number would work?", evidence: "Rent comparables and a like-for-like cost sheet", types: ["property_presentation", "negotiation", "site_visit", "renewal"] },
  evaluating: { objection: "We are still evaluating", meaning: "Criteria or decision-makers aren't settled.", response: "Agree the decision criteria and timeline.", follow_up: "What would make one option clearly better?", evidence: "A simple comparison matrix of options", types: ["requirement", "property_presentation", "site_visit", "negotiation", "gcc"] },
  landlord_rel: { objection: "We have a good relationship with our landlord", meaning: "Renewal is the default.", response: "Offer an independent market benchmark so they renew on the right terms.", follow_up: "Would a market benchmark before you renew be useful?", evidence: "Market rents and recent renewals nearby", types: ["renewal", "discovery"] },
  no_budget: { objection: "We don't have a budget yet", meaning: "Early stage; finance not engaged.", response: "Offer preliminary market research to help them build one.", follow_up: "Would an indicative cost range help your internal discussion?", evidence: "Indicative rent and fit-out ranges", types: ["discovery", "requirement", "gcc"] },
  ll_terms: { objection: "Terms are non-negotiable", meaning: "Landlord testing demand.", response: "Bring evidence of comparable availability and the client's quality as a tenant.", follow_up: "What flexibility exists on rent-free or fit-out?", evidence: "Competing availability in the micro-market", types: ["landlord", "negotiation"] },
};
export function objectionsFor(type: string) {
  return Object.values(OBJECTIONS).filter((o) => o.types.includes(type)).slice(0, 4).map(({ types: _t, ...o }) => o);
}

export const SITE_VISIT: Record<"before" | "during" | "after", { key: string; label: string }[]> = {
  before: ["Confirm property availability", "Confirm access permissions", "Confirm meeting point", "Confirm attendees", "Brochure ready", "Floor plan ready", "Commercial details ready", "Review client requirement", "Check travel and access"].map((l, i) => ({ key: `b${i}`, label: l })),
  during: ["Building access", "Common areas", "Office space", "Natural light", "Infrastructure (power, HVAC)", "Parking", "Amenities", "Connectivity", "Client feedback noted", "Concerns noted"].map((l, i) => ({ key: `d${i}`, label: l })),
  after: ["Property feedback recorded", "Objections captured", "Requested information listed", "Property suitability updated", "Follow-up tasks created", "Opportunity status updated"].map((l, i) => ({ key: `a${i}`, label: l })),
};

/** Configurable weights; separate from Module 3 scores. */
export const READINESS = [
  { key: "purpose", label: "Meeting purpose", weight: 15 },
  { key: "attendees", label: "Attendees identified", weight: 15 },
  { key: "company", label: "Company research", weight: 10 },
  { key: "contacts", label: "Contact details", weight: 5 },
  { key: "history", label: "Previous interactions reviewed", weight: 10 },
  { key: "requirement", label: "Requirement information", weight: 15 },
  { key: "property", label: "Property information", weight: 10 },
  { key: "materials", label: "Supporting documents", weight: 5 },
  { key: "questions", label: "Questions prepared", weight: 10 },
  { key: "outcome", label: "Desired outcome", weight: 5 },
] as const;
export function readiness(x: Record<(typeof READINESS)[number]["key"], number>, notes: Partial<Record<string, string>>) {
  let got = 0, tot = 0; const missing: string[] = []; const critical: string[] = [];
  for (const f of READINESS) {
    const v = Math.max(0, Math.min(1, x[f.key] ?? 0));
    tot += f.weight; got += f.weight * v;
    if (v < 1) (f.weight >= 15 && v < 0.5 ? critical : missing).push(notes[f.key] ?? f.label);
  }
  return { score: Math.round((got / tot) * 100), missing, critical };
}

/** Minimal RFC 5545 reader for VEVENTs (unfolds lines, TZ-less times treated as IST). Content is untrusted data. */
export function parseIcs(text: string) {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: { uid: string | null; title: string; start: string | null; end: string | null; location: string | null; description: string | null; attendees: { name: string | null; email: string }[]; organizer: string | null; status: string | null }[] = [];
  let cur: (typeof out)[number] | null = null;
  const dt = (v: string) => {
    const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/); if (!m) return null;
    const [, y, mo, d, h = "09", mi = "00", s = "00", z] = m;
    return z ? `${y}-${mo}-${d}T${h}:${mi}:${s}Z` : new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+05:30`).toISOString();
  };
  const unesc = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") { cur = { uid: null, title: "", start: null, end: null, location: null, description: null, attendees: [], organizer: null, status: null }; continue; }
    if (l === "END:VEVENT") { if (cur?.start) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const [name, ...params] = l.slice(0, i).split(";"); const val = l.slice(i + 1);
    const cn = params.find((p) => p.toUpperCase().startsWith("CN="))?.slice(3).replace(/^"|"$/g, "") ?? null;
    switch (name.toUpperCase()) {
      case "UID": cur.uid = val; break;
      case "SUMMARY": cur.title = unesc(val).slice(0, 300); break;
      case "DTSTART": cur.start = dt(val); break;
      case "DTEND": cur.end = dt(val); break;
      case "LOCATION": cur.location = unesc(val).slice(0, 300); break;
      case "DESCRIPTION": cur.description = unesc(val).slice(0, 4000); break;
      case "STATUS": cur.status = val.toLowerCase(); break;
      case "ORGANIZER": cur.organizer = val.replace(/^mailto:/i, ""); break;
      case "ATTENDEE": { const email = val.replace(/^mailto:/i, "").trim(); if (/@/.test(email)) cur.attendees.push({ name: cn, email: email.toLowerCase() }); break; }
    }
  }
  return out;
}

export function typeFromTitle(t: string): string {
  const s = t.toLowerCase();
  if (/site visit|visit to|walkthrough|walk-through/.test(s)) return "site_visit";
  if (/renew/.test(s)) return "renewal";
  if (/negotiat|term sheet|loi|commercials/.test(s)) return "negotiation";
  if (/landlord|developer/.test(s)) return "landlord";
  if (/gcc/.test(s)) return "gcc";
  if (/present|options|shortlist/.test(s)) return "property_presentation";
  if (/requirement|brief/.test(s)) return "requirement";
  if (/internal|pipeline|review|strategy/.test(s)) return "internal";
  if (/intro/.test(s)) return "introduction";
  return "discovery";
}
