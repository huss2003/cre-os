import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { proposeChange } from "@/lib/services/changes";
import { contactValueHash } from "@/lib/services/drafts";
import * as R from "./rules";

/**
 * Module 7 — Meeting Preparation. A meeting is a mudar.meeting_visit (shared with calendar sync); meeting_prep holds
 * the preparation. Facts come from records (each tagged fact / history / inference / unknown with a source); AI only
 * writes purpose analysis, strategy, objections wording and next steps. Post-meeting notes become PROPOSALS.
 */
type Row = Record<string, any>;
type Ai = typeof callStructured;
export class MeetingError extends Error {}
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export interface Item { text: string; kind: R.Kind; source?: { type: string; id: string | null } | null; changed?: boolean }

// ------------------------------------------------------------------ attendee matching (deterministic, never name-only)
async function matchAttendee(db: Db, ws: string, a: { name?: string | null; email?: string | null }, orgId: string | null) {
  if (a.email) {
    const { data } = await db.from("contact_method").select("person_id").eq("workspace_id", ws).eq("value_hash", contactValueHash(a.email)).limit(2);
    const ids = [...new Set((data ?? []).map((x: Row) => x.person_id))];
    if (ids.length === 1) return { person_id: ids[0], match_status: "matched", match_reason: "Email matches a saved contact" };
  }
  if (a.name && orgId) {
    const { data } = await db.from("employment").select("person_id, person:person_id(full_name)").eq("workspace_id", ws).eq("org_id", orgId).eq("is_current", true).limit(500);
    const n = a.name.toLowerCase().replace(/[^a-z]/g, "");
    const hits = ((data ?? []) as Row[]).filter((e) => String(e.person?.full_name ?? "").toLowerCase().replace(/[^a-z]/g, "") === n);
    if (hits.length === 1) return { person_id: hits[0].person_id, match_status: "suggested", match_reason: "Same name at the same company — please confirm" };
  }
  return { person_id: null, match_status: "unresolved", match_reason: a.email ? "No saved contact with this email" : "Not matched" };
}

export interface CreateInput {
  title: string; start: string; end?: string | null; location?: string | null; type?: string; purpose?: string | null;
  orgId?: string | null; opportunityId?: string | null; requirementId?: string | null; assetIds?: string[];
  personIds?: string[]; external?: { name?: string | null; email?: string | null }[]; notes?: string | null;
  ownerUserId?: string | null; source?: "manual" | "calendar" | "ics_import"; sourceRaw?: Row | null; meetingVisitId?: string | null;
}
/** Create (or attach to an existing meeting_visit). Warns about duplicates: same company within ±60 min, or same calendar UID. */
export async function createMeeting(db: Db, ws: string, userId: string, inp: CreateInput) {
  if (!inp.title?.trim() || !inp.start) throw new MeetingError("Title and start time are required.");
  const start = new Date(inp.start); if (isNaN(+start)) throw new MeetingError("Invalid start time.");
  const end = inp.end ? new Date(inp.end) : new Date(+start + 60 * 6e4);
  const type = inp.type && R.MEETING_TYPES[inp.type] ? inp.type : R.typeFromTitle(inp.title);
  const dupes: string[] = [];
  const uid = inp.sourceRaw?.uid;
  if (uid) {
    const { data } = await db.from("meeting_prep").select("id").eq("workspace_id", ws).eq("source_raw->>uid", uid).is("archived_at", null).limit(1);
    if (data?.length) return { id: data[0].id as string, duplicate: true, dupes: ["Already imported (same calendar event)"] };
  }
  if (inp.orgId) {
    const { data } = await db.from("meeting_prep").select("id, meeting:meeting_visit_id(start_at, title)").eq("workspace_id", ws).eq("org_id", inp.orgId).is("archived_at", null).limit(50);
    for (const m of (data ?? []) as Row[]) if (m.meeting && Math.abs(Date.parse(m.meeting.start_at) - +start) < 60 * 6e4) dupes.push(`Possible duplicate: "${m.meeting.title}" at the same time`);
  }
  let mvId = inp.meetingVisitId ?? null;
  if (!mvId) {
    const { data: mv, error } = await db.from("meeting_visit").insert({ workspace_id: ws, title: inp.title.slice(0, 300), start_at: start.toISOString(), end_at: end.toISOString(), location: inp.location ?? null, kind: R.MEETING_TYPES[type].visitKind === "internal" ? "internal" : R.MEETING_TYPES[type].visitKind, status: "confirmed", opportunity_id: inp.opportunityId ?? null, linked_entity_type: inp.orgId ? "organisation" : null, linked_entity_id: inp.orgId ?? null, provider: "manual", owner_user_id: inp.ownerUserId ?? userId }).select("id").single();
    if (error) throw error;
    mvId = mv.id;
  }
  const { data: prep, error } = await db.from("meeting_prep").insert({ workspace_id: ws, meeting_visit_id: mvId, meeting_type: type, purpose: inp.purpose ?? null, org_id: inp.orgId ?? null, opportunity_id: inp.opportunityId ?? null, requirement_id: inp.requirementId ?? null, asset_ids: inp.assetIds ?? [], status: "preparation_pending", source: inp.source ?? "manual", source_raw: inp.sourceRaw ?? null, remind_at: new Date(+start - 24 * 3600e3).toISOString(), owner_user_id: inp.ownerUserId ?? userId }).select("id").single();
  if (error) throw error;
  const rows: Row[] = [];
  for (const pid of [...new Set(inp.personIds ?? [])]) rows.push({ workspace_id: ws, prep_id: prep.id, person_id: pid, match_status: "manual", match_reason: "Chosen by you", owner_user_id: userId });
  for (const a of inp.external ?? []) {
    if (!a.name && !a.email) continue;
    const m = await matchAttendee(db, ws, a, inp.orgId ?? null);
    if (m.person_id && rows.some((r) => r.person_id === m.person_id)) continue;
    rows.push({ workspace_id: ws, prep_id: prep.id, raw_name: a.name ?? null, raw_email: a.email ?? null, ...m, owner_user_id: userId });
  }
  if (rows.length) await db.from("meeting_prep_attendee").insert(rows);
  if (inp.notes?.trim()) await db.from("meeting_note").insert({ workspace_id: ws, prep_id: prep.id, kind: "note", text: inp.notes.trim().slice(0, 4000), owner_user_id: userId });
  return { id: prep.id as string, duplicate: false, dupes };
}

/** .ics import: every VEVENT becomes a meeting; attendees are matched by email; re-import is idempotent by UID. */
export async function importIcs(db: Db, ws: string, userId: string, text: string) {
  const evs = R.parseIcs(text);
  if (!evs.length) throw new MeetingError("No events found in that file.");
  let created = 0, skipped = 0; const ids: string[] = [];
  for (const e of evs.slice(0, 100)) {
    if (e.status === "cancelled") { skipped++; continue; }
    const domains = [...new Set(e.attendees.map((a) => a.email.split("@")[1]))];
    const { data: org } = domains.length ? await db.from("organisation").select("id").eq("workspace_id", ws).in("domain", domains).limit(1).maybeSingle() : { data: null };
    const r = await createMeeting(db, ws, userId, { title: e.title || "Meeting", start: e.start!, end: e.end, location: e.location, orgId: org?.id ?? null, external: e.attendees.filter((a) => a.email !== e.organizer?.toLowerCase()), source: "ics_import", sourceRaw: { uid: e.uid, organizer: e.organizer, description: e.description, attendees: e.attendees } });
    if (r.duplicate) skipped++; else { created++; ids.push(r.id); }
  }
  return { created, skipped, ids };
}

