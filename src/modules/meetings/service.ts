import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { proposeChange } from "@/lib/services/changes";
import { contactValueHash } from "@/lib/services/drafts";
import * as R from "./rules";
import { escapeLike } from "@/lib/util/like";
import { meetingMemoryForBrief } from "@/modules/intelligence/memory/integrate/hooks";
import { meetingMemoryMarkdown } from "@/modules/intelligence/memory/ui/meeting";
import { edate, isPastInstant, localDate } from "@/lib/util/time";

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
  const [org, leases, signals, reqs, opps, people, links, outreach, tasks, materials, notes, scores, stakeholders, trans, feedback] = await Promise.all([
    q<Row>(!!orgId, () => db.from("organisation").select("id, display_name, legal_name, sector, hq_country, headcount_min, headcount_max, is_gcc, domain, updated_at").eq("id", orgId!).maybeSingle()),
    q<Row[]>(!!orgId, () => db.from("lease").select("id, area_sf, contractual_expiry, status, fact_status, asset:asset_id(id, name, address, micro_market:micro_market_id(name), locality:locality_id(name)), lease_event(event_type, event_date, confirmed, date_basis)").eq("workspace_id", ws).eq("tenant_org_id", orgId!).limit(30)),
    q<Row[]>(!!orgId, () => db.from("signal").select("id, title, summary, category, verification, confidence, event_date, latest_evidence_on, detected_at, status").eq("workspace_id", ws).eq("org_id", orgId!).not("status", "in", "(rejected,dismissed)").order("detected_at", { ascending: false }).limit(8)),
    q<Row[]>(!!orgId, () => db.from("requirement").select("*").eq("workspace_id", ws).eq("org_id", orgId!).is("archived_at", null).order("updated_at", { ascending: false }).limit(5)),
    q<Row[]>(!!orgId, () => db.from("opportunity").select("id, name, stage, outcome, next_action, next_action_due, risks, expected_close, requirement_id, temperature").eq("workspace_id", ws).eq("org_id", orgId!).is("archived_at", null).limit(10)),
    q<Row[]>(attendeeIds.length > 0, () => db.from("person").select("id, full_name, do_not_contact, employment(title, is_current, start_date, end_date, org:org_id(display_name)), contact_method(method_type, value, verify_status, suppressed), contact_role_assessment(role_class, cre_relevance, active, reason)").in("id", attendeeIds)),
    q<Row[]>(attendeeIds.length > 0 || !!orgId, () => db.from("interaction_link").select("entity_type, entity_id, interaction:interaction_id(id, occurred_at, channel, direction, subject, summary, promises, objections, owner_user_id, is_meaningful)").eq("workspace_id", ws).in("entity_id", [...attendeeIds, ...(orgId ? [orgId] : [])]).limit(400)),
    q<Row[]>(attendeeIds.length > 0, () => db.from("outreach_item").select("id, channel, status, reason, sent_at, response, person_id").eq("workspace_id", ws).in("person_id", attendeeIds).order("updated_at", { ascending: false }).limit(20)),
    q<Row[]>(true, () => db.from("task").select("id, title, due_at, status, linked_entity_type, linked_entity_id").eq("workspace_id", ws).eq("status", "open").in("linked_entity_id", [...attendeeIds, ...(orgId ? [orgId] : []), ...(p.opportunity_id ? [p.opportunity_id] : []), prepId]).limit(30)),
    q<Row[]>(true, () => db.from("meeting_material").select("*").eq("prep_id", prepId).order("created_at")),
    q<Row[]>(true, () => db.from("meeting_note").select("*").eq("prep_id", prepId).is("archived_at", null).order("created_at")),
    q<Row[]>(true, () => db.from("score_result").select("model_key, entity_id, score, band").eq("workspace_id", ws).eq("is_current", true).in("entity_id", [...attendeeIds, ...(orgId ? [orgId] : []), ...(p.opportunity_id ? [p.opportunity_id] : [])])),
    q<Row[]>(!!p.requirement_id, () => db.from("stakeholder").select("person_id, role").eq("workspace_id", ws).eq("requirement_id", p.requirement_id!)),
    q<Row[]>(!!orgId, () => db.from("market_transaction").select("id, deal_type, period_start, area_sf, asset:asset_id(name)").eq("workspace_id", ws).eq("tenant_org_id", orgId!).order("period_start", { ascending: false }).limit(5)),
    q<Row[]>((p.asset_ids ?? []).length > 0, () => db.from("meeting_property_feedback").select("id, asset_id, fields, updated_at").eq("prep_id", prepId).is("archived_at", null)),
  ]);
  const requirement = ((reqs.data ?? []) as Row[]).find((r) => r.id === p.requirement_id) ?? (p.requirement_id ? null : (reqs.data ?? [])[0] ?? null);
  const opportunity = ((opps.data ?? []) as Row[]).find((o) => o.id === p.opportunity_id) ?? null;
  const ints = [...new Map(((links.data ?? []) as Row[]).map((l) => l.interaction).filter(Boolean).map((i: Row) => [i.id, i])).values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  // properties for presentation / site visit
  let properties: Row[] = [];
  if ((p.asset_ids ?? []).length) {
    const { data: assets } = await db.from("asset").select("id, name, address, grade, status, floors, developer:developer_org_id(display_name), micro_market:micro_market_id(name), locality:locality_id(name), space(id, floor_text, carpet_sf, chargeable_sf, seats, configuration, availability(as_of, status, available_from, asking_rent_min, asking_rent_max, rent_basis, fitout_basis, fact_status))").in("id", p.asset_ids);
    properties = ((assets ?? []) as Row[]).map((a) => ({ ...matchProperty(a, requirement), feedback: (((feedback.data ?? []) as Row[]).find((f) => f.asset_id === a.id)?.fields ?? null) as Row | null }));
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
      role: ra?.role_class ?? "unknown", relevance: ra?.cre_relevance ?? null, roleBasis: ra?.reason ?? null,
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
      // Module 13 memory (§7.2): source-linked context from recorded history; null when unavailable (never invented).
      memory: x.meeting?.id ? await meetingMemoryForBrief(db, ws, userId, x.meeting.id) : null,
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
  if (isPastInstant(s)) throw new MeetingError("That time has already passed. Pick a date and time in the future.");
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
const Basis = z.enum(["statement", "interpretation"]);
const Extract = z.object({ text: z.string(), basis: Basis, quote: z.string().nullable() });
const Out = z.object({
  summary: z.string(), outcome: z.enum(["positive", "neutral", "negative", "no_show"]), topics: z.array(z.string()),
  requirement_updates: z.array(z.object({ field: z.enum(["seats_target", "area_target_sf", "budget_max", "occupation_date", "decision_date", "objective", "lease_tenure_months"]), value: z.string(), quote: z.string() })),
  decision_process: z.string().nullable(), objections: z.array(z.string()), property_feedback: z.array(z.object({ property: z.string(), feedback: z.string() })),
  commitments: z.array(z.object({ who: z.enum(["us", "them"]), what: z.string(), due: z.string().nullable() })),
  next_meeting: z.string().nullable(), followup_date: z.string().nullable(),
  // deeper analysis — each item says whether it is a statement (quoted from the notes) or our interpretation
  buying_signals: z.array(Extract), risks: z.array(Extract), unresolved_questions: z.array(Extract),
  per_property_interest: z.array(z.object({ property: z.string(), interest: z.enum(["interested", "maybe", "rejected", "unclear"]), quote: z.string().nullable(), basis: Basis })),
  confidence_notes: z.array(z.string()),
  clarifications_needed: z.array(z.object({ question: z.string(), about: z.enum(["name", "date", "amount", "commitment"]) })),
  contact_updates: z.array(z.object({ name: z.string(), field: z.enum(["title", "phone", "email"]), value: z.string(), quote: z.string() })),
  company_notes: z.array(z.object({ text: z.string(), quote: z.string() })),
  new_stakeholders: z.array(z.object({ name: z.string(), role: z.enum(["sponsor", "user", "finance", "procurement", "legal", "technical", "approver", "influencer", "other"]), quote: z.string() })),
});
export type Outcome = z.infer<typeof Out>;
const lines = (all: string) => all.split(/\n|(?<=[.!?।])\s+/).map((l) => l.replace(/^\[\w+\]\s*/, "").trim()).filter(Boolean);
const st = (l: string) => ({ text: l.slice(0, 200), basis: "statement" as const, quote: l.slice(0, 200) });
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, "twenty-four": 24, thirty: 30, "thirty-six": 36 };
const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] ?? null);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** "by Friday" / "by tomorrow" / "by 2026-11-20" → YYYY-MM-DD relative to the meeting's IST date (next such weekday after it). */
export function dueFrom(line: string, meetingDate: string): string | null {
  const iso = line.match(/\b(\d{4}-\d{2}-\d{2})\b/); if (iso) return iso[1];
  if (/\b(by )?tomorrow\b/i.test(line)) return addDays(meetingDate, 1);
  const wd = line.match(/\b(?:by|on|before|this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (!wd) return null;
  const target = WEEKDAYS.indexOf(wd[1].toLowerCase());
  const cur = new Date(`${meetingDate}T00:00:00Z`).getUTCDay();
  let diff = (target - cur + 7) % 7; if (diff === 0) diff = 7;
  if (/\bnext\s/i.test(wd[0]) && diff < 7) diff += 7;
  return addDays(meetingDate, diff);
}
/** Deterministic mock analysis (AI off). Understands common English / Hindi / Hinglish phrasing; never invents names, dates or amounts. */
export function mockOutcome(all: string, ctx: { properties: string[]; attendees: string[]; feedback: { property: string; interest: string; explicit: boolean }[]; meetingDate?: string }): Outcome {
  const L = lines(all);
  const mDate = ctx.meetingDate && /^\d{4}-\d{2}-\d{2}$/.test(ctx.meetingDate) ? ctx.meetingDate : localDate();
  const W = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty|twenty-four|thirty|thirty-six)";
  const within = L.map((l) => ({ l, m: l.match(new RegExp(`\\b(?:within|in|next)\\s+(?:the\\s+next\\s+)?${W}\\s+months?\\b`, "i")) })).find((x) => x.m && /occup|move|shift|timeline|target|ready|possession/i.test(x.l));
  const tenure = L.map((l) => ({ l, m: l.match(new RegExp(`\\b(?:tenure|lease term|lease length|term|lock-in)\\b[^.]*?\\b${W}\\s+(years?|months?)\\b`, "i")) })).find((x) => x.m);
  const finance = L.find((l) => /\b(finance|cfo|board|management|procurement)\b[^.]*\bapprov|approv[^.]*\b(finance|cfo|board|management|procurement)\b/i.test(l));
  const renew = L.find((l) => /\brenew|\brelocat|existing office|current office/i.test(l));
  const expensive = L.filter((l) => /expensive|costly|too high|over budget|mehenga|mahanga/i.test(l));
  const firstNames = ctx.attendees.map((a) => a.trim().split(/\s+/)[0]?.toLowerCase()).filter(Boolean);
  const isThem = (l: string) => /^(they|he|she|client|the client)\b/i.test(l) || firstNames.includes(l.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "");
  const seats = all.match(/(\d{2,5})\s*(seats|people|headcount|log|logon|seat)/i); const area = all.match(/(\d[\d,]{2,})\s*(sq\.?\s*ft|sqft|sf|square feet)/i); const date = all.match(/\d{4}-\d{2}-\d{2}/);
  const neg = /not interested|no need|interest nahi|nahi chahiye|zaroorat nahi/i.test(all);
  const interestOf = (l: string): Outcome["per_property_interest"][number]["interest"] => /reject|not interested|pasand nahi|nahi chahiye|no go|ruled out|cancel kar/i.test(l) ? "rejected" : /maybe|shayad|sochenge|will think|not sure|dekhte/i.test(l) ? "maybe" : /like|liked|pasand|interested|accha|achha|good|shortlist/i.test(l) ? "interested" : "unclear";
  const ppi: Outcome["per_property_interest"] = [];
  for (const f of ctx.feedback) ppi.push({ property: f.property, interest: (f.interest === "rejected" && !f.explicit ? "maybe" : f.interest) as "maybe", quote: "Site-visit feedback form", basis: "statement" });
  for (const name of ctx.properties) {
    if (ppi.some((p) => p.property === name)) continue;
    const key = name.toLowerCase().split(/\s+/)[0];
    const l = L.find((x) => x.toLowerCase().includes(key));
    if (l) ppi.push({ property: name, interest: interestOf(l), quote: l.slice(0, 200), basis: "interpretation" });
  }
  const clar: Outcome["clarifications_needed"] = [];
  const vagueDate = L.find((l) => /next week|soon|agle hafte|jaldi|kuch din|end of (the )?month|mahine ke end/i.test(l) && !/\d{4}-\d{2}-\d{2}/.test(l));
  if (vagueDate) clar.push({ question: `Which exact date was meant by: "${vagueDate.slice(0, 120)}"?`, about: "date" });
  const vagueAmt = L.find((l) => /budget|rent|kiraya|price|rate/i.test(l) && !/\d/.test(l));
  if (vagueAmt) clar.push({ question: `What amount was discussed in: "${vagueAmt.slice(0, 120)}"?`, about: "amount" });
  if (expensive.length) {
    // One amount question: what commercial range is acceptable (merged with a vague budget line if there is one).
    const q = `What commercial (rent) range is acceptable to the client? They said: "${expensive[0].slice(0, 120)}"${vagueAmt ? ` and "${vagueAmt.slice(0, 80)}"` : ""}`;
    const i = clar.findIndex((c) => c.about === "amount");
    if (i >= 0) clar[i] = { question: `${q} (budget)`, about: "amount" }; else clar.push({ question: q, about: "amount" });
  }
  const contact_updates: Outcome["contact_updates"] = [];
  for (const l of L) {
    const who = ctx.attendees.find((n) => n && l.toLowerCase().includes(n.toLowerCase().split(/\s+/)[0]));
    if (!who) continue;
    const em = l.match(/[\w.+-]+@[\w-]+\.[\w.]+/); const ph = l.match(/(\+91[\s-]?)?[6-9]\d{9}\b/); const ti = l.match(/(?:title is|is now|new role|designation)\s*:?\s*([A-Za-z][A-Za-z &]{2,60})/i);
    if (em) contact_updates.push({ name: who, field: "email", value: em[0].toLowerCase(), quote: l.slice(0, 200) });
    if (ph) contact_updates.push({ name: who, field: "phone", value: ph[0].replace(/[\s-]/g, ""), quote: l.slice(0, 200) });
    if (ti) contact_updates.push({ name: who, field: "title", value: ti[1].trim(), quote: l.slice(0, 200) });
  }
  const ROLE: Record<string, Outcome["new_stakeholders"][number]["role"]> = { finance: "finance", cfo: "finance", procurement: "procurement", legal: "legal", it: "technical", admin: "user", hr: "user", ceo: "approver", md: "approver" };
  const new_stakeholders: Outcome["new_stakeholders"] = [];
  for (const m of all.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) (?:from|in|se|\()\s*(finance|cfo|procurement|legal|IT|admin|HR|CEO|MD)\b/g)) {
    if (ctx.attendees.some((a) => a.toLowerCase() === m[1].toLowerCase())) continue;
    new_stakeholders.push({ name: m[1], role: ROLE[m[2].toLowerCase()] ?? "other", quote: m[0] });
  }
  return {
    summary: all.slice(0, 240), outcome: (/did ?n.t happen|not held|no.show|cancell?ed|postponed|didn.t meet|meeting nahi hui/i.test(all) ? "no_show" : neg ? "negative" : "positive") as Outcome["outcome"],
    requirement_updates: [...(seats ? [{ field: "seats_target" as const, value: seats[1], quote: seats[0] }] : []), ...(area ? [{ field: "area_target_sf" as const, value: area[1].replace(/,/g, ""), quote: area[0] }] : []),
      ...(date && /move|shift/i.test(all) ? [{ field: "occupation_date" as const, value: date[0], quote: date[0] }]
        : within?.m && num(within.m[1]) ? [{ field: "occupation_date" as const, value: edate(mDate, num(within.m[1])!), quote: within.l.slice(0, 200) }] : []),
      ...(tenure?.m && num(tenure.m[1]) ? [{ field: "lease_tenure_months" as const, value: String(num(tenure.m[1])! * (/year/i.test(tenure.m[2]) ? 12 : 1)), quote: tenure.l.slice(0, 200) }] : [])],
    decision_process: finance ? finance.slice(0, 200) : null,
    objections: [...(/broker/i.test(all) ? ["Mentioned an existing broker"] : []), ...expensive.map((l) => `Price objection: ${l.slice(0, 160)}`)], property_feedback: [],
    commitments: L.filter((l) => /\b(we will|i will|will send|will share|send|share|bhej|bhejenge|bhejunga)\b/i.test(l)).map((l) => ({ who: (isThem(l) && !/^(we|i)\b/i.test(l) ? "them" : "us") as "us" | "them", what: l.slice(0, 160), due: dueFrom(l, mDate) })),
    next_meeting: null, followup_date: null,
    buying_signals: L.filter((l) => /shortlist|site visit|proposal|approved|pasand|interested|ready to|finali[sz]e|loi|term sheet/i.test(l) && !/not interested|pasand nahi/i.test(l)).map(st),
    risks: L.filter((l) => /concern|worried|expensive|mehenga|mahanga|delay|broker|competitor|budget (is )?tight|problem|issue/i.test(l)).map(st),
    unresolved_questions: [...L.filter((l) => /\?$|tbd|pata nahi|not sure|to confirm|confirm karna|unclear/i.test(l)).map(st),
      ...(renew ? [{ text: `Decision pending: renew the existing office or relocate — "${renew.slice(0, 160)}"`, basis: "interpretation" as const, quote: renew.slice(0, 200) }] : []),
      ...(finance ? [{ text: `Finance approval is needed — who approves in Finance and what do they need to see?`, basis: "interpretation" as const, quote: finance.slice(0, 200) }] : [])],
    per_property_interest: ppi,
    topics: [...(tenure?.m ? [`Lease tenure: ${tenure.m[1]} ${tenure.m[2]}`] : []), ...(within?.m ? [`Timeline: occupancy within ${within.m[1]} months`] : [])],
    confidence_notes: ["Rule-based extraction (AI off): only explicit phrases were picked up; review before applying.", ...(within?.m ? [`Occupation date is approximate: "${within.m[0]}" counted from the meeting date ${mDate}.`] : [])],
    clarifications_needed: clar, contact_updates, company_notes: [], new_stakeholders,
  };
}
export async function structureOutcome(db: Db, ws: string, userId: string, prepId: string, text: string, ai: Ai = callStructured) {
  const { data: p } = await db.from("meeting_prep").select("asset_ids, meeting:meeting_visit_id(start_at), meeting_prep_attendee(raw_name, person:person_id(full_name))").eq("workspace_id", ws).eq("id", prepId).maybeSingle();
  if (!p) throw new MeetingError("Meeting not found.");
  const startAt = (p.meeting as Row | null)?.start_at as string | undefined;
  const meetingDate = startAt ? localDate(new Date(startAt)) : localDate();
  const [{ data: notes }, { data: assets }, { data: fb }] = await Promise.all([
    db.from("meeting_note").select("kind, text").eq("prep_id", prepId).is("archived_at", null).order("created_at"),
    (p.asset_ids ?? []).length ? db.from("asset").select("id, name").in("id", p.asset_ids) : Promise.resolve({ data: [] as Row[] }),
    db.from("meeting_property_feedback").select("asset_id, fields").eq("prep_id", prepId).is("archived_at", null),
  ]);
  const nameOf = (id: string) => ((assets ?? []) as Row[]).find((a) => a.id === id)?.name ?? "Property";
  const feedback = ((fb ?? []) as Row[]).map((f) => ({ property: nameOf(f.asset_id), interest: String(f.fields?.interest ?? "unclear"), explicit: !!f.fields?.explicit_rejection, text: feedbackLine(nameOf(f.asset_id), f.fields) }));
  const all = [text, ...((notes ?? []) as Row[]).map((n) => `[${n.kind}] ${n.text}`)].filter((s) => s.trim()).join("\n");
  if (!all.trim() && !feedback.length) throw new MeetingError("Add notes first.");
  const attendees = ((p.meeting_prep_attendee ?? []) as Row[]).map((a) => a.person?.full_name ?? a.raw_name).filter(Boolean) as string[];
  const evidence = [all, feedback.length ? `Structured site-visit feedback (entered by the adviser):\n${feedback.map((f) => `- ${f.text}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  const r = await ai({ workspaceId: ws, workflow: "meetings.outcome", tier: "luna", schema: Out, schemaName: "meeting_outcome", maxOutputTokens: 2500,
    system: [
      "Structure a commercial real-estate adviser's meeting notes (Pune, India).",
      "Notes may be in English, Hindi (Devanagari) or Hinglish (Hindi in Latin script mixed with English, e.g. 'unko 300 seats chahiye', 'Baner wala pasand nahi aaya'). Understand all three; write summary and fields in English; keep every quote verbatim in the original language.",
      "Extract only what the notes say; quote the words behind each requirement update, contact update, company note and stakeholder. Dates YYYY-MM-DD only if stated. Numbers as plain digits (1 lakh = 100000, 1 crore = 10000000).",
      "For buying_signals, risks and unresolved_questions mark basis 'statement' when the notes say it directly (quote it) and 'interpretation' when you infer it (quote may be null).",
      "per_property_interest: 'rejected' ONLY when the client clearly said no to that property; negative remarks alone are 'maybe'. Structured feedback marked 'explicit rejection' is a rejection; otherwise it is general feedback.",
      "If a name, date, amount or commitment is ambiguous (e.g. 'next week', 'budget is ok', 'he will check'), add a clarifications_needed question instead of guessing. Never invent people, phone numbers, emails or titles.",
      "confidence_notes: short notes on what is uncertain.",
    ].join(" "),
    input: `Meeting date (IST): ${meetingDate} — resolve "by Friday"/"within nine months" relative to it; commitments by a client attendee are who "them". Lease tenure goes in requirement_updates as lease_tenure_months. Structure these notes. Attendees on record: ${attendees.join(", ") || "none"}. Properties discussed: ${((assets ?? []) as Row[]).map((a) => a.name).join(", ") || "none"}.`, evidence,
    mock: () => mockOutcome(evidence, { properties: ((assets ?? []) as Row[]).map((a) => a.name), attendees, feedback, meetingDate }) });
  await db.from("meeting_prep").update({ outcome: { proposed: r.data, notes_text: text.slice(0, 8000), structured_at: new Date().toISOString(), applied: null, clarifications: {} } }).eq("id", prepId);
  return r.data;
}
export function feedbackLine(property: string, f: Row) {
  const interest = f.interest === "rejected" ? (f.explicit_rejection ? "EXPLICIT REJECTION by client" : "negative feedback (not a rejection)") : f.interest ?? "interest not recorded";
  const parts = [["location", "location & connectivity"], ["commute", "commute/accessibility"], ["layout", "layout & space"], ["quality", "building quality & amenities"], ["parking", "parking & operations"], ["pricing", "pricing concerns"], ["stakeholders", "stakeholder reactions"], ["notes", "notes"]].filter(([k]) => f[k]).map(([k, l]) => `${l}: ${f[k]}`);
  return `${property}: overall ${f.overall ?? "?"}/5, ${interest}${parts.length ? "; " + parts.join("; ") : ""}`;
}
/** The user answers ambiguous points before applying; answers are kept with the outcome. */
export async function answerClarifications(db: Db, ws: string, prepId: string, answers: Record<string, string>) {
  const { data: p } = await db.from("meeting_prep").select("outcome").eq("workspace_id", ws).eq("id", prepId).single();
  if (!p?.outcome?.proposed) throw new MeetingError("Structure the notes first.");
  await db.from("meeting_prep").update({ outcome: { ...p.outcome, clarifications: { ...(p.outcome.clarifications ?? {}), ...answers } } }).eq("id", prepId);
}
export function openClarifications(outcome: Row | null | undefined) {
  const qs = ((outcome?.proposed?.clarifications_needed ?? []) as { question: string; about: string }[]);
  return qs.map((q, i) => ({ ...q, i, answer: (outcome?.clarifications ?? {})[String(i)] ?? "" })).filter((q) => !String(q.answer).trim());
}

const REQ_LABEL: Record<string, (v: string) => string> = {
  area_target_sf: (v) => `Area: about ${Number(v).toLocaleString("en-IN")} sq ft`, seats_target: (v) => `Seats: ${v}`, budget_max: (v) => `Budget up to ${v}`,
  occupation_date: (v) => `Target occupancy: ${v}`, decision_date: (v) => `Decision by ${v}`, objective: (v) => `Objective: ${v}`,
  lease_tenure_months: (v) => `Preferred lease tenure: ${Number(v) % 12 === 0 ? `${Number(v) / 12} years` : `${v} months`}`,
};
/** Facts for the follow-up email (Module 5), taken only from the structured outcome the user reviewed. */
export function followupFacts(o: Outcome, attendees: { name: string }[]): { text: string; source_type: string; source_id: null }[] {
  const f = (text: string, source_type: string) => ({ text: text.replace(/^\[\w+\]\s*/gm, "").trim(), source_type, source_id: null });
  const reqs = o.requirement_updates.map((u) => REQ_LABEL[u.field]?.(u.value)).filter(Boolean) as string[];
  const first = (n: string) => n.split(/\s+/)[0];
  const them = attendees[0]?.name ? first(attendees[0].name) : "You";
  const summary = reqs.length ? reqs : o.summary.replace(/\[\w+\]\s*/g, "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
  const extras = [...(o.decision_process ? [o.decision_process] : []), ...o.unresolved_questions.filter((u) => /renew|relocat/i.test(u.text)).map((u) => u.text)];
  const commitments = o.commitments.map((c) => `${c.what.replace(/\.$/, "")} (${c.who === "us" ? "us" : them}${c.due ? `, by ${c.due}` : ""})`);
  const ours = o.commitments.find((c) => c.who === "us");
  const next = o.next_meeting ?? (ours ? `${ours.what.replace(/^we will\s+/i, "we will ").replace(/\.$/, "")}${ours.due && !ours.what.includes(ours.due) ? ` (by ${ours.due})` : ""}` : null);
  return [...[...summary, ...extras].map((t) => f(t, "meeting_summary")), ...commitments.map((t) => f(t, "meeting_commitment")), ...(next ? [f(next.charAt(0).toUpperCase() + next.slice(1), "meeting_next_step")] : [])];
}

export interface ApplySel { requirement: boolean; tasks: boolean; interaction: boolean; followupDraft: boolean; contacts?: boolean; company?: boolean; stakeholders?: boolean; nextActionDate?: string | null; assigneeUserId?: string | null }
/** User approves selected parts. Requirement/opportunity/contact/company/stakeholder changes become change proposals; tasks + interaction are created. */
export async function applyOutcome(db: Db, ws: string, userId: string, prepId: string, sel: ApplySel) {
  const x = await gather(db, ws, prepId);
  const o = x.prep.outcome?.proposed as Outcome | undefined;
  if (!o) throw new MeetingError("Structure the notes first.");
  if (x.prep.outcome?.applied) throw new MeetingError("Already applied.");
  if (o.outcome === "no_show") throw new MeetingError("The notes say the meeting didn't happen — use 'Meeting didn't happen' instead.");
  const open = openClarifications(x.prep.outcome);
  if (open.length) throw new MeetingError(`Answer the ${open.length} clarification question(s) first.`);
  const clar = ((o.clarifications_needed ?? []) as Row[]).map((q, i) => `${q.question} → ${(x.prep.outcome?.clarifications ?? {})[String(i)]}`);
  let assignee = userId;
  if (sel.assigneeUserId && sel.assigneeUserId !== userId) {
    const { data: mem } = await db.from("membership").select("user_id").eq("workspace_id", ws).eq("user_id", sel.assigneeUserId).maybeSingle();
    if (!mem) throw new MeetingError("That person isn't a member of this workspace.");
    assignee = sel.assigneeUserId;
  }
  const res = { proposals: 0, tasks: 0, interaction: null as string | null, draft: null as string | null };
  const reason = (what: string) => `From meeting "${x.meeting.title}" (${x.meeting.start_at.slice(0, 10)}): ${what}`.slice(0, 900);
  if (sel.interaction) {
    const key = `meeting:${prepId}`;
    const prev = (await db.from("interaction").select("id").eq("workspace_id", ws).eq("source_message_id", key).maybeSingle()).data;
    const summary = [o.summary, ...(clar.length ? [`Clarified: ${clar.join("; ")}`] : [])].join("\n");
    const ins = prev ?? (await db.from("interaction").insert({ workspace_id: ws, occurred_at: x.meeting.start_at, channel: x.prep.meeting_type === "site_visit" ? "visit" : "meeting", direction: "internal", subject: x.meeting.title, summary, promises: o.commitments, objections: o.objections.map((t) => ({ text: t })), opportunity_id: x.prep.opportunity_id, is_meaningful: true, source_message_id: key, owner_user_id: userId }).select("id").single()).data!;
    res.interaction = ins.id;
    if (!prev) await db.from("interaction_link").insert([...x.attendees.filter((a) => a.personId).map((a) => ({ workspace_id: ws, interaction_id: ins.id, entity_type: "person", entity_id: a.personId, role: "participant" })), ...(x.prep.org_id ? [{ workspace_id: ws, interaction_id: ins.id, entity_type: "organisation", entity_id: x.prep.org_id, role: "mentioned" }] : [])]);
  }
  if (sel.requirement && x.requirement && o.requirement_updates.length) {
    const cols = o.requirement_updates.filter((u) => u.field !== "lease_tenure_months");
    const ten = o.requirement_updates.find((u) => u.field === "lease_tenure_months");
    const patch = [
      ...cols.map((u) => ({ op: "replace" as const, path: `/${u.field}`, value: ["seats_target", "area_target_sf", "budget_max"].includes(u.field) ? Number(String(u.value).replace(/[^\d.]/g, "")) : u.value })),
      // No tenure column: kept as a structured requirement constraint (months), with the quote in the proposal reason.
      ...(ten && Number(ten.value) > 0 ? [{ op: "replace" as const, path: "/constraints", value: { ...((x.requirement.constraints ?? {}) as Row), lease_tenure_months: Number(ten.value) } }] : []),
    ];
    await proposeChange(db, ws, { targetType: "requirement", targetId: x.requirement.id, patch, reason: `From meeting notes "${x.meeting.title}": ${o.requirement_updates.map((u) => `"${u.quote}"`).join(", ")}`, proposedByKind: "model", idempotencyKey: `meeting:${prepId}:req`, ownerUserId: userId });
    res.proposals++;
  }
  const nextDate = sel.nextActionDate && /^\d{4}-\d{2}-\d{2}$/.test(sel.nextActionDate) ? sel.nextActionDate : sel.requirement ? o.followup_date : null;
  if (x.prep.opportunity_id && nextDate) {
    const ok = await proposeChange(db, ws, { targetType: "opportunity", targetId: x.prep.opportunity_id, patch: [{ op: "replace", path: "/next_action", value: o.next_meeting ?? "Follow up after meeting" }, { op: "replace", path: "/next_action_due", value: nextDate }], reason: reason("next step"), proposedByKind: "model", idempotencyKey: `meeting:${prepId}:opp`, ownerUserId: userId }).then(() => true).catch(() => false);
    if (ok) res.proposals++;
  }
  const personByName = (n: string) => x.attendees.find((a) => a.personId && a.name.toLowerCase() === n.toLowerCase()) ?? x.attendees.find((a) => a.personId && a.name.toLowerCase().split(/\s+/)[0] === n.toLowerCase().split(/\s+/)[0]);
  if (sel.contacts) {
    for (const [i, c] of (o.contact_updates ?? []).entries()) {
      const a = personByName(c.name); if (!a) continue;
      if (c.field === "title") {
        const { data: emp } = await db.from("employment").select("id").eq("workspace_id", ws).eq("person_id", a.personId!).eq("is_current", true).limit(1).maybeSingle();
        if (!emp) continue;
        await proposeChange(db, ws, { targetType: "employment", targetId: emp.id, patch: [{ op: "replace", path: "/title", value: c.value.slice(0, 120) }], reason: reason(`"${c.quote}"`), proposedByKind: "model", idempotencyKey: `meeting:${prepId}:contact:${i}`, ownerUserId: userId });
      } else {
        await proposeChange(db, ws, { targetType: "contact_method", operation: "create", patch: [{ op: "add", path: "/person_id", value: a.personId }, { op: "add", path: "/method_type", value: c.field }, { op: "add", path: "/value", value: c.value.slice(0, 200) }], reason: reason(`"${c.quote}"`), proposedByKind: "model", idempotencyKey: `meeting:${prepId}:contact:${i}`, ownerUserId: userId });
      }
      res.proposals++;
    }
  }
  if (sel.company && x.org && (o.company_notes ?? []).length) {
    const prev = (await db.from("organisation").select("account_owner_note").eq("id", x.org.id).maybeSingle()).data?.account_owner_note ?? "";
    const add = o.company_notes.map((n) => `${x.meeting.start_at.slice(0, 10)} meeting: ${n.text}`).join("\n");
    await proposeChange(db, ws, { targetType: "organisation", targetId: x.org.id, patch: [{ op: "replace", path: "/account_owner_note", value: [prev, add].filter(Boolean).join("\n").slice(-4000) }], reason: reason(o.company_notes.map((n) => `"${n.quote}"`).join(", ")), proposedByKind: "model", idempotencyKey: `meeting:${prepId}:org`, ownerUserId: userId });
    res.proposals++;
  }
  if (sel.stakeholders && x.requirement && (o.new_stakeholders ?? []).length) {
    for (const [i, s] of o.new_stakeholders.entries()) {
      const known = personByName(s.name)?.personId ?? (await db.from("person").select("id").eq("workspace_id", ws).ilike("full_name", escapeLike(s.name)).limit(2)).data?.filter((_, __, arr) => arr.length === 1)[0]?.id ?? null;
      if (known) {
        await proposeChange(db, ws, { targetType: "stakeholder", operation: "create", patch: [{ op: "add", path: "/requirement_id", value: x.requirement.id }, { op: "add", path: "/person_id", value: known }, { op: "add", path: "/role", value: s.role }, { op: "add", path: "/influence_basis", value: `Mentioned in meeting: "${s.quote}"`.slice(0, 300) }], reason: reason(`"${s.quote}"`), proposedByKind: "model", idempotencyKey: `meeting:${prepId}:stk:${i}`, ownerUserId: userId });
      } else {
        // Unknown person: propose the contact (review-required) and leave a task to link them as a stakeholder once approved.
        await proposeChange(db, ws, { targetType: "person", operation: "create", patch: [{ op: "add", path: "/full_name", value: s.name.slice(0, 120) }], reason: reason(`new stakeholder (${s.role}): "${s.quote}"`), proposedByKind: "model", idempotencyKey: `meeting:${prepId}:stkp:${i}`, ownerUserId: userId });
        const key = `meeting:${prepId}:stktask:${i}`;
        if (!(await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).limit(1)).data?.length)
          await db.from("task").insert({ workspace_id: ws, title: `After approval, add ${s.name} as ${s.role} stakeholder on "${x.requirement.title}"`.slice(0, 200), due_at: `${addDays(today(), 3)}T09:00:00+05:30`, assigned_user_id: assignee, linked_entity_type: "requirement", linked_entity_id: x.requirement.id, source: "meeting", idempotency_key: key, owner_user_id: userId });
      }
      res.proposals++;
    }
  }
  if (sel.tasks) {
    for (const [i, c] of o.commitments.entries()) {
      if (c.who !== "us") continue;
      const key = `meeting:${prepId}:${i}`;
      if ((await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).limit(1)).data?.length) continue;
      await db.from("task").insert({ workspace_id: ws, title: c.what.slice(0, 200), due_at: `${c.due && /^\d{4}-\d{2}-\d{2}$/.test(c.due) ? c.due : addDays(today(), 2)}T09:00:00+05:30`, assigned_user_id: assignee, linked_entity_type: x.prep.opportunity_id ? "opportunity" : "organisation", linked_entity_id: x.prep.opportunity_id ?? x.prep.org_id, source: "meeting", idempotency_key: key, owner_user_id: userId });
      res.tasks++;
    }
  }
  if (sel.followupDraft) {
    const target = x.attendees.find((a) => a.personId && !a.doNotContact);
    if (target) {
      const { createOutreach } = await import("@/modules/outreach/service");
      const r = await createOutreach(db, ws, userId, { personId: target.personId!, channels: ["meeting_followup"], scenario: "meeting_followup", opportunityId: x.prep.opportunity_id, extraFacts: followupFacts(o, x.attendees) }).catch(() => null);
      res.draft = r?.ids[0] ?? null;
    }
  }
  await db.from("meeting_prep").update({ status: "completed", outcome: { ...x.prep.outcome, applied: { at: new Date().toISOString(), by: userId, assignee, ...res } } }).eq("id", prepId);
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
  L.push(...meetingMemoryMarkdown(b.memory));
  return L.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
