import "server-only";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { gather, generateBrief, feedbackLine, MeetingError, type Outcome } from "./service";
import { MEETING_TYPES } from "./rules";

/** Module 7 additions: auto-brief, today view, follow-ups, site-visit feedback, uploads, follow-up pack, reports. */
type Row = Record<string, any>;
type Ai = typeof callStructured;
export const BUCKET = "mudar-workspace-files";
const istDay = (d: Date) => new Date(+d + 5.5 * 3600e3).toISOString().slice(0, 10);

// ------------------------------------------------------------------ 1. automatic brief ~1 hour before
/**
 * Preps whose meeting starts in 60–75 minutes and have no brief, or a brief built for a different start time
 * (rescheduled), get a brief. Idempotent per meeting start via meeting_prep.auto_brief_for (one attempt per start).
 */
export async function autoBriefs(db: Db, ws: string, now = new Date(), ai: Ai = callStructured) {
  const from = new Date(+now + 60 * 6e4).toISOString(), to = new Date(+now + 75 * 6e4).toISOString();
  const { data } = await db.from("meeting_prep").select("id, owner_user_id, status, brief, auto_brief_for, meeting:meeting_visit_id!inner(start_at, status)").eq("workspace_id", ws).is("archived_at", null)
    .not("status", "in", "(cancelled,completed,researching)").gte("meeting.start_at", from).lte("meeting.start_at", to).limit(100);
  let generated = 0, failed = 0;
  for (const p of (data ?? []) as Row[]) {
    if (!p.meeting || p.meeting.status === "cancelled") continue;
    const start = p.meeting.start_at as string;
    const fresh = p.brief && Date.parse(p.brief.overview?.start) === Date.parse(start) && p.status !== "rescheduled";
    if (fresh) continue;
    if (p.auto_brief_for && Date.parse(p.auto_brief_for) === Date.parse(start)) continue;          // already tried for this start
    await db.from("meeting_prep").update({ auto_brief_for: start }).eq("workspace_id", ws).eq("id", p.id);
    try { await generateBrief(db, ws, p.owner_user_id, p.id, ai); generated++; } catch { failed++; }  // failure stays visible on the page (brief_error)
  }
  return { generated, failed };
}