/** Calendar connector path: meetings synced by the integrations module (meeting_visit + calendar_event) get a prep. */
export async function syncFromCalendar(db: Db, ws: string, userId: string | null, days = 14) {
  const { data, error } = await db.from("meeting_visit").select("id, title, start_at, end_at, location, owner_user_id, status, calendar_event(attendees, organizer, external_id), meeting_prep(id)").eq("workspace_id", ws).neq("provider", "manual").gte("start_at", new Date().toISOString()).lte("start_at", new Date(Date.now() + days * 864e5).toISOString()).limit(200);
  if (error) return { created: 0, error: `Calendar data unavailable: ${error.message}` };
  let created = 0;
  for (const m of (data ?? []) as Row[]) {
    if ((m.meeting_prep ?? []).length || m.status === "cancelled") continue;
    const ce = Array.isArray(m.calendar_event) ? m.calendar_event[0] : m.calendar_event;
    const att = ((ce?.attendees ?? []) as Row[]).map((a) => ({ name: a.name ?? null, email: String(a.address ?? "").toLowerCase() })).filter((a) => a.email);
    const domains = [...new Set(att.map((a) => a.email.split("@")[1]))];
    const { data: org } = domains.length ? await db.from("organisation").select("id").eq("workspace_id", ws).in("domain", domains).limit(1).maybeSingle() : { data: null };
    await createMeeting(db, ws, userId ?? m.owner_user_id, { title: m.title ?? "Meeting", start: m.start_at, end: m.end_at, location: m.location, orgId: org?.id ?? null, external: att, source: "calendar", sourceRaw: { uid: ce?.external_id ?? null }, meetingVisitId: m.id, ownerUserId: m.owner_user_id });
    created++;
  }
  return { created, error: null as string | null };
}

