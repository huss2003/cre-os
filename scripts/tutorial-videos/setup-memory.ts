/**
 * Demo data for the "memory" tutorial videos (Module 13 Intelligence Layer). Local Supabase + demo workspace ONLY.
 * Everything is synthetic (ids from did("tutorial:memory:…")):
 *   - Nimbus Ledger Systems (demo) — a client whose requirement changed: 10,000 sf in Hinjewadi by Dec 2026
 *     (v1, from Rahul) → 15,000 sf in Kharadi by Mar 2027 (v2, client-confirmed by Kavita); a deal on it.
 *   - Kavita Menon moved employer: Orchid Fintech (demo) → Nimbus (previous employment kept as history; Orchid's deal stays).
 *   - Decision-maker change: Rahul Bhide (CFO, approver) left Nimbus; Kavita is the new approver.
 *   - "Grade A, immediate occupancy" mentioned in three separate notes (a preference, never a confirmed requirement).
 *   - Skyline Business Park – Tower 2 (demo) and Hinjewadi Phase 2 Business Centre (demo) rejected by the client for parking.
 *   - An old quotation (Feb 2026, valid until Mar 2026) on Skyline.
 *   - A meeting with Kavita tomorrow with a prepared brief ("Before a meeting").
 * Then runs detectChanges for the company, contact and requirement. Re-runnable: stored changes / recommendations /
 * corrections for these records are removed first (so videos always start from "open"); nothing else is touched.
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-memory.ts
 */
import { did, DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER, SYNTHETIC_NOTE } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectChanges } from "@/modules/intelligence/memory/changes/service";
import { createMeeting, generateBrief } from "@/modules/meetings/service";

