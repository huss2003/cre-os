/**
 * Module 13 — DB-backed acceptance tests for historical/change memory, consolidation, recommendations, quality and
 * integrations (spec §17 scenarios 7–13, 16, 18, 19, 23, 24). Shared local Supabase, RLS as the seeded owner in WS1,
 * mock AI. Fixtures are tagged; only rows created here are removed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { userClient, adminClient, tag, WS1, WS2, USERS } from "../../../../tests/helpers";
import type { MemCtx } from "./types";
import { detectChanges, getRequirementEvolution, listChanges } from "./changes/service";
import { consolidateEntity, consolidateMeetings } from "./consolidate/service";
import { listRecommendations } from "./recommend/service";
import { qualityReport } from "./quality/service";
import { correctMemoryStatus, listCorrections } from "./quality/lifecycle";
import { loadRejections } from "./integrate/rejections";
import { reassessMemory } from "./integrate/consumers";
import { CONSUMERS } from "@/modules/orchestrator/events/process";
import { getTool } from "@/modules/assistant/tools";
import type { ToolContext, ToolResult } from "@/modules/assistant/types";

type Row = Record<string, any>;
const admin = adminClient();
const T = tag("memchg");
const created: { table: string; id: string }[] = [];
let ctx: MemCtx;
let t: ToolContext;

async function ins(table: string, row: Row, ws = WS1): Promise<string> {
  const { data, error } = await admin.from(table).insert({ workspace_id: ws, owner_user_id: USERS.owner.id, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  created.push({ table, id: data.id });
  return data.id as string;
}
const run = (id: string, input: unknown): Promise<ToolResult> => { const tool = getTool(id)!; return tool.run(tool.input.parse(input) as never, t); };
const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

let org: string, org2: string, req: string, opp: string, pOld: string, pNew: string, geoH: string, geoK: string, asset: string, space: string;

beforeAll(async () => {
  const db = await userClient("owner");
  ctx = { db, workspaceId: WS1, userId: USERS.owner.id };
  t = { ctx: { db: db as never, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], isPlatformAdmin: false, workspaces: [] } as never, runId: randomUUID(), conversationId: null, focus: null };
  org = await ins("organisation", { display_name: `Acme ${T}` });
  org2 = await ins("organisation", { display_name: `Other ${T}` });
  geoH = await ins("geography", { name: `Hinjawadi ${T}`, level: "micro_market" });
  geoK = await ins("geography", { name: `Kharadi ${T}`, level: "micro_market" });
  req = await ins("requirement", { org_id: org, title: `Office ${T}`, area_target_sf: 10000, preferred_geography_ids: [geoH], occupation_date: "2026-12-01", status: "estimated" });
  opp = await ins("opportunity", { org_id: org, requirement_id: req, name: `Deal ${T}`, stage: "options_visits" });
  const snap1 = { title: `Office ${T}`, area_target_sf: 10000, area_min_sf: null, area_max_sf: null, area_basis: "chargeable", budget_min: null, budget_max: 90, budget_basis: "per_sf_month", preferred_geography_ids: [geoH], excluded_geography_ids: [], occupation_date: "2026-12-01", decision_date: null };
  await ins("requirement_version", { requirement_id: req, version: 1, snapshot: snap1, field_status: { area: "client_confirmed" }, change_reason: "Initial brief" });
  await ins("requirement_version", { requirement_id: req, version: 2, snapshot: { ...snap1, area_target_sf: 15000, budget_max: 110, preferred_geography_ids: [geoK], occupation_date: "2027-03-01" }, field_status: { area: "client_confirmed", preferred_locations: "client_confirmed" }, change_reason: "Client call: headcount grew" });
  // decision-maker change: old approver removed, new approver added
  pOld = await ins("person", { full_name: `Old Approver ${T}` });
  pNew = await ins("person", { full_name: `New Approver ${T}` });
  await ins("employment", { person_id: pOld, org_id: org, title: "Head Admin", is_current: false, end_date: "2026-08-31", fact_status: "reported" });
  await ins("employment", { person_id: pNew, org_id: org, title: "CRE Director", is_current: true, fact_status: "reported" });
  await ins("stakeholder", { requirement_id: req, person_id: pOld, role: "approver", archived_at: ago(60) });
  await ins("stakeholder", { requirement_id: req, person_id: pNew, role: "approver" });
  // property + stale quotation
  asset = await ins("asset", { name: `Tower ${T}` });
  space = await ins("space", { asset_id: asset, floor_text: "5" });
  await ins("quote", { requirement_id: req, space_id: space, version: 1, valid_until: "2026-01-31", terms_json: { rent: 88 } });
}, 60_000);

afterAll(async () => {
  const ids = [org, org2, req, opp, pOld, pNew, asset].filter(Boolean);
  const { data: ch } = await admin.from("memory_change").select("id").eq("workspace_id", WS1).in("entity_id", ids);
  const chIds = (ch ?? []).map((c) => c.id);
  if (chIds.length) {
    await admin.from("reassessment_mark").delete().eq("workspace_id", WS1).in("cause_id", chIds);
    await admin.from("event_outbox").delete().eq("workspace_id", WS1).in("dedupe_key", chIds.map((id) => `memchange:${id}`));
  }
  await admin.from("memory_recommendation").delete().eq("workspace_id", WS1).in("entity_id", ids);
  await admin.from("memory_change").delete().eq("workspace_id", WS1).in("entity_id", ids);
  await admin.from("memory_lifecycle").delete().eq("workspace_id", WS1).in("entity_id", ids);
  await admin.from("event_processing_log").delete().eq("workspace_id", WS1).in("event_id", (await admin.from("event_outbox").select("id").eq("workspace_id", WS1).in("subject_id", ids)).data?.map((e) => e.id) ?? []);
  await admin.from("event_outbox").delete().eq("workspace_id", WS1).in("subject_id", ids);
  await admin.from("job").delete().eq("workspace_id", WS1).like("dedupe_key", `%${req}%`);
  for (const c of [...created].reverse()) await admin.from(c.table).delete().eq("id", c.id);
}, 60_000);

describe("§17.7–9 requirement evolution and change detection", () => {
  it("preserves the original, records what/when/source changed and whether the old value is obsolete", async () => {
    const ev = await getRequirementEvolution(ctx, req);
    expect(ev.original?.version).toBe(1);
    expect(ev.original?.snapshot.area_target_sf).toBe(10000);        // §17.8 previous requirement retrievable
    expect(ev.current?.snapshot.area_target_sf).toBe(15000);
    expect(ev.steps).toHaveLength(1);
    const s = ev.steps[0];
    expect(s.reason).toBe("Client call: headcount grew");
    expect(s.source.label).toMatch(/version 2/);
    const kinds = s.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["requirement_area_change", "requirement_budget_change", "requirement_location_change", "requirement_timeline_change"]);
    const area = s.changes.find((c) => c.kind === "requirement_area_change")!;
    expect(area.previousObsolete).toBe(true);                         // client-confirmed → old value obsolete
    expect(s.changes.find((c) => c.kind === "requirement_budget_change")!.previousObsolete).toBe(false); // not confirmed
    expect(s.changes.find((c) => c.kind === "requirement_location_change")!.text).toContain(`Kharadi ${T}`);
  });

  it("stores changes once, notifies the orchestrator and flags the affected opportunity (idempotent)", async () => {
    const r1 = await detectChanges(ctx, { requirementId: req });
    const kinds = r1.detected.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["requirement_area_change", "requirement_budget_change", "requirement_location_change", "decision_maker_change"]));
    expect(r1.inserted.length).toBeGreaterThanOrEqual(5);
    const area = r1.detected.find((c) => c.kind === "requirement_area_change")!;
    expect(area.affectedOpportunityIds).toContain(opp);
    expect(area.modules).toContain("deals");
    const ev = await admin.from("event_outbox").select("event_type, payload").eq("workspace_id", WS1).eq("dedupe_key", `memchange:${r1.inserted.find((x) => x.change.kind === "requirement_area_change")!.id}`);
    expect(ev.data?.[0]?.event_type).toBe("intelligence.change_detected");
    const marks = await admin.from("reassessment_mark").select("mark, entity_id").eq("workspace_id", WS1).eq("entity_id", opp).eq("cause_type", "memory_change");
    expect(marks.data?.length).toBeGreaterThan(0);
    const r2 = await detectChanges(ctx, { requirementId: req });
    expect(r2.inserted).toHaveLength(0);
    const rows = await listChanges(ctx, { entityType: "requirement", entityId: req });
    expect(rows.filter((c) => c.kind === "requirement_area_change")).toHaveLength(1);
    expect(rows[0].previous).not.toBeUndefined();
  });
});

describe("§17.16 decision-maker change + §6.3 impact", () => {
  it("identifies previous and new decision-maker, active opportunities, and does not assume authority", async () => {
    const rows = await listChanges(ctx, { entityType: "organisation", entityId: org, kinds: ["decision_maker_change"] });
    expect(rows).toHaveLength(1);
    const c = rows[0];
    expect((c.previous as Row).personId).toBe(pOld);
    expect((c.latest as Row).personId).toBe(pNew);
    expect(c.impact.activeOpportunities.map((o: Row) => o.id)).toContain(opp);
    expect(c.impact.opportunitiesNeedingReassessment.length).toBeGreaterThan(0);
    expect(c.impact.existingContacts.map((x: Row) => x.personId)).toEqual(expect.arrayContaining([pOld, pNew]));
    expect(c.impact.caveats.join(" ")).toMatch(/not copied/);
    const recs = await listRecommendations(ctx, { requirementId: req });
    expect(recs.some((r) => r.kind === "decision_maker_changed" && /buying group/.test(r.nextAction))).toBe(true);
  });
});

describe("§17.10–12, 18, 23 consolidation", () => {
  beforeAll(async () => {
    for (const [i, d] of [["1", "2026-07-01"], ["2", "2026-08-01"], ["3", "2026-09-01"]]) {
      await ins("capture_observation", { obs_key: `${T}:pref:${i}`, intent: "new_property_requirement", fact_class: "preference", field: "building_preference", raw_text: "Prefers Grade A buildings with immediate occupancy",
        value_json: "grade a, immediate occupancy", source_type: "typed_note", source_hash: `${T}-meeting-${i}`, content_hash: `${T}-c-pref`, observed_at: d, subject_type: "organisation", subject_id: org, status: "auto_saved" });
    }
    // the same note re-captured: a repeat of source 3, not independent
    await ins("capture_observation", { obs_key: `${T}:pref:dup`, intent: "new_property_requirement", fact_class: "preference", field: "building_preference", raw_text: "Prefers Grade A buildings with immediate occupancy",
      value_json: "grade a, immediate occupancy", source_type: "typed_note", source_hash: `${T}-meeting-3`, content_hash: `${T}-c-pref`, observed_at: "2026-09-01", subject_type: "organisation", subject_id: org, independent: false, status: "auto_saved" });
    await ins("capture_observation", { obs_key: `${T}:rent:1`, intent: "commercial_quotation", fact_class: "confirmed", field: "rent_psf", raw_text: "Rent quoted at 85 per sq ft", value_json: 85, source_type: "document", source_hash: `${T}-q1`, content_hash: `${T}-r85`, observed_at: "2026-09-10", subject_type: "organisation", subject_id: org });
    await ins("capture_observation", { obs_key: `${T}:rent:2`, intent: "commercial_quotation", fact_class: "confirmed", field: "rent_psf", raw_text: "Rent now 92 per sq ft", value_json: 92, source_type: "typed_note", source_hash: `${T}-q2`, content_hash: `${T}-r92`, observed_at: "2026-10-10", subject_type: "organisation", subject_id: org });
    await ins("capture_observation", { obs_key: `${T}:assume`, intent: "business_signal", fact_class: "assumption", field: "signal", raw_text: `Probably expanding ${T}`, source_type: "typed_note", source_hash: `${T}-a1`, content_hash: `${T}-a1`, observed_at: "2026-10-12", subject_type: "organisation", subject_id: org, status: "auto_saved" });
    for (const [d, subj, promises, objections] of [["2026-08-05T10:00:00Z", "Intro meeting", [{ what: "Send market comps", who: "us" }], ["Parking is limited"]], ["2026-09-05T10:00:00Z", "Site visit", [{ what: "send market comps", who: "us" }], ["Parking is limited"]]] as const) {
      const i = await ins("interaction", { occurred_at: d, channel: "meeting", subject: `${subj} ${T}`, summary: `${subj}: discussed options`, promises, objections });
      await ins("interaction_link", { interaction_id: i, entity_type: "organisation", entity_id: org });
    }
  }, 60_000);

  it("recurring preference from three meetings stays a preference, with originals and sources (§17.10/11)", async () => {
    const c = await consolidateEntity(ctx, { orgId: org });
    const pref = c.recurring.find((x) => x.kind === "preference")!;
    expect(pref).toBeTruthy();
    expect(pref.occurrences).toBe(4);
    expect(pref.independentSources).toBe(3);   // the re-captured note is not independent confirmation
    expect(pref.repeats).toBe(1);
    expect(pref.isConfirmedRequirement).toBe(false);
    expect(pref.status).toMatch(/not a confirmed requirement/);
    expect(pref.originals.every((o) => o.source.type)).toBe(true);
    const r = (await admin.from("requirement").select("constraints").eq("id", req).single()).data as Row;
    expect(JSON.stringify(r.constraints ?? {})).not.toMatch(/grade a/i);  // never written into the requirement
  });

  it("conflicting commercial information is identified with both values (§17.12)", async () => {
    const c = await consolidateEntity(ctx, { orgId: org });
    const k = c.conflicts.find((x) => x.field === "rent_psf")!;
    expect(k.values.map((v) => v.value)).toEqual(["Rent now 92 per sq ft", "Rent quoted at 85 per sq ft"]);
  });

  it("consolidates multiple meeting notes; AI summary is labelled (§17.18, §17.23)", async () => {
    const m = await consolidateMeetings(ctx, { orgId: org }, { ai: true });
    expect(m.meetings).toBeGreaterThanOrEqual(2);
    const comps = m.commitments.find((x) => /market comps/i.test(x.text))!;
    expect(comps.mentions).toBe(2);
    expect(m.objections.find((x) => /parking/i.test(x.text))!.mentions).toBe(2);
    expect(m.originals.length).toBe(m.meetings);
    expect(m.summary?.aiGenerated).toBe(false); // AI policy off (default): templated summary, labelled neutral
    expect(m.summary?.source).toBe("code");
    expect(m.summary?.text).toMatch(/meeting notes from/);
    const q = await qualityReport(ctx);
    const a = q.checks.find((x) => x.key === "assumptions")!;
    expect(a.error).toBeNull();
    expect(a.count).toBeGreaterThan(0);                                    // §17.23 assumptions flagged, not facts
  });
});

describe("§17.13 outdated quotations, §12 quality, §13 lifecycle", () => {
  it("flags the stale quotation in recommendations and the quality report", async () => {
    const recs = await listRecommendations(ctx, { requirementId: req, limit: 20 });
    const q = recs.find((r) => r.kind === "quotation_outdated")!;
    expect(q.title).toContain(`Tower ${T}`);
    expect(q.why).toMatch(/not current pricing/);
    expect(q.sourceRefs.length).toBeGreaterThan(0);
    const rep = await qualityReport(ctx);
    expect(rep.checks.find((c) => c.key === "stale_quotes")!.count).toBeGreaterThan(0);
    expect(rep.checks.map((c) => c.key)).toEqual(["outdated", "missing", "contradictory", "assumptions", "incomplete_history", "unverified_requirements", "stale_quotes", "outdated_employment", "no_source", "duplicates", "review"]);
  });

  it("manual correction is appended with audit history; previous status kept", async () => {
    await correctMemoryStatus(ctx, { entityType: "person", entityId: pOld, category: "employment", itemKey: `employment:${pOld}`, status: "historical", note: "Left in August" });
    await correctMemoryStatus(ctx, { entityType: "person", entityId: pOld, category: "employment", itemKey: `employment:${pOld}`, status: "superseded", note: "Replaced" });
    const list = await listCorrections(ctx, "person", pOld);
    expect(list.map((x) => x.status)).toEqual(["superseded", "historical"]);
    expect(list[0].previous_status).toBe("historical");
    const audit = await admin.from("audit_event").select("action").eq("workspace_id", WS1).eq("entity_type", "memory_lifecycle").in("entity_id", list.map((x) => x.id));
    expect(audit.data?.length).toBe(2);
    await expect(correctMemoryStatus(ctx, { entityType: "person", entityId: pOld, category: "x", itemKey: "k", status: "current", note: " " })).rejects.toThrow(/why/);
  });

  it("memory rows are not visible across workspaces", async () => {
    const other = await userClient("other");
    const { data } = await other.from("memory_change").select("id").eq("workspace_id", WS1).in("entity_id", [req, org]);
    expect(data ?? []).toHaveLength(0);
    expect(await listChanges({ db: other, workspaceId: WS2, userId: USERS.other.id }, { entityType: "requirement", entityId: req })).toHaveLength(0);
  });
});

describe("§17.19 Module 12 contextual questions (source-linked, unknown stated)", () => {
  it("has their requirement changed / which properties were rejected and why", async () => {
    const mv = await ins("meeting_visit", { title: `Site visit ${T}`, start_at: "2026-10-20T05:00:00Z", end_at: "2026-10-20T06:00:00Z", kind: "site_visit", status: "completed", provider: "manual", linked_entity_type: "organisation", linked_entity_id: org });
    const prep = await ins("meeting_prep", { meeting_visit_id: mv, org_id: org, requirement_id: req, meeting_type: "site_visit", status: "preparation_pending" });
    await ins("meeting_property_feedback", { prep_id: prep, asset_id: asset, fields: { interest: "rejected", explicit_rejection: true, parking: "Only 20 car parks" } });
    const rej = await loadRejections(ctx, { requirementId: req });
    expect(rej[0].explicit).toBe(true);
    expect(rej[0].reasons.join(" ")).toMatch(/Parking: Only 20 car parks/);
    const r = await run("get_requirement_history", { companyId: org });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/Changed 1 time/);
    expect(r.summary).toMatch(/Rejected by the client: Tower/);
    expect(r.summary).toMatch(/Recurring preferences \(not confirmed requirements\)/);
    expect(r.sources?.length).toBeGreaterThan(0);
  });
  it("what did we last discuss / who is the decision-maker — with sources; unknown stated", async () => {
    const c = await run("get_company_context", { companyId: org });
    expect(c.ok).toBe(true);
    expect(c.summary).toMatch(/Last discussion 2026-09-05/);
    expect(c.summary).toMatch(/New Approver/);
    expect(c.summary).not.toMatch(/Old Approver.*approver/);
    expect(c.sources?.some((s) => /meeting 2026-09-05/.test(s.label))).toBe(true);
    const empty = await run("get_company_context", { companyId: org2 });
    expect(empty.summary).toMatch(/No recorded discussion/);
    expect(empty.summary).toMatch(/Decision-maker: unknown/);
    const p = await run("get_person_context", { personId: pNew });
    expect(p.ok).toBe(true);
    expect(p.summary).toMatch(/Spoken before: no recorded interaction/);
    const w = await run("what_changed", { entityType: "requirement", entityId: req });
    expect(w.summary).toMatch(/sq ft/);
    const s = await run("find_similar_requirements", { requirementId: req });
    expect(s.ok).toBe(true);
  });
  it("records of another workspace are refused", async () => {
    const foreign = await ins("organisation", { display_name: `Foreign ${T}` }, WS2);
    const r = await run("get_company_context", { companyId: foreign });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_found_or_no_access");
  });
});

describe("§17.24 new information triggers contextual reassessment", () => {
  it("a requirement update emits commercial.requirement_changed; the memory consumer records the change", async () => {
    expect(CONSUMERS["commercial.requirement_changed"]?.memory).toBe(reassessMemory);
    const snap = (await admin.from("requirement_version").select("snapshot").eq("requirement_id", req).eq("version", 2).single()).data!.snapshot;
    await ins("requirement_version", { requirement_id: req, version: 3, snapshot: { ...snap, area_target_sf: 20000 }, field_status: {}, change_reason: "Reported by broker" });
    const up = await admin.from("requirement").update({ area_target_sf: 20000 }).eq("id", req);
    expect(up.error).toBeNull();
    const { data: ev } = await admin.from("event_outbox").select("*").eq("workspace_id", WS1).eq("event_type", "commercial.requirement_changed").eq("subject_id", req).order("occurred_at", { ascending: false }).limit(1);
    expect(ev?.length).toBe(1);
    const res = await reassessMemory(admin, WS1, ev![0]);
    expect(res.status).toBe("done");
    expect(res.detail).toMatch(/[1-9]\d* new/);
    const rows = await listChanges(ctx, { entityType: "requirement", entityId: req, kinds: ["requirement_area_change"] });
    const latest = rows.find((r) => (r.latest as Row).area_target_sf === 20000)!;
    expect(latest.verification).toBe("unknown");                     // not client-confirmed → not presented as verified
    expect((latest.previous as Row).area_target_sf).toBe(15000);
    const again = await reassessMemory(admin, WS1, ev![0]);
    expect(again.detail).toMatch(/ 0 new/);
  });
});