// ------------------------------------------------------------------ intelligence gathering (records only, RLS-scoped)
export async function gather(db: Db, ws: string, prepId: string) {
  const { data: p } = await db.from("meeting_prep").select("*, meeting:meeting_visit_id(*)").eq("workspace_id", ws).eq("id", prepId).maybeSingle();
  if (!p) throw new MeetingError("Meeting not found or not visible to you.");
  const { data: att } = await db.from("meeting_prep_attendee").select("*").eq("prep_id", prepId).order("created_at");
  const attendeeIds = ((att ?? []) as Row[]).map((a) => a.person_id).filter(Boolean);
  const orgId: string | null = p.org_id;
  const q = <T,>(cond: boolean, f: () => PromiseLike<{ data: T | null }>) => (cond ? f() : Promise.resolve({ data: null as T | null }));
  const [org, leases, signals, reqs, opps, people, links, outreach, tasks, materials, notes, scores, stakeholders, trans] = await Promise.all([
    q<Row>(!!orgId, () => db.from("organisation").select("id, display_name, legal_name, sector, hq_country, headcount_min, headcount_max, is_gcc, domain, updated_at").eq("id", orgId!).maybeSingle()),
    q<Row[]>(!!orgId, () => db.from("lease").select("id, area_sf, contractual_expiry, status, fact_status, asset:asset_id(id, name, address, micro_market:micro_market_id(name), locality:locality_id(name)), lease_event(event_type, event_date, confirmed, date_basis)").eq("workspace_id", ws).eq("tenant_org_id", orgId!).limit(30)),
    q<Row[]>(!!orgId, () => db.from("signal").select("id, title, summary, category, verification, confidence, event_date, latest_evidence_on, detected_at, status").eq("workspace_id", ws).eq("org_id", orgId!).not("status", "in", "(rejected,dismissed)").order("detected_at", { ascending: false }).limit(8)),
    q<Row[]>(!!orgId, () => db.from("requirement").select("*").eq("workspace_id", ws).eq("org_id", orgId!).is("archived_at", null).order("updated_at", { ascending: false }).limit(5)),
    q<Row[]>(!!orgId, () => db.from("opportunity").select("id, name, stage, outcome, next_action, next_action_due, risks, expected_close, requirement_id, temperature").eq("workspace_id", ws).eq("org_id", orgId!).is("archived_at", null).limit(10)),
    q<Row[]>(attendeeIds.length > 0, () => db.from("person").select("id, full_name, do_not_contact, employment(title, is_current, start_date, end_date, org:org_id(display_name)), contact_method(method_type, value, verify_status, suppressed), contact_role_assessment(role_class, cre_relevance, active, rationale)").in("id", attendeeIds)),
    q<Row[]>(attendeeIds.length > 0 || !!orgId, () => db.from("interaction_link").select("entity_type, entity_id, interaction:interaction_id(id, occurred_at, channel, direction, subject, summary, promises, objections, owner_user_id, is_meaningful)").eq("workspace_id", ws).in("entity_id", [...attendeeIds, ...(orgId ? [orgId] : [])]).limit(400)),
    q<Row[]>(attendeeIds.length > 0, () => db.from("outreach_item").select("id, channel, status, reason, sent_at, response, person_id").eq("workspace_id", ws).in("person_id", attendeeIds).order("updated_at", { ascending: false }).limit(20)),
    q<Row[]>(true, () => db.from("task").select("id, title, due_at, status, linked_entity_type, linked_entity_id").eq("workspace_id", ws).eq("status", "open").in("linked_entity_id", [...attendeeIds, ...(orgId ? [orgId] : []), ...(p.opportunity_id ? [p.opportunity_id] : []), prepId]).limit(30)),
    q<Row[]>(true, () => db.from("meeting_material").select("*").eq("prep_id", prepId).order("created_at")),
    q<Row[]>(true, () => db.from("meeting_note").select("*").eq("prep_id", prepId).is("archived_at", null).order("created_at")),
    q<Row[]>(true, () => db.from("score_result").select("model_key, entity_id, score, band").eq("workspace_id", ws).eq("is_current", true).in("entity_id", [...attendeeIds, ...(orgId ? [orgId] : []), ...(p.opportunity_id ? [p.opportunity_id] : [])])),
    q<Row[]>(!!p.requirement_id, () => db.from("stakeholder").select("person_id, role").eq("workspace_id", ws).eq("requirement_id", p.requirement_id!)),
    q<Row[]>(!!orgId, () => db.from("market_transaction").select("id, deal_type, period_start, area_sf, asset:asset_id(name)").eq("workspace_id", ws).eq("tenant_org_id", orgId!).order("period_start", { ascending: false }).limit(5)),
  ]);
  const requirement = ((reqs.data ?? []) as Row[]).find((r) => r.id === p.requirement_id) ?? (p.requirement_id ? null : (reqs.data ?? [])[0] ?? null);
  const opportunity = ((opps.data ?? []) as Row[]).find((o) => o.id === p.opportunity_id) ?? null;
  const ints = [...new Map(((links.data ?? []) as Row[]).map((l) => l.interaction).filter(Boolean).map((i: Row) => [i.id, i])).values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  // properties for presentation / site visit
  let properties: Row[] = [];
  if ((p.asset_ids ?? []).length) {
    const { data: assets } = await db.from("asset").select("id, name, address, grade, status, floors, developer:developer_org_id(display_name), micro_market:micro_market_id(name), locality:locality_id(name), space(id, floor_text, carpet_sf, chargeable_sf, seats, configuration, availability(as_of, status, available_from, asking_rent_min, asking_rent_max, rent_basis, fitout_basis, fact_status))").in("id", p.asset_ids);
    properties = ((assets ?? []) as Row[]).map((a) => matchProperty(a, requirement));
  }
  const sc = (scores.data ?? []) as Row[];
  const attendees = ((att ?? []) as Row[]).map((a) => {
    const pr = ((people.data ?? []) as Row[]).find((x) => x.id === a.person_id) ?? null;
    const emp = pr ? (pr.employment ?? []).find((e: Row) => e.is_current) : null;
    const ra = pr ? (pr.contact_role_assessment ?? []).find((x: Row) => x.active) : null;
    const theirInts = ints.filter((i) => ((links.data ?? []) as Row[]).some((l) => l.interaction?.id === i.id && l.entity_id === a.person_id));
    const channels = pr ? (pr.contact_method ?? []).filter((m: Row) => !m.suppressed && ["verified", "likely_valid", "published_business", "business_mobile", "user_provided"].includes(m.verify_status)).map((m: Row) => `${m.method_type}: ${m.value}`) : [];
    return {
      id: a.id, personId: a.person_id, name: pr?.full_name ?? a.raw_name ?? a.raw_email ?? "Unknown", email: a.raw_email, match: a.match_status, matchReason: a.match_reason,
      title: emp?.title ?? null, company: emp?.org?.display_name ?? null, department: emp?.title ? deptOf(emp.title) : null,
      role: ra?.role_class ?? "unknown", relevance: ra?.cre_relevance ?? null, roleBasis: ra?.rationale ?? null,
      previous: (pr?.employment ?? []).filter((e: Row) => !e.is_current).map((e: Row) => `${e.title ?? "role"} at ${e.org?.display_name ?? "?"}`).slice(0, 3),
      channels, interactions: theirInts.length, lastInteraction: theirInts.at(-1)?.occurred_at?.slice(0, 10) ?? null, doNotContact: !!pr?.do_not_contact,
      contactScore: sc.find((s) => s.model_key === "contact" && s.entity_id === a.person_id)?.score ?? null,
      stakeholderRole: ((stakeholders.data ?? []) as Row[]).find((s) => s.person_id === a.person_id)?.role ?? null,
    };
  });
  const offices = [...new Map(((leases.data ?? []) as Row[]).filter((l) => l.asset).map((l) => [l.asset.id, l.asset])).values()];
  const recIn = { req: requirement, stakeholders: (stakeholders.data ?? []).length, leases: (leases.data ?? []).length, offices: offices.length };
  return { prep: p as Row, meeting: p.meeting as Row, org: org.data as Row | null, leases: (leases.data ?? []) as Row[], offices, signals: (signals.data ?? []) as Row[], requirement, requirements: (reqs.data ?? []) as Row[], opportunity, opportunities: (opps.data ?? []) as Row[], attendees, interactions: ints, outreach: (outreach.data ?? []) as Row[], tasks: (tasks.data ?? []) as Row[], materials: (materials.data ?? []) as Row[], notes: (notes.data ?? []) as Row[], properties, transactions: (trans.data ?? []) as Row[], scores: { lead: sc.find((s) => s.model_key === "lead")?.score ?? null, company: sc.find((s) => s.model_key === "company")?.score ?? null, opportunity: sc.find((s) => s.model_key === "opportunity")?.score ?? null }, recIn };
}
function deptOf(title: string) {
  const t = title.toLowerCase();
  return /real estate|workplace/.test(t) ? "Corporate real estate" : /facilit|admin/.test(t) ? "Facilities & administration" : /financ|cfo/.test(t) ? "Finance" : /procure|sourcing/.test(t) ? "Procurement" : /hr|people|talent/.test(t) ? "HR" : /ceo|md|managing|head of|country|site/.test(t) ? "Leadership" : null;
}
export type Intel = Awaited<ReturnType<typeof gather>>;

/** Property vs requirement — deterministic. Unverified availability is never shown as confirmed. */
export function matchProperty(a: Row, req: Row | null) {
  const spaces: Row[] = ((a.space ?? []) as Row[]).map((s) => ({ ...s, latest: ((s.availability ?? []) as Row[]).sort((x, y) => y.as_of.localeCompare(x.as_of))[0] ?? null }));
  const avail = spaces.filter((s) => s.latest && ["available", "under_offer", "unverified"].includes(s.latest.status));
  const area = avail.reduce((t, s) => t + Number(s.carpet_sf ?? s.chargeable_sf ?? 0), 0);
  const rents = avail.map((s) => Number(s.latest.asking_rent_max ?? s.latest.asking_rent_min)).filter((x) => x > 0);
  const verified = avail.some((s) => s.latest.status === "available" && s.latest.fact_status !== "reported" && (Date.now() - Date.parse(s.latest.as_of)) / 864e5 < 45);
  const match: string[] = [], mismatch: string[] = [], missing: string[] = [], verify: string[] = [];
  if (!avail.length) missing.push("No availability on record");
  if (req?.area_target_sf && area) (area >= Number(req.area_min_sf ?? req.area_target_sf) * 0.9 ? match : mismatch).push(`Area ${Math.round(area)} sq ft vs need ${req.area_target_sf}`);
  else if (req?.area_target_sf) missing.push("Available area unknown");
  if (req?.budget_max && rents.length) (Math.min(...rents) <= Number(req.budget_max) ? match : mismatch).push(`Asking ₹${Math.min(...rents)} vs budget ₹${req.budget_max}`);
  else if (req?.budget_max) missing.push("Asking rent unknown");
  if (req?.occupation_date && avail.some((s) => s.latest.available_from)) (avail.some((s) => s.latest.available_from <= req.occupation_date) ? match : mismatch).push(`Available from ${avail.map((s) => s.latest.available_from).filter(Boolean).sort()[0]} vs move-in ${req.occupation_date}`);
  if (!verified) verify.push("Availability is not recently verified — confirm with the landlord before presenting");
  verify.push("Parking ratio", "Power back-up and HVAC hours", "Fit-out condition and handover date");
  return { id: a.id, name: a.name, developer: a.developer?.display_name ?? null, location: [a.locality?.name, a.micro_market?.name].filter(Boolean).join(", ") || a.address || null, grade: a.grade, status: a.status, floors: a.floors,
    spaces: avail.map((s) => ({ floor: s.floor_text, area: s.carpet_sf ?? s.chargeable_sf, config: s.configuration, status: s.latest.status, from: s.latest.available_from, rent: s.latest.asking_rent_min ? `₹${s.latest.asking_rent_min}${s.latest.asking_rent_max && s.latest.asking_rent_max !== s.latest.asking_rent_min ? `–${s.latest.asking_rent_max}` : ""}/sf (${s.latest.rent_basis ?? "basis?"})` : null, asOf: s.latest.as_of })),
    verified, match, mismatch, missing, verify };
}

/** Readiness — deterministic and separate from Module 3. */
export function assessReadiness(x: Intel, brief: Row | null) {
  const p = x.prep; const req = x.requirement;
  const resolved = x.attendees.filter((a) => a.personId).length;
  const v = {
    purpose: p.purpose ? 1 : brief?.purpose?.why ? 0.6 : 0,
    attendees: !x.attendees.length ? 0 : resolved / x.attendees.length,
    company: !x.org ? 0 : Math.min(1, (x.org.sector ? 0.3 : 0) + (x.offices.length ? 0.3 : 0) + (x.signals.length ? 0.2 : 0) + (x.org.headcount_min ? 0.2 : 0)),
    contacts: !x.attendees.length ? 0 : x.attendees.filter((a) => a.channels.length).length / x.attendees.length,
    history: x.interactions.length ? 1 : 0.5,        // a first meeting is not a defect — half credit, labelled
    requirement: !req ? (["landlord", "introduction", "internal"].includes(p.meeting_type) ? 1 : 0) : [req.seats_target || req.area_target_sf, req.budget_max, req.occupation_date, (req.preferred_geography_ids ?? []).length].filter(Boolean).length / 4,
    property: ["property_presentation", "site_visit"].includes(p.meeting_type) ? (x.properties.length ? x.properties.filter((pp) => pp.verified).length / x.properties.length * 0.5 + 0.5 : 0) : 1,
    materials: x.materials.length ? 1 : ["property_presentation", "site_visit", "negotiation"].includes(p.meeting_type) ? 0 : 0.5,
    questions: brief ? 1 : 0,
    outcome: brief?.outcome?.ideal ? 1 : 0,
  };
  const notes: Record<string, string> = {
    purpose: "Meeting purpose not written", attendees: `${x.attendees.length - resolved} attendee(s) not matched to a contact`, company: "Company profile thin (sector, offices, size, signals)",
    contacts: "Verified contact details missing for some attendees", history: "First interaction — no previous conversations", property: "Properties not linked or availability unverified",
    requirement: [!req && "No requirement on record", req && !req.budget_max && "Budget not confirmed", req && !(req.seats_target || req.area_target_sf) && "Area/seats unknown", req && !req.occupation_date && "Move-in date unknown"].filter(Boolean).join("; ") || "Requirement incomplete",
    materials: "No supporting documents attached", questions: "Brief not generated", outcome: "Desired outcome not set",
  };
  if (!x.attendees.some((a) => ["decision_maker", "economic_buyer"].includes(a.role)) && x.prep.meeting_type !== "internal") notes.attendees = `${notes.attendees === `0 attendee(s) not matched to a contact` ? "" : notes.attendees + "; "}Decision-maker not identified`;
  const r = R.readiness(v, notes);
  if (!x.attendees.some((a) => ["decision_maker", "economic_buyer"].includes(a.role)) && x.prep.meeting_type !== "internal" && !r.missing.concat(r.critical).some((m) => /Decision-maker/.test(m))) r.missing.push("Decision-maker not identified");
  return { ...r, factors: v };
}

// ------------------------------------------------------------------ brief
const Gen = z.object({
  purpose: z.object({ why: z.string(), trigger: z.string(), they_may_want: z.string(), we_want: z.string() }),
  company_summary: z.array(z.object({ text: z.string(), kind: z.enum(["fact", "history", "inference", "unknown"]) })),
  attendee_notes: z.array(z.object({ name: z.string(), why_matters: z.string() })),
  strategy: z.array(z.object({ stage: z.enum(["opening", "discovery", "value", "discussion", "closing"]), point: z.string(), why: z.string(), obtain: z.string(), outcome: z.string() })),
  avoid: z.array(z.string()),
  objections: z.array(z.object({ objection: z.string(), meaning: z.string(), response: z.string(), follow_up: z.string(), evidence: z.string() })),
  outcome: z.object({ ideal: z.string(), acceptable: z.array(z.string()) }),
  next_steps: z.array(z.string()),
});
export type BriefGen = z.infer<typeof Gen>;

function factsFrom(x: Intel): { company: Item[]; history: Item[]; unknowns: string[] } {
  const c: Item[] = []; const h: Item[] = []; const u: string[] = [];
  const o = x.org;
  if (o) {
    c.push({ text: `${o.display_name}${o.sector ? ` — ${o.sector}` : ""}${o.hq_country ? `, HQ ${o.hq_country}` : ""}${o.is_gcc ? " (GCC)" : ""}`, kind: "fact", source: { type: "organisation", id: o.id } });
    if (o.headcount_min) c.push({ text: `Headcount ${o.headcount_min}${o.headcount_max && o.headcount_max !== o.headcount_min ? `–${o.headcount_max}` : ""}`, kind: "fact", source: { type: "organisation", id: o.id } }); else u.push("Company size");
    if (!o.sector) u.push("Industry");
  } else u.push("Company not linked");
  for (const l of x.leases.slice(0, 5)) {
    const ev = ((l.lease_event ?? []) as Row[]).filter((e) => e.event_date >= today()).sort((a, b) => a.event_date.localeCompare(b.event_date))[0];
    c.push({ text: `Office: ${l.asset?.name ?? "building?"}${l.asset?.micro_market?.name ? `, ${l.asset.micro_market.name}` : ""}${l.area_sf ? ` · ${Math.round(l.area_sf)} sq ft` : ""}${ev ? ` · next ${ev.event_type.replace(/_/g, " ")} ${ev.event_date}${ev.confirmed ? "" : " (not confirmed)"}` : l.contractual_expiry ? ` · expiry ${l.contractual_expiry}` : ""}`, kind: l.fact_status === "currently_confirmed" ? "fact" : "history", source: { type: "lease", id: l.id } });
  }
  if (!x.leases.length) u.push("Current offices and leases");
  for (const s of x.signals.slice(0, 5)) c.push({ text: `${s.title}${s.event_date ? ` (${s.event_date})` : ""}${s.verification === "fact" ? "" : " — reported, not confirmed"}`, kind: s.verification === "fact" ? "fact" : "inference", source: { type: "signal", id: s.id }, changed: (Date.now() - Date.parse(s.detected_at)) / 864e5 < 14 });
  for (const t of x.transactions.slice(0, 3)) c.push({ text: `Past transaction: ${t.deal_type ?? "deal"} at ${t.asset?.name ?? "?"}${t.period_start ? ` (${t.period_start})` : ""}${t.area_sf ? `, ${Math.round(t.area_sf)} sq ft` : ""}`, kind: "history", source: { type: "market_transaction", id: t.id } });
  for (const i of x.interactions) h.push({ text: `${i.occurred_at.slice(0, 10)} · ${i.channel}${i.direction === "inbound" ? " (from them)" : ""}${i.subject ? ` · ${i.subject}` : ""}${i.summary ? ` — ${String(i.summary).slice(0, 200)}` : ""}`, kind: "history", source: { type: "interaction", id: i.id } });
  return { company: c, history: h, unknowns: u };
}

export async function generateBrief(db: Db, ws: string, userId: string, prepId: string, ai: Ai = callStructured) {
  await db.from("meeting_prep").update({ status: "researching", brief_error: null }).eq("id", prepId);
  try {
    const x = await gather(db, ws, prepId);
    const t = R.MEETING_TYPES[x.prep.meeting_type] ?? R.MEETING_TYPES.discovery;
    const f = factsFrom(x);
    const qs = R.pickQuestions(x.prep.meeting_type, x.recIn);
    const objBank = R.objectionsFor(x.prep.meeting_type);
    const commitments = x.interactions.flatMap((i) => ((i.promises ?? []) as Row[]).map((p) => ({ text: typeof p === "string" ? p : `${p.who === "them" ? "They" : p.who === "us" ? "We" : ""} ${p.what ?? p.text ?? ""}`.trim(), date: i.occurred_at.slice(0, 10) })));
    const objectionsRaised = x.interactions.flatMap((i) => ((i.objections ?? []) as Row[]).map((o) => ({ text: typeof o === "string" ? o : o.text ?? JSON.stringify(o), date: i.occurred_at.slice(0, 10) })));
    const input = [
      `Meeting: ${x.meeting.title} — ${t.label}. Purpose framework: ${t.purpose} Owner-entered purpose: ${x.prep.purpose ?? "(none)"}.`,
      `When: ${x.meeting.start_at}. Where: ${x.meeting.location ?? "unknown"}.`,
      `Company facts:\n${f.company.map((c) => `- [${c.kind}] ${c.text}`).join("\n") || "- none"}`,
      `Unknown: ${f.unknowns.join(", ") || "—"}.`,
      `Attendees:\n${x.attendees.map((a) => `- ${a.name}: ${a.title ?? "title unknown"}, role ${a.role}${a.stakeholderRole ? `, stakeholder ${a.stakeholderRole}` : ""}, ${a.interactions} past interactions${a.match !== "matched" && a.match !== "manual" ? " (NOT matched to a saved contact)" : ""}`).join("\n") || "- none listed"}`,
      `Requirement: ${x.requirement ? JSON.stringify({ title: x.requirement.title, objective: x.requirement.objective, seats: x.requirement.seats_target, area: x.requirement.area_target_sf, budget_max: x.requirement.budget_max, move_in: x.requirement.occupation_date, status: x.requirement.status }) : "none on record"}.`,
      `Opportunity: ${x.opportunity ? `${x.opportunity.name}, stage ${x.opportunity.stage}, next ${x.opportunity.next_action ?? "?"}, risks ${x.opportunity.risks ?? "?"}` : "none linked"}.`,
      `Previous interactions: ${x.interactions.length ? x.interactions.slice(-6).map((i) => `${i.occurred_at.slice(0, 10)} ${i.channel}: ${String(i.summary ?? i.subject ?? "").slice(0, 150)}`).join(" | ") : "NONE — this is a first interaction"}.`,
      `Recorded commitments: ${commitments.map((c) => c.text).join("; ") || "none"}. Recorded objections: ${objectionsRaised.map((o) => o.text).join("; ") || "none"}.`,
      `Properties: ${x.properties.map((pp) => `${pp.name} (${pp.verified ? "availability verified" : "availability NOT verified"}; matches: ${pp.match.join(", ") || "—"}; gaps: ${pp.mismatch.join(", ") || "—"})`).join(" | ") || "none"}.`,
      `Objection bank to adapt (speculative, not said by attendees): ${objBank.map((o) => o.objection).join("; ")}.`,
      `Desired outcome template: ${t.outcome}`,
    ].join("\n\n");
    const mock = (): BriefGen => ({
      purpose: { why: x.prep.purpose ?? t.purpose, trigger: x.signals[0] ? `${x.signals[0].title}${x.signals[0].verification === "fact" ? "" : " (reported)"}` : x.leases.length ? "Upcoming lease events on record" : "No specific trigger on record", they_may_want: x.requirement ? "Options that fit their stated requirement" : "To understand what the market offers — unconfirmed", we_want: t.outcome },
      company_summary: f.company.slice(0, 5).map((c) => ({ text: c.text, kind: c.kind as "fact" })),
      attendee_notes: x.attendees.map((a) => ({ name: a.name, why_matters: a.role === "unknown" ? `${a.title ?? "Role"} — decision role not yet known; confirm in the meeting.` : `${a.title ?? ""} — recorded as ${a.role.replace(/_/g, " ")}.` })),
      strategy: [
        { stage: "opening", point: x.interactions.length ? "Recap the last conversation and confirm today's agenda" : "Introduce yourself briefly and agree the meeting's purpose", why: "Sets a shared objective", obtain: "Their priorities for today", outcome: "Agreed agenda" },
        { stage: "discovery", point: "Ask the essential questions before presenting anything", why: "Avoids pitching the wrong options", obtain: "Area, timing, budget, decision process", outcome: "Clear requirement picture" },
        { stage: "value", point: "Share relevant market context for their micro-market", why: "Shows expertise without pressure", obtain: "Reaction to market levels", outcome: "Credibility" },
        { stage: "discussion", point: x.properties.length ? "Walk through matches and gaps per property" : "Discuss options at a high level", why: "Ties options to their needs", obtain: "Preferences and deal-breakers", outcome: "Shortlist direction" },
        { stage: "closing", point: "Agree one concrete next step with a date", why: "Keeps momentum", obtain: "Owner and date", outcome: t.outcome },
      ],
      avoid: ["Assuming they need space because of a reported signal", "Quoting unverified availability as confirmed"],
      objections: objBank,
      outcome: { ideal: t.outcome, acceptable: ["A follow-up call booked", "Permission to send a short market note"] },
      next_steps: ["Send a meeting follow-up with agreed actions", "Update the requirement with anything confirmed", "Create tasks for our commitments"],
    });
    const r = await ai({ workspaceId: ws, workflow: "meetings.brief", tier: "luna", schema: Gen, schemaName: "meeting_brief", maxOutputTokens: 3000, classification: "corporate_confidential", mock,
      system: "You prepare a commercial real-estate adviser (Pune, India) for a meeting. Use ONLY the facts given. Never invent past conversations, commitments, attendee authority or property availability. Reported signals are inferences, not needs. Objections are anticipated possibilities, never things the attendee said. No manipulative tactics. Keep each item one or two sentences.",
      input });
    const g = r.data;
    const content = {
      generated_at: new Date().toISOString(), model: r.model, type: x.prep.meeting_type,
      overview: { title: x.meeting.title, type: t.label, start: x.meeting.start_at, end: x.meeting.end_at, location: x.meeting.location, company: x.org?.display_name ?? null, attendees: x.attendees.map((a) => a.name), opportunity: x.opportunity?.name ?? null, requirement: x.requirement?.title ?? null },
      purpose: g.purpose,
      company: { items: f.company, summary: g.company_summary, unknowns: f.unknowns, scores: x.scores },
      attendees: x.attendees.map((a) => ({ ...a, why_matters: g.attendee_notes.find((n) => n.name === a.name)?.why_matters ?? null })),
      opportunity: x.requirement || x.opportunity ? { stage: x.opportunity?.stage ?? null, next_action: x.opportunity?.next_action ?? null, risks: x.opportunity?.risks ?? null, requirement: x.requirement ? { title: x.requirement.title, objective: x.requirement.objective, seats: x.requirement.seats_target, area: x.requirement.area_target_sf, budget: x.requirement.budget_max, move_in: x.requirement.occupation_date, status: x.requirement.status } : null } : null,
      history: { first: !x.interactions.length, items: f.history, commitments, objections: objectionsRaised, open_tasks: x.tasks.map((tk) => ({ title: tk.title, due: tk.due_at?.slice(0, 10) ?? null })), outreach: x.outreach.map((o) => ({ channel: o.channel, status: o.status, reason: o.reason, sent: o.sent_at?.slice(0, 10) ?? null, reply: o.response?.summary ?? null })) },
      strategy: g.strategy, avoid: g.avoid, questions: qs, objections: g.objections.length ? g.objections : objBank, outcome: g.outcome, next_steps: g.next_steps,
      properties: x.properties,
    };
    const rd = assessReadiness(x, content);
    const { data: last } = await db.from("meeting_brief_version").select("version").eq("prep_id", prepId).order("version", { ascending: false }).limit(1).maybeSingle();
    const v = (last?.version ?? 0) + 1;
    await db.from("meeting_brief_version").insert({ workspace_id: ws, prep_id: prepId, version: v, kind: v === 1 ? "generated" : "regenerated", content, model: r.model, readiness: rd.score, inputs: { signals: x.signals.map((s) => s.id), interactions: x.interactions.map((i) => i.id), leases: x.leases.map((l) => l.id), requirement: x.requirement?.id ?? null, rules: "meetings-1" }, owner_user_id: userId });
    const checklist = x.prep.meeting_type === "site_visit" && !Object.keys(x.prep.checklist ?? {}).length ? Object.fromEntries(Object.values(R.SITE_VISIT).flat().map((c) => [c.key, false])) : x.prep.checklist;
    await db.from("meeting_prep").update({ brief: content, brief_version: v, brief_model: r.model, status: "brief_ready", readiness: rd.score, readiness_detail: rd, checklist, reviewed_by: null, reviewed_at: null }).eq("id", prepId);
    return { version: v, readiness: rd.score, mocked: r.mocked };
  } catch (e) {
    await db.from("meeting_prep").update({ status: "preparation_pending", brief_error: e instanceof Error ? e.message.slice(0, 300) : "Brief generation failed" }).eq("id", prepId);
    throw e;
  }
}

/** Edits are saved as a new version; nothing is lost. */
export async function editBrief(db: Db, ws: string, userId: string, prepId: string, patch: Partial<{ purpose_why: string; we_want: string; ideal: string; next_steps: string[]; avoid: string[]; extra_questions: string[] }>) {
  const { data: p } = await db.from("meeting_prep").select("brief, brief_version, readiness").eq("workspace_id", ws).eq("id", prepId).single();
  if (!p?.brief) throw new MeetingError("Generate the brief first.");
  const b = structuredClone(p.brief) as Row;
  if (patch.purpose_why !== undefined) b.purpose.why = patch.purpose_why;
  if (patch.we_want !== undefined) b.purpose.we_want = patch.we_want;
  if (patch.ideal !== undefined) b.outcome.ideal = patch.ideal;
  if (patch.next_steps) b.next_steps = patch.next_steps;
  if (patch.avoid) b.avoid = patch.avoid;
  if (patch.extra_questions) b.questions.custom = patch.extra_questions.map((q) => ({ key: "custom", text: q, group: "custom", answered: null }));
  const v = p.brief_version + 1;
  await db.from("meeting_brief_version").insert({ workspace_id: ws, prep_id: prepId, version: v, kind: "edited", content: b, readiness: p.readiness, owner_user_id: userId });
  await db.from("meeting_prep").update({ brief: b, brief_version: v, status: "brief_ready", reviewed_by: null, reviewed_at: null }).eq("id", prepId);
  return v;
}
export async function markReviewed(db: Db, ws: string, userId: string, prepId: string) {
  const { data: p } = await db.from("meeting_prep").select("brief").eq("workspace_id", ws).eq("id", prepId).single();
  if (!p?.brief) throw new MeetingError("Generate the brief first.");
  await db.from("meeting_prep").update({ status: "reviewed", reviewed_by: userId, reviewed_at: new Date().toISOString() }).eq("id", prepId);
}

export async function setMeetingPurpose(db: Db, ws: string, prepId: string, f: { purpose?: string; type?: string; opportunityId?: string | null; requirementId?: string | null; assetIds?: string[] }) {
  const patch: Row = {};
  if (f.purpose !== undefined) patch.purpose = f.purpose || null;
  if (f.type && R.MEETING_TYPES[f.type]) patch.meeting_type = f.type;
  if (f.opportunityId !== undefined) patch.opportunity_id = f.opportunityId;
  if (f.requirementId !== undefined) patch.requirement_id = f.requirementId;
  if (f.assetIds) patch.asset_ids = f.assetIds;
  await db.from("meeting_prep").update(patch).eq("workspace_id", ws).eq("id", prepId);
}

/** Cancel / reschedule never touches an external calendar — only CRE OS's own record. */
export async function reschedule(db: Db, ws: string, prepId: string, startIso: string, endIso?: string) {
  const { data: p } = await db.from("meeting_prep").select("meeting_visit_id, meeting:meeting_visit_id(start_at, end_at)").eq("workspace_id", ws).eq("id", prepId).single();
  if (!p) throw new MeetingError("Not found.");
  const dur = Date.parse((p.meeting as Row).end_at) - Date.parse((p.meeting as Row).start_at);
  const s = new Date(startIso); if (isNaN(+s)) throw new MeetingError("Invalid date.");
  await db.from("meeting_visit").update({ start_at: s.toISOString(), end_at: endIso ? new Date(endIso).toISOString() : new Date(+s + dur).toISOString() }).eq("id", p.meeting_visit_id);
  await db.from("meeting_prep").update({ status: "rescheduled", remind_at: new Date(+s - 24 * 3600e3).toISOString() }).eq("id", prepId);
}
export async function cancelMeeting(db: Db, ws: string, prepId: string) {
  const { data: p } = await db.from("meeting_prep").select("meeting_visit_id").eq("workspace_id", ws).eq("id", prepId).single();
  if (!p) throw new MeetingError("Not found.");
  await db.from("meeting_visit").update({ status: "cancelled" }).eq("id", p.meeting_visit_id);
  await db.from("meeting_prep").update({ status: "cancelled" }).eq("id", prepId);
}
export async function resolveAttendee(db: Db, ws: string, attId: string, personId: string | null) {
  await db.from("meeting_prep_attendee").update(personId ? { person_id: personId, match_status: "manual", match_reason: "Confirmed by you" } : { person_id: null, match_status: "unresolved", match_reason: "Rejected match" }).eq("workspace_id", ws).eq("id", attId);
}
export async function addAttendee(db: Db, ws: string, userId: string, prepId: string, a: { personId?: string | null; name?: string | null; email?: string | null }) {
  const { data: p } = await db.from("meeting_prep").select("org_id").eq("id", prepId).single();
  const m = a.personId ? { person_id: a.personId, match_status: "manual", match_reason: "Chosen by you" } : await matchAttendee(db, ws, a, p?.org_id ?? null);
  await db.from("meeting_prep_attendee").insert({ workspace_id: ws, prep_id: prepId, raw_name: a.name ?? null, raw_email: a.email ?? null, ...m, owner_user_id: userId });
}
export async function toggleChecklist(db: Db, ws: string, prepId: string, key: string, done: boolean) {
  const { data: p } = await db.from("meeting_prep").select("checklist").eq("workspace_id", ws).eq("id", prepId).single();
  await db.from("meeting_prep").update({ checklist: { ...(p?.checklist ?? {}), [key]: done } }).eq("id", prepId);
}
export async function addMaterial(db: Db, ws: string, userId: string, prepId: string, m: { title: string; url?: string | null; internalOnly?: boolean }) {
  if (!m.title.trim()) throw new MeetingError("Give the material a name.");
  if (m.url && !/^https?:\/\//.test(m.url)) throw new MeetingError("Links must start with http(s)://");
  await db.from("meeting_material").insert({ workspace_id: ws, prep_id: prepId, title: m.title.slice(0, 200), url: m.url || null, internal_only: m.internalOnly ?? true, owner_user_id: userId });
}
export async function addNote(db: Db, ws: string, userId: string, prepId: string, kind: "note" | "action" | "feedback" | "commitment", text: string) {
  if (!text.trim()) return;
  await db.from("meeting_note").insert({ workspace_id: ws, prep_id: prepId, kind, text: text.trim().slice(0, 4000), owner_user_id: userId });
}

// ------------------------------------------------------------------ post-meeting: structure → proposals (never silent writes)
const Out = z.object({
  summary: z.string(), outcome: z.enum(["positive", "neutral", "negative", "no_show"]), topics: z.array(z.string()),
  requirement_updates: z.array(z.object({ field: z.enum(["seats_target", "area_target_sf", "budget_max", "occupation_date", "decision_date", "objective"]), value: z.string(), quote: z.string() })),
  decision_process: z.string().nullable(), objections: z.array(z.string()), property_feedback: z.array(z.object({ property: z.string(), feedback: z.string() })),
  commitments: z.array(z.object({ who: z.enum(["us", "them"]), what: z.string(), due: z.string().nullable() })),
  next_meeting: z.string().nullable(), followup_date: z.string().nullable(),
});
export type Outcome = z.infer<typeof Out>;
export async function structureOutcome(db: Db, ws: string, userId: string, prepId: string, text: string, ai: Ai = callStructured) {
  const { data: notes } = await db.from("meeting_note").select("kind, text").eq("prep_id", prepId).is("archived_at", null).order("created_at");
  const all = [text, ...((notes ?? []) as Row[]).map((n) => `[${n.kind}] ${n.text}`)].filter((s) => s.trim()).join("\n");
  if (!all.trim()) throw new MeetingError("Add notes first.");
  const r = await ai({ workspaceId: ws, workflow: "meetings.outcome", tier: "luna", schema: Out, schemaName: "meeting_outcome", maxOutputTokens: 1500,
    system: "Structure a commercial real-estate adviser's meeting notes. Extract only what the notes say; quote the words behind each requirement update. Dates YYYY-MM-DD only if stated. Numbers as plain digits.",
    input: "Structure these notes.", evidence: all,
    mock: () => {
      const seats = all.match(/(\d{2,5})\s*(seats|people|headcount)/i); const area = all.match(/(\d[\d,]{2,})\s*(sq\.?\s*ft|sqft|sf)/i); const date = all.match(/\d{4}-\d{2}-\d{2}/);
      return { summary: all.slice(0, 240), outcome: (/did ?n.t happen|not held|no.show|cancell?ed|postponed|didn.t meet/i.test(all) ? "no_show" : /not interested|no need/i.test(all) ? "negative" : "positive") as Outcome["outcome"], topics: [] as string[],
        requirement_updates: [...(seats ? [{ field: "seats_target" as const, value: seats[1], quote: seats[0] }] : []), ...(area ? [{ field: "area_target_sf" as const, value: area[1].replace(/,/g, ""), quote: area[0] }] : []), ...(date && /move/i.test(all) ? [{ field: "occupation_date" as const, value: date[0], quote: date[0] }] : [])],
        decision_process: null, objections: /broker/i.test(all) ? ["Mentioned an existing broker"] : [], property_feedback: [],
        commitments: all.split(/\n/).filter((l) => /\b(we will|i will|send|share)\b/i.test(l)).map((l) => ({ who: "us" as const, what: l.replace(/^\[\w+\]\s*/, "").slice(0, 160), due: null })),
        next_meeting: null, followup_date: null };
    } });
  await db.from("meeting_prep").update({ outcome: { proposed: r.data, notes_text: text.slice(0, 8000), structured_at: new Date().toISOString(), applied: null } }).eq("id", prepId);
  return r.data;
}

/** User approves selected parts. Requirement/opportunity changes become change proposals; tasks + interaction are created. */
export async function applyOutcome(db: Db, ws: string, userId: string, prepId: string, sel: { requirement: boolean; tasks: boolean; interaction: boolean; followupDraft: boolean }) {
  const x = await gather(db, ws, prepId);
  const o = x.prep.outcome?.proposed as Outcome | undefined;
  if (!o) throw new MeetingError("Structure the notes first.");
  if (x.prep.outcome?.applied) throw new MeetingError("Already applied.");
  if (o.outcome === "no_show") throw new MeetingError("The notes say the meeting didn't happen — use 'Meeting didn't happen' instead.");
  const res = { proposals: 0, tasks: 0, interaction: null as string | null, draft: null as string | null };
  if (sel.interaction) {
    const key = `meeting:${prepId}`;
    const prev = (await db.from("interaction").select("id").eq("workspace_id", ws).eq("source_message_id", key).maybeSingle()).data;
    const ins = prev ?? (await db.from("interaction").insert({ workspace_id: ws, occurred_at: x.meeting.start_at, channel: x.prep.meeting_type === "site_visit" ? "visit" : "meeting", direction: "internal", subject: x.meeting.title, summary: o.summary, promises: o.commitments, objections: o.objections.map((t) => ({ text: t })), opportunity_id: x.prep.opportunity_id, is_meaningful: true, source_message_id: key, owner_user_id: userId }).select("id").single()).data!;
    res.interaction = ins.id;
    if (!prev) await db.from("interaction_link").insert([...x.attendees.filter((a) => a.personId).map((a) => ({ workspace_id: ws, interaction_id: ins.id, entity_type: "person", entity_id: a.personId, role: "participant" })), ...(x.prep.org_id ? [{ workspace_id: ws, interaction_id: ins.id, entity_type: "organisation", entity_id: x.prep.org_id, role: "mentioned" }] : [])]);
  }
  if (sel.requirement && x.requirement && o.requirement_updates.length) {
    const patch = o.requirement_updates.map((u) => ({ op: "replace" as const, path: `/${u.field}`, value: ["seats_target", "area_target_sf", "budget_max"].includes(u.field) ? Number(String(u.value).replace(/[^\d.]/g, "")) : u.value }));
    await proposeChange(db, ws, { targetType: "requirement", targetId: x.requirement.id, patch, reason: `From meeting notes "${x.meeting.title}": ${o.requirement_updates.map((u) => `"${u.quote}"`).join(", ")}`, proposedByKind: "model", idempotencyKey: `meeting:${prepId}:req`, ownerUserId: userId });
    res.proposals++;
  }
  if (sel.requirement && x.prep.opportunity_id && o.followup_date) {
    await proposeChange(db, ws, { targetType: "opportunity", targetId: x.prep.opportunity_id, patch: [{ op: "replace", path: "/next_action", value: o.next_meeting ?? "Follow up after meeting" }, { op: "replace", path: "/next_action_due", value: o.followup_date }], reason: `Meeting "${x.meeting.title}" next step`, proposedByKind: "model", idempotencyKey: `meeting:${prepId}:opp`, ownerUserId: userId }).catch(() => null);
    res.proposals++;
  }
  if (sel.tasks) {
    for (const [i, c] of o.commitments.entries()) {
      if (c.who !== "us") continue;
      const key = `meeting:${prepId}:${i}`;
      if ((await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).limit(1)).data?.length) continue;
      await db.from("task").insert({ workspace_id: ws, title: c.what.slice(0, 200), due_at: `${c.due && /^\d{4}-\d{2}-\d{2}$/.test(c.due) ? c.due : addDays(today(), 2)}T09:00:00+05:30`, assigned_user_id: userId, linked_entity_type: x.prep.opportunity_id ? "opportunity" : "organisation", linked_entity_id: x.prep.opportunity_id ?? x.prep.org_id, source: "meeting", idempotency_key: key, owner_user_id: userId });
      res.tasks++;
    }
  }
  if (sel.followupDraft) {
    const target = x.attendees.find((a) => a.personId && !a.doNotContact);
    if (target) {
      const { createOutreach } = await import("@/modules/outreach/service");
      const r = await createOutreach(db, ws, userId, { personId: target.personId!, channels: ["meeting_followup"], scenario: "meeting_followup", opportunityId: x.prep.opportunity_id }).catch(() => null);
      res.draft = r?.ids[0] ?? null;
    }
  }
  await db.from("meeting_prep").update({ status: "completed", outcome: { ...x.prep.outcome, applied: { at: new Date().toISOString(), by: userId, ...res } } }).eq("id", prepId);
  await db.from("meeting_visit").update({ status: "completed" }).eq("id", x.prep.meeting_visit_id);
  return res;
}

/** Meeting didn't happen: log it (optional), clear proposals, keep the prep open for a new date. Nothing else changes. */
export async function recordNoShow(db: Db, ws: string, userId: string, prepId: string, opts: { log: boolean }) {
  const x = await gather(db, ws, prepId);
  if (opts.log) {
    const key = `meeting-noshow:${prepId}:${x.meeting.start_at.slice(0, 10)}`;
    const prev = (await db.from("interaction").select("id").eq("workspace_id", ws).eq("source_message_id", key).maybeSingle()).data;
    if (!prev) {
      const { data: ins } = await db.from("interaction").insert({ workspace_id: ws, occurred_at: x.meeting.start_at, channel: "meeting", direction: "internal", subject: `${x.meeting.title} — did not happen`, summary: "Meeting did not take place.", is_meaningful: false, opportunity_id: x.prep.opportunity_id, source_message_id: key, owner_user_id: userId }).select("id").single();
      if (ins) await db.from("interaction_link").insert(x.attendees.filter((a) => a.personId).map((a) => ({ workspace_id: ws, interaction_id: ins.id, entity_type: "person", entity_id: a.personId, role: "participant" })));
    }
  }
  await db.from("meeting_prep").update({ outcome: null, status: x.prep.brief ? "brief_ready" : "preparation_pending" }).eq("id", prepId);
  await db.from("meeting_note").update({ archived_at: new Date().toISOString() }).eq("prep_id", prepId).is("archived_at", null);
}
export async function discardOutcome(db: Db, ws: string, prepId: string) {
  await db.from("meeting_prep").update({ outcome: null }).eq("workspace_id", ws).eq("id", prepId);
}

/** Reminders: preps whose meeting is within 24h and still not reviewed get a task (idempotent). Job: meetings.remind. */
export async function remind(db: Db, ws: string) {
  const { data } = await db.from("meeting_prep").select("id, owner_user_id, status, meeting:meeting_visit_id(title, start_at, status)").eq("workspace_id", ws).in("status", ["preparation_pending", "brief_ready", "researching", "rescheduled"]).lte("remind_at", new Date().toISOString()).limit(200);
  let n = 0;
  for (const p of (data ?? []) as Row[]) {
    if (!p.meeting || p.meeting.status === "cancelled" || Date.parse(p.meeting.start_at) < Date.now()) continue;
    const key = `meeting-remind:${p.id}:${p.meeting.start_at.slice(0, 10)}`;
    if ((await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).limit(1)).data?.length) continue;
    await db.from("task").insert({ workspace_id: ws, title: `Prepare for "${p.meeting.title}"`, due_at: p.meeting.start_at, assigned_user_id: p.owner_user_id, linked_entity_type: "meeting_prep", linked_entity_id: p.id, source: "meeting", idempotency_key: key, owner_user_id: p.owner_user_id });
    n++;
  }
  return { reminded: n };
}