// ------------------------------------------------------------------ 2. today + pending follow-ups
export async function todayView(db: Db, ws: string, now = new Date()) {
  const day = istDay(now);
  const from = new Date(`${day}T00:00:00+05:30`).toISOString(), to = new Date(`${day}T23:59:59+05:30`).toISOString();
  const { data } = await db.from("meeting_prep").select("id, status, meeting_type, readiness, readiness_detail, brief, reviewed_at, meeting:meeting_visit_id!inner(title, start_at, end_at, location, status), org:org_id(display_name), meeting_prep_attendee(id)")
    .eq("workspace_id", ws).is("archived_at", null).neq("status", "cancelled").gte("meeting.start_at", from).lte("meeting.start_at", to).limit(100);
  const meetings = ((data ?? []) as Row[]).sort((a, b) => a.meeting.start_at.localeCompare(b.meeting.start_at)).map((r) => ({
    id: r.id as string, title: r.meeting.title as string, start: r.meeting.start_at as string, location: r.meeting.location as string | null, org: r.org?.display_name ?? null, type: MEETING_TYPES[r.meeting_type]?.label ?? r.meeting_type,
    status: r.status as string, readiness: r.readiness as number | null, attendees: (r.meeting_prep_attendee ?? []).length as number,
    prep: r.status === "completed" ? "Done" : r.reviewed_at ? "Reviewed" : r.brief ? (Date.parse(r.brief.overview?.start) === Date.parse(r.meeting.start_at) ? "Brief ready" : "Brief out of date") : "No brief yet",
    critical: ((r.readiness_detail?.critical ?? []) as string[]).length,
  }));
  return { day, meetings, followups: await pendingFollowups(db, ws, now) };
}
/** Completed meetings with open tasks created by applyOutcome (idempotency key meeting:<prepId>:...). */
export async function pendingFollowups(db: Db, ws: string, now = new Date()) {
  // Page through every open meeting task (one response is capped at 1,000 rows; a single .limit(300) hid meetings).
  const tasks: Row[] = [];
  for (let from = 0; from < 10_000; from += 1000) {
    const { data } = await db.from("task").select("id, title, due_at, assigned_user_id, idempotency_key").eq("workspace_id", ws).eq("status", "open").eq("source", "meeting").like("idempotency_key", "meeting:%").order("due_at").order("id").range(from, from + 999);
    tasks.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const byPrep = new Map<string, Row[]>();
  for (const t of tasks) { const id = String(t.idempotency_key).split(":")[1]; if (!byPrep.has(id)) byPrep.set(id, []); byPrep.get(id)!.push(t); }
  if (!byPrep.size) return [];
  const keys = [...byPrep.keys()].filter((k) => /^[0-9a-f-]{36}$/i.test(k));
  const preps: Row[] = [];
  for (let i = 0; i < keys.length; i += 100) { // ~100 ids per request keeps the URL short
    const { data } = await db.from("meeting_prep").select("id, status, meeting:meeting_visit_id(title, start_at), org:org_id(display_name)").eq("workspace_id", ws).in("id", keys.slice(i, i + 100)).eq("status", "completed");
    preps.push(...((data ?? []) as Row[]));
  }
  return preps.map((p) => ({
    id: p.id as string, title: p.meeting?.title ?? "Meeting", date: (p.meeting?.start_at ?? "").slice(0, 10), org: p.org?.display_name ?? null,
    tasks: byPrep.get(p.id)!.map((t) => ({ id: t.id as string, title: t.title as string, due: t.due_at as string | null, overdue: !!t.due_at && Date.parse(t.due_at) < +now })),
  })).sort((a, b) => Number(b.tasks.some((t) => t.overdue)) - Number(a.tasks.some((t) => t.overdue)) || a.date.localeCompare(b.date));
}

// ------------------------------------------------------------------ 3. structured site-visit feedback per property
export const INTEREST = ["interested", "maybe", "rejected"] as const;
export const FEEDBACK_FIELDS: [string, string][] = [["location", "Location & connectivity"], ["commute", "Commute / accessibility"], ["layout", "Layout & space suitability"], ["quality", "Building quality & amenities"], ["parking", "Parking & operational constraints"], ["pricing", "Pricing concerns"], ["stakeholders", "Stakeholder reactions"], ["notes", "Other notes"]];
export interface FeedbackInput { overall?: number | null; interest?: string | null; explicit_rejection?: boolean; [k: string]: unknown }
export async function saveFeedback(db: Db, ws: string, userId: string, prepId: string, assetId: string, f: FeedbackInput) {
  const { data: p } = await db.from("meeting_prep").select("meeting_type, asset_ids").eq("workspace_id", ws).eq("id", prepId).maybeSingle();
  if (!p) throw new MeetingError("Meeting not found.");
  if (!["site_visit", "property_presentation"].includes(p.meeting_type)) throw new MeetingError("Property feedback is for site visits and property presentations.");
  if (!(p.asset_ids ?? []).includes(assetId)) throw new MeetingError("That property isn't linked to this meeting.");
  const overall = f.overall === null || f.overall === undefined || f.overall === ("" as unknown) ? null : Number(f.overall);
  if (overall !== null && !(Number.isInteger(overall) && overall >= 1 && overall <= 5)) throw new MeetingError("Overall impression must be 1–5.");
  const interest = f.interest ? String(f.interest) : null;
  if (interest && !INTEREST.includes(interest as "maybe")) throw new MeetingError("Interest must be interested, maybe or rejected.");
  if (interest === "rejected" && !f.explicit_rejection) throw new MeetingError("Tick “The client clearly rejected it”, or choose Maybe — negative comments alone are general feedback, not a rejection.");
  const fields: Row = { overall, interest, explicit_rejection: interest === "rejected" && !!f.explicit_rejection };
  for (const [k] of FEEDBACK_FIELDS) { const v = typeof f[k] === "string" ? (f[k] as string).trim().slice(0, 1000) : ""; if (v) fields[k] = v; }
  const { data: prev } = await db.from("meeting_property_feedback").select("id").eq("workspace_id", ws).eq("prep_id", prepId).eq("asset_id", assetId).is("archived_at", null).maybeSingle();
  if (prev) await db.from("meeting_property_feedback").update({ fields }).eq("id", prev.id);
  else { const { error } = await db.from("meeting_property_feedback").insert({ workspace_id: ws, prep_id: prepId, asset_id: assetId, fields, owner_user_id: userId }); if (error) throw error; }
  return fields;
}

// ------------------------------------------------------------------ 4. uploaded materials (photos / PDFs / floor plans)
export const UPLOAD_MIME = /^(image\/(png|jpeg|webp|gif|heic|heif)|application\/pdf)$/;
export async function addUploadedMaterial(db: Db, ws: string, userId: string, prepId: string, m: { title: string; path: string; mime: string; internalOnly?: boolean }) {
  if (!m.path.startsWith(`${ws}/meetings/${prepId}/`) || m.path.includes("..")) throw new MeetingError("Upload path doesn't belong to this meeting.");
  if (!UPLOAD_MIME.test(m.mime)) throw new MeetingError("Only photos (PNG/JPEG/WebP/HEIC) and PDFs can be attached.");
  const title = (m.title || m.path.split("/").pop()!.replace(/^[0-9a-f-]{36}-/, "")).slice(0, 200);
  const { data: dup } = await db.from("meeting_material").select("id").eq("prep_id", prepId).eq("url", m.path).limit(1);
  if (dup?.length) return dup[0].id as string;
  const { data, error } = await db.from("meeting_material").insert({ workspace_id: ws, prep_id: prepId, title, url: m.path, mime: m.mime, storage_object: true, internal_only: m.internalOnly ?? true, owner_user_id: userId }).select("id").single();
  if (error) throw error;
  return data.id as string;
}
/** Short-lived signed links for uploaded files (RLS on storage still applies). */
export async function materialLinks(db: Db, materials: Row[]) {
  const out: Record<string, string> = {};
  for (const mt of materials.filter((x) => x.storage_object && x.url)) {
    const { data } = await db.storage.from(BUCKET).createSignedUrl(mt.url, 600);
    if (data?.signedUrl) out[mt.id] = data.signedUrl;
  }
  return out;
}

// ------------------------------------------------------------------ 7. follow-up pack
export async function whatsappFollowup(db: Db, ws: string, userId: string, prepId: string) {
  const x = await gather(db, ws, prepId);
  if (!x.prep.outcome?.applied) throw new MeetingError("Apply the meeting outcome first.");
  const target = x.attendees.find((a) => a.personId && !a.doNotContact);
  if (!target) throw new MeetingError("No attendee is a saved contact who can be contacted.");
  const { createOutreach } = await import("@/modules/outreach/service");
  const r = await createOutreach(db, ws, userId, { personId: target.personId!, channels: ["whatsapp"], scenario: "meeting_followup", opportunityId: x.prep.opportunity_id });
  return r.ids[0] ?? null;
}
/** Next-meeting agenda from unresolved questions + commitments, saved as a note prefixed "Agenda" (updated, not duplicated). */
export async function nextAgenda(db: Db, ws: string, userId: string, prepId: string) {
  const { data: p } = await db.from("meeting_prep").select("outcome, meeting:meeting_visit_id(title)").eq("workspace_id", ws).eq("id", prepId).single();
  const o = p?.outcome?.proposed as Outcome | undefined;
  if (!o) throw new MeetingError("Structure the notes first.");
  const items = [
    ...(o.unresolved_questions ?? []).map((q) => `Resolve: ${q.text}`),
    ...o.commitments.map((c) => `${c.who === "us" ? "Our" : "Their"} commitment — status: ${c.what}${c.due ? ` (due ${c.due})` : ""}`),
    ...(o.per_property_interest ?? []).filter((x) => x.interest === "maybe" || x.interest === "unclear").map((x) => `Decide on ${x.property} (${x.interest})`),
    ...(o.risks ?? []).slice(0, 3).map((r) => `Address concern: ${r.text}`),
  ];
  const text = `Agenda — next meeting after "${(p!.meeting as Row)?.title ?? "meeting"}"\n${items.length ? items.map((i, n) => `${n + 1}. ${i}`).join("\n") : "1. Recap and agree next steps"}`.slice(0, 4000);
  const { data: prev } = await db.from("meeting_note").select("id").eq("prep_id", prepId).eq("kind", "note").like("text", "Agenda%").is("archived_at", null).limit(1);
  if (prev?.length) await db.from("meeting_note").update({ text }).eq("id", prev[0].id);
  else await db.from("meeting_note").insert({ workspace_id: ws, prep_id: prepId, kind: "note", text, owner_user_id: userId });
  return text;
}
/** Internal meeting report (Markdown). Internal use only — never sent anywhere. */
export async function meetingReportMarkdown(db: Db, ws: string, prepId: string) {
  const x = await gather(db, ws, prepId);
  const o = x.prep.outcome?.proposed as Outcome | undefined;
  if (!o) throw new MeetingError("Structure the notes first.");
  const tag = (b: string) => (b === "statement" ? "said" : "our reading");
  const L: string[] = [`# Meeting report — ${x.meeting.title}`, `${new Date(x.meeting.start_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · ${x.org?.display_name ?? "no company linked"} · ${MEETING_TYPES[x.prep.meeting_type]?.label ?? x.prep.meeting_type}`, `Attendees: ${x.attendees.map((a) => a.name).join(", ") || "—"}`, "_Internal — not for distribution._", "", "## Summary", o.summary, `Outcome: ${o.outcome}`, ""];
  const sec = (h: string, xs: string[]) => { if (xs.length) L.push(`## ${h}`, ...xs.map((v) => `- ${v}`), ""); };
  sec("Requirement changes (proposed)", o.requirement_updates.map((u) => `${u.field.replace(/_/g, " ")} → ${u.value} ("${u.quote}")`));
  sec("Buying signals", (o.buying_signals ?? []).map((b) => `${b.text} _(${tag(b.basis)})_`));
  sec("Risks", (o.risks ?? []).map((b) => `${b.text} _(${tag(b.basis)})_`));
  sec("Objections", o.objections);
  sec("Property interest", (o.per_property_interest ?? []).map((pp) => `${pp.property}: ${pp.interest}${pp.quote ? ` ("${pp.quote}")` : ""} _(${tag(pp.basis)})_`));
  sec("Site-visit feedback", x.properties.filter((pp: Row) => pp.feedback).map((pp: Row) => feedbackLine(pp.name, pp.feedback)));
  sec("Commitments", o.commitments.map((c) => `${c.who === "us" ? "We" : "They"}: ${c.what}${c.due ? ` (by ${c.due})` : ""}`));
  sec("Unresolved questions", (o.unresolved_questions ?? []).map((q) => q.text));
  sec("Clarifications", (o.clarifications_needed ?? []).map((q, i) => `${q.question} → ${(x.prep.outcome?.clarifications ?? {})[String(i)] ?? "not answered"}`));
  sec("Confidence notes", o.confidence_notes ?? []);
  if (x.prep.outcome?.applied) L.push(`Applied ${x.prep.outcome.applied.at.slice(0, 10)}: ${x.prep.outcome.applied.proposals} proposal(s) to Review, ${x.prep.outcome.applied.tasks} task(s).`);
  return L.join("\n");
}

// ------------------------------------------------------------------ 8. reports
const pct = (n: number, d: number) => (d ? `${n} of ${d} (${Math.round((n / d) * 100)}%)` : `0 of 0`);
export async function meetingReports(db: Db, ws: string, now = new Date()) {
  const { data } = await db.from("meeting_prep").select("id, status, org_id, asset_ids, outcome, meeting:meeting_visit_id!inner(title, start_at), org:org_id(display_name), meeting_prep_attendee(person_id, raw_name, person:person_id(full_name))")
    .eq("workspace_id", ws).is("archived_at", null).neq("status", "cancelled").lt("meeting.start_at", now.toISOString()).limit(1000);
  const preps = (data ?? []) as Row[];
  const outcomeOf = (p: Row) => (p.outcome?.applied ? (p.outcome?.proposed?.outcome as string) : "not recorded");
  type Agg = { key: string; label: string; count: number; last: string; outcomes: Record<string, number> };
  const agg = (m: Map<string, Agg>, key: string, label: string, p: Row) => {
    const a = m.get(key) ?? { key, label, count: 0, last: "", outcomes: {} };
    a.count++; const d = p.meeting.start_at.slice(0, 10); if (d > a.last) a.last = d;
    const o = outcomeOf(p); a.outcomes[o] = (a.outcomes[o] ?? 0) + 1; m.set(key, a);
  };
  const byCo = new Map<string, Agg>(), byContact = new Map<string, Agg>(), byProp = new Map<string, Agg>();
  const assetIds = [...new Set(preps.flatMap((p) => p.asset_ids ?? []))];
  const { data: assets } = assetIds.length ? await db.from("asset").select("id, name").in("id", assetIds) : { data: [] as Row[] };
  for (const p of preps) {
    agg(byCo, p.org_id ?? "none", p.org?.display_name ?? "No company linked", p);
    for (const a of (p.meeting_prep_attendee ?? []) as Row[]) if (a.person_id) agg(byContact, a.person_id, a.person?.full_name ?? a.raw_name ?? "Contact", p);
    for (const id of (p.asset_ids ?? []) as string[]) agg(byProp, id, ((assets ?? []) as Row[]).find((x) => x.id === id)?.name ?? "Property", p);
  }
  const sort = (m: Map<string, Agg>) => [...m.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  // requirements / opportunities created within 30 days after a meeting with the same company
  const orgMeet = new Map<string, string[]>();
  for (const p of preps) if (p.org_id) orgMeet.set(p.org_id, [...(orgMeet.get(p.org_id) ?? []), p.meeting.start_at]);
  const orgIds = [...orgMeet.keys()];
  const [{ data: reqs }, { data: opps }] = orgIds.length ? await Promise.all([
    db.from("requirement").select("id, title, org_id, created_at").eq("workspace_id", ws).in("org_id", orgIds).limit(1000),
    db.from("opportunity").select("id, name, org_id, created_at").eq("workspace_id", ws).in("org_id", orgIds).limit(1000),
  ]) : [{ data: [] as Row[] }, { data: [] as Row[] }];
  const after = (r: Row) => (orgMeet.get(r.org_id) ?? []).some((s) => { const d = (Date.parse(r.created_at) - Date.parse(s)) / 864e5; return d >= 0 && d <= 30; });
  const createdAfter = [...((reqs ?? []) as Row[]).filter(after).map((r) => ({ kind: "Requirement", id: r.id, label: r.title, created: r.created_at.slice(0, 10) })), ...((opps ?? []) as Row[]).filter(after).map((o) => ({ kind: "Opportunity", id: o.id, label: o.name, created: o.created_at.slice(0, 10) }))];
  const fu = await pendingFollowups(db, ws, now);
  const openTasks = fu.flatMap((f) => f.tasks.map((t) => ({ ...t, meeting: f.title, prepId: f.id })));
  const recorded = preps.filter((p) => p.outcome?.applied).length;
  const positive = preps.filter((p) => p.outcome?.applied && p.outcome?.proposed?.outcome === "positive").length;
  const companiesMet = orgIds.length;
  const companiesWithNew = new Set(createdAfter.map((c) => ((reqs ?? []) as Row[]).concat((opps ?? []) as Row[]).find((r) => r.id === c.id)?.org_id)).size;
  return {
    total: preps.length,
    rates: [
      { label: "Past meetings with an outcome recorded", value: pct(recorded, preps.length) },
      { label: "Recorded outcomes that went well", value: pct(positive, recorded) },
      { label: "Companies met that got a new requirement/opportunity within 30 days", value: pct(companiesWithNew, companiesMet) },
      { label: "Open follow-up actions that are overdue", value: pct(openTasks.filter((t) => t.overdue).length, openTasks.length) },
    ],
    byCompany: sort(byCo), byContact: sort(byContact), byProperty: sort(byProp), createdAfter, pending: openTasks.filter((t) => !t.overdue), overdue: openTasks.filter((t) => t.overdue),
  };
}