type Row = Record<string, any>;
const id = (kind: string, key: string) => did(`tutorial:memory:${kind}`, key);
export const MEM = {
  nimbus: id("organisation", "nimbus"), orchid: id("organisation", "orchid"),
  kavita: id("person", "kavita"), rahul: id("person", "rahul"), sanjay: id("person", "sanjay"),
  req: id("requirement", "nimbus"), opp: id("opportunity", "nimbus"), orchidReq: id("requirement", "orchid"), orchidOpp: id("opportunity", "orchid"),
  skyline: id("asset", "skyline"), skylineSpace: id("space", "skyline-6"), quote: id("quote", "skyline-old"),
};
const MEETING_TITLE = "Nimbus Ledger — Kharadi options review (demo)";
const VISIT_TITLE = "Site visit — Nimbus Hinjewadi options (demo)";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createAdminClient();
  const must = async <T,>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what = "") => { const r = await p; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const base = (cls = "corporate_confidential") => ({ workspace_id: WS, owner_user_id: OWNER, classification: cls });
  /** Insert once (stable demo rows are never rewritten — avoids the material-change guards on re-runs). */
  const once = async (table: string, rows: Row[]) => { for (const row of rows) { const { error } = await db.from(table).upsert(row, { onConflict: "id", ignoreDuplicates: true }); if (error) throw new Error(`${table}: ${error.message}`); } };
  const note = `Tutorial demo record (memory). ${SYNTHETIC_NOTE}`;
  const geo = async (name: string) => ((await must(db.from("geography").select("id").eq("workspace_id", WS).eq("name", name).limit(1), name)) as Row[])[0]?.id as string;
  const HINJ = await geo("Hinjewadi"), KHARADI = await geo("Kharadi");
  const hpbc = ((await must(db.from("asset").select("id").eq("workspace_id", WS).eq("name", "Hinjewadi Phase 2 Business Centre (demo)").limit(1))) as Row[])[0]?.id as string | undefined;
  if (!HINJ || !KHARADI) throw new Error("demo geographies missing — run setup-demo.ts first");

  // ---- companies, people, employment
  await once("organisation", [
    { ...base(), id: MEM.nimbus, display_name: "Nimbus Ledger Systems (demo)", legal_name: "Nimbus Ledger Systems Pvt Ltd (demo)" },
    { ...base(), id: MEM.orchid, display_name: "Orchid Fintech (demo)", legal_name: "Orchid Fintech Pvt Ltd (demo)" },
  ]);
  await once("person", [
    { ...base("permitted_personal"), id: MEM.kavita, full_name: "Kavita Menon", personal_notes: note },
    { ...base("permitted_personal"), id: MEM.rahul, full_name: "Rahul Bhide", personal_notes: note },
    { ...base("permitted_personal"), id: MEM.sanjay, full_name: "Sanjay Kulkarni", personal_notes: note },
  ]);
  await once("employment", [
    { ...base(), id: id("employment", "kavita-orchid"), person_id: MEM.kavita, org_id: MEM.orchid, title: "Head – Admin & Facilities", seniority: "head", start_date: "2021-04-01", end_date: "2026-06-30", is_current: false, fact_status: "reported", created_at: "2025-01-10T06:00:00Z" },
    { ...base(), id: id("employment", "kavita-nimbus"), person_id: MEM.kavita, org_id: MEM.nimbus, title: "Director – Real Estate & Workplace", seniority: "director", start_date: "2026-07-01", is_current: true, fact_status: "reported", created_at: "2026-07-08T06:00:00Z" },
    { ...base(), id: id("employment", "rahul-nimbus"), person_id: MEM.rahul, org_id: MEM.nimbus, title: "Chief Financial Officer", seniority: "c_level", start_date: "2019-01-01", end_date: "2026-08-31", is_current: false, fact_status: "reported" },
    { ...base(), id: id("employment", "sanjay-nimbus"), person_id: MEM.sanjay, org_id: MEM.nimbus, title: "Facilities Manager", seniority: "manager", is_current: true, fact_status: "reported" },
  ]);
  await once("contact_method", [{ ...base("permitted_personal"), id: id("contact", "kavita-email"), person_id: MEM.kavita, method_type: "email", value: "kavita.menon@nimbusledger.example", preferred: true }]);
  await once("relationship_edge", [{ ...base("permitted_personal"), id: id("edge", "me-kavita"), from_user_id: OWNER, to_person_id: MEM.kavita, edge_type: "knows", warmth: "warm", strength_basis: "Worked together on Orchid's Baner lease (2024) and now Nimbus", last_meaningful_contact: "2026-10-20" }]);

  // ---- requirement (current = v2) + immutable versions
  const v1 = { title: "Nimbus Ledger — Pune office (demo)", area_target_sf: 10000, area_min_sf: null, area_max_sf: null, area_basis: "chargeable", budget_min: null, budget_max: 85, budget_basis: "per_sf_month",
    preferred_geography_ids: [HINJ], excluded_geography_ids: [], occupation_date: "2026-12-01", decision_date: null };
  const v2 = { ...v1, area_target_sf: 15000, budget_max: 95, preferred_geography_ids: [KHARADI], occupation_date: "2027-03-01" };
  await once("requirement", [{ ...base(), id: MEM.req, org_id: MEM.nimbus, title: v1.title, objective: "relocation", transaction_kinds: ["conventional"], area_target_sf: 15000, area_basis: "chargeable",
    budget_max: 95, budget_basis: "per_sf_month", preferred_geography_ids: [KHARADI], occupation_date: "2027-03-01", status: "client_confirmed", created_at: "2026-06-15T06:00:00Z" },
    { ...base(), id: MEM.orchidReq, org_id: MEM.orchid, title: "Orchid Fintech — Baner renewal (demo)", objective: "renewal", transaction_kinds: ["conventional"], area_target_sf: 8000, area_basis: "chargeable", status: "estimated" }]);
  await once("requirement_version", [
    { ...base(), id: id("reqv", "1"), requirement_id: MEM.req, version: 1, snapshot: v1, field_status: { area: "client_confirmed", preferred_locations: "client_confirmed" }, change_reason: "Initial brief — call with Rahul Bhide (CFO)", created_at: "2026-06-15T06:00:00Z" },
    { ...base(), id: id("reqv", "2"), requirement_id: MEM.req, version: 2, snapshot: v2, field_status: { area: "client_confirmed", preferred_locations: "client_confirmed", occupation_date: "client_confirmed" }, change_reason: "Call with Kavita: headcount grew after funding; team moving to East Pune", created_at: "2026-10-20T08:30:00Z" },
  ]);
  await once("opportunity", [
    { ...base(), id: MEM.opp, org_id: MEM.nimbus, requirement_id: MEM.req, name: "Nimbus Ledger — Pune office (demo)", stage: "options_visits", temperature: "warm" },
    { ...base(), id: MEM.orchidOpp, org_id: MEM.orchid, requirement_id: MEM.orchidReq, name: "Orchid Fintech — Baner renewal (demo)", stage: "engaged" },
  ]);
  await once("stakeholder", [
    { ...base(), id: id("stake", "rahul"), requirement_id: MEM.req, person_id: MEM.rahul, role: "approver", archived_at: "2026-09-05T06:00:00Z" },
    { ...base(), id: id("stake", "kavita"), requirement_id: MEM.req, person_id: MEM.kavita, role: "approver" },
    { ...base(), id: id("stake", "sanjay"), requirement_id: MEM.req, person_id: MEM.sanjay, role: "influencer" },
    { ...base(), id: id("stake", "kavita-orchid"), requirement_id: MEM.orchidReq, person_id: MEM.kavita, role: "sponsor" },
  ]);

  // ---- conversations (three mention "Grade A, immediate occupancy"), commitments and an objection
  const conv: [string, string, string, string, string, Row[], string[], string[]][] = [
    ["orchid-2024", "2024-11-12T06:00:00Z", "meeting", "Orchid — Baner lease renewal", "Kavita (then at Orchid) walked through the Baner renewal; she shared the landlord's escalation history voluntarily.", [], [], [MEM.orchid]],
    ["intro", "2026-07-20T06:00:00Z", "meeting", "Intro with Kavita at Nimbus", "Kavita joined Nimbus as Director – Real Estate. They prefer a Grade A building with immediate occupancy.", [{ what: "Send Hinjewadi options", who: "us", due: "2026-07-27", status: "done" }], [], [MEM.nimbus]],
    ["visit", "2026-09-02T06:00:00Z", "visit", "Hinjewadi site visits", "Visited Skyline and Hinjewadi Phase 2. Again: Grade A, immediate occupancy. Parking was the problem at both.", [{ what: "Send Kharadi options with parking ratios", who: "us", due: "2026-09-10" }], ["Parking is limited at Skyline"], [MEM.nimbus]],
    ["change", "2026-10-20T08:00:00Z", "call", "Requirement update call", "Headcount grew after funding: now 15,000 sf in Kharadi by March 2027. Still wants Grade A with immediate occupancy.", [{ what: "Share Kharadi shortlist", who: "us", due: "2026-10-30" }], [], [MEM.nimbus]],
  ];
  for (const [k, at, channel, subject, summary, promises, objections, orgs] of conv) {
    const iid = id("interaction", k);
    await once("interaction", [{ ...base(), id: iid, occurred_at: at, channel, direction: "outbound", subject, summary, promises, objections, is_meaningful: true, opportunity_id: orgs[0] === MEM.nimbus ? MEM.opp : null }]);
    await once("interaction_link", [{ ...base(), id: id("ilink", `${k}-p`), interaction_id: iid, entity_type: "person", entity_id: MEM.kavita },
      ...orgs.map((o) => ({ ...base(), id: id("ilink", `${k}-o`), interaction_id: iid, entity_type: "organisation", entity_id: o }))]);
  }
  const prefNotes: [string, string][] = [["1", "2026-07-20"], ["2", "2026-09-02"], ["3", "2026-10-20"]];
  await once("capture_observation", prefNotes.map(([n, d]) => ({ ...base(), id: id("obs", `pref-${n}`), obs_key: `tut-mem:pref:${n}`, intent: "new_property_requirement", fact_class: "preference", field: "building_preference",
    raw_text: "Prefers Grade A, immediate occupancy", value_json: "grade a, immediate occupancy", source_type: "typed_note", source_hash: `tut-mem-note-${n}`, content_hash: "tut-mem-pref",
    observed_at: d, subject_type: "organisation", subject_id: MEM.nimbus, status: "auto_saved" })));

  // ---- property, old quote, explicit rejections (parking)
  await once("asset", [{ ...base(), id: MEM.skyline, asset_kind: "building", name: "Skyline Business Park – Tower 2 (demo)", micro_market_id: HINJ, grade: "A", address: "Hinjewadi Phase 1, Pune (demo)" }]);
  await once("space", [{ ...base(), id: MEM.skylineSpace, asset_id: MEM.skyline, floor_text: "6" }]);
  await once("quote", [{ ...base(), id: MEM.quote, requirement_id: MEM.req, space_id: MEM.skylineSpace, version: 1, valid_until: "2026-03-31", terms_json: { rent: 78, cam: 12, basis: "per sf / month, chargeable" }, created_at: "2026-02-10T06:00:00Z" }]);
  await once("shortlist_option", [{ ...base(), id: id("option", "skyline"), requirement_id: MEM.req, asset_id: MEM.skyline, space_id: MEM.skylineSpace, option_status: "rejected", disqualifiers: ["parking"], eligible: false, version: 1, rubric_version: "tutorial" }]);
  const visitId = id("visit", "hinjewadi"), visitPrep = id("prep", "hinjewadi");
  await once("meeting_visit", [{ ...base(), id: visitId, title: VISIT_TITLE, start_at: "2026-09-02T05:30:00Z", end_at: "2026-09-02T08:00:00Z", status: "completed", kind: "site_visit", linked_entity_type: "organisation", linked_entity_id: MEM.nimbus, opportunity_id: MEM.opp }]);
  await once("meeting_prep", [{ ...base(), id: visitPrep, meeting_visit_id: visitId, meeting_type: "site_visit", purpose: "Show Hinjewadi options", org_id: MEM.nimbus, opportunity_id: MEM.opp, requirement_id: MEM.req,
    asset_ids: [MEM.skyline, ...(hpbc ? [hpbc] : [])], status: "completed", source: "manual" }]);
  await once("meeting_property_feedback", [
    { ...base(), id: id("feedback", "skyline"), prep_id: visitPrep, asset_id: MEM.skyline, fields: { interest: "rejected", explicit_rejection: true, parking: "Only 1 car park per 2,000 sq ft — client needs 1 per 1,000", reason: "Not enough parking for the team" } },
    ...(hpbc ? [{ ...base(), id: id("feedback", "hpbc"), prep_id: visitPrep, asset_id: hpbc, fields: { interest: "rejected", explicit_rejection: true, parking: "Visitor parking only on the street", reason: "Parking too far from the building" } }] : []),
  ]);

  // ---- reset stored memory for these records (videos acknowledge / dismiss things), then detect again
  const ids = [MEM.nimbus, MEM.orchid, MEM.kavita, MEM.rahul, MEM.sanjay, MEM.req, MEM.orchidReq, MEM.opp, MEM.orchidOpp, MEM.skyline];
  const ch = (await must(db.from("memory_change").select("id").eq("workspace_id", WS).in("entity_id", ids))) as Row[];
  if (ch.length) {
    await must(db.from("reassessment_mark").delete().eq("workspace_id", WS).in("cause_id", ch.map((c) => c.id)));
    await must(db.from("memory_change").delete().eq("workspace_id", WS).in("id", ch.map((c) => c.id)));
  }
  await must(db.from("memory_recommendation").delete().eq("workspace_id", WS).in("entity_id", ids));
  await must(db.from("memory_lifecycle").delete().eq("workspace_id", WS).in("entity_id", ids));
  const ctx = { db: db as never, workspaceId: WS, userId: OWNER };
  for (const scope of [{ orgId: MEM.nimbus }, { personId: MEM.kavita }, { requirementId: MEM.req }, { assetId: MEM.skyline }]) {
    const r = await detectChanges(ctx, scope as never);
    console.log("detect", JSON.stringify(scope), r.detected.map((c) => c.kind).join(", "), "inserted", r.inserted.length);
  }

  // ---- tomorrow's meeting with Kavita, with a prepared brief
  const old = (await must(db.from("meeting_visit").select("id").eq("workspace_id", WS).eq("title", MEETING_TITLE).is("archived_at", null))) as Row[];
  if (old.length) {
    const now = new Date().toISOString();
    await must(db.from("meeting_prep").update({ archived_at: now }).eq("workspace_id", WS).in("meeting_visit_id", old.map((m) => m.id)));
    await must(db.from("meeting_visit").update({ archived_at: now }).eq("workspace_id", WS).in("id", old.map((m) => m.id)));
  }
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + 864e5));
  const m = await createMeeting(db as never, WS, OWNER, { title: MEETING_TITLE, start: `${day}T11:00:00+05:30`, orgId: MEM.nimbus, opportunityId: MEM.opp, requirementId: MEM.req,
    personIds: [MEM.kavita, MEM.sanjay], type: "requirement", purpose: "Walk Kavita through the Kharadi shortlist for 15,000 sf." } as never);
  await generateBrief(db as never, WS, OWNER, m.id);
  console.log("meeting", m.id);
  console.log("MEM", JSON.stringify(MEM));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