export function briefMarkdown(b: Row) {
  const L: string[] = [];
  const it = (i: Item) => `- ${i.text}${i.kind !== "fact" ? ` _(${i.kind})_` : ""}`;
  L.push(`# ${b.overview.title}`, `${b.overview.type} · ${new Date(b.overview.start).toLocaleString("en-IN")} · ${b.overview.location ?? "location TBC"}`, `Company: ${b.overview.company ?? "—"} · Attendees: ${b.overview.attendees.join(", ") || "—"}`, "");
  L.push("## Purpose", `- Why: ${b.purpose.why}`, `- Trigger: ${b.purpose.trigger}`, `- They may want: ${b.purpose.they_may_want}`, `- We want: ${b.purpose.we_want}`, "");
  L.push("## Company", ...b.company.items.map(it), ...(b.company.unknowns.length ? [`- Unknown: ${b.company.unknowns.join(", ")}`] : []), "");
  L.push("## Attendees", ...b.attendees.map((a: Row) => `- **${a.name}** — ${a.title ?? "title unknown"}; ${String(a.role).replace(/_/g, " ")}${a.why_matters ? `. ${a.why_matters}` : ""}`), "");
  if (b.opportunity?.requirement) { const r = b.opportunity.requirement; L.push("## Opportunity", `- ${r.title} (${r.status}) · seats ${r.seats ?? "?"} · area ${r.area ?? "?"} · budget ${r.budget ?? "?"} · move-in ${r.move_in ?? "?"}`, `- Stage: ${b.opportunity.stage ?? "—"} · risks: ${b.opportunity.risks ?? "—"}`, ""); }
  L.push("## Previous discussions", b.history.first ? "- First interaction — nothing on record." : "", ...b.history.items.map(it), ...b.history.commitments.map((c: Row) => `- Commitment (${c.date}): ${c.text}`), "");
  L.push("## Strategy", ...b.strategy.map((s: Row) => `- **${s.stage}**: ${s.point} — why: ${s.why}; obtain: ${s.obtain}`), ...(b.avoid.length ? [`- Avoid: ${b.avoid.join("; ")}`] : []), "");
  L.push("## Questions", "### Essential", ...b.questions.essential.map((q: Row) => `1. ${q.text}`), "### Additional", ...b.questions.additional.map((q: Row) => `- ${q.text}${q.answered ? ` _(already on record: ${q.answered})_` : ""}`), ...(b.questions.strategic.length ? ["### Strategic", ...b.questions.strategic.map((q: Row) => `- ${q.text}`)] : []), ...((b.questions.custom ?? []).length ? ["### Yours", ...b.questions.custom.map((q: Row) => `- ${q.text}`)] : []), "");
  L.push("## Possible objections (anticipated, not said)", ...b.objections.map((o: Row) => `- **${o.objection}** — ${o.response} Ask: ${o.follow_up} Prepare: ${o.evidence}`), "");
  if (b.properties?.length) L.push("## Properties", ...b.properties.map((p: Row) => `- **${p.name}** (${p.verified ? "availability verified" : "availability NOT verified"}) — matches: ${p.match.join("; ") || "—"}; gaps: ${p.mismatch.join("; ") || "—"}; verify: ${p.verify.join("; ")}`), "");
  L.push("## Desired outcome", `- Ideal: ${b.outcome.ideal}`, ...b.outcome.acceptable.map((a: string) => `- Acceptable: ${a}`), "", "## Next steps", ...b.next_steps.map((s: string) => `- ${s}`));
  return L.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
