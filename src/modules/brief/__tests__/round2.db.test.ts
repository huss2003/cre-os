/**
 * Round 2 DB acceptance (isolated throwaway workspace, deleted afterwards):
 *  07 — task done requires evidence at DB level; events (reply, task change, approved change) enqueue a debounced
 *       re-plan; re-plan shows blocked dependencies; 48 h deadline watch alerts once.
 *  10 — calculated radar dates persisted as distinct calculated lease_event rows, reproducibly; lease changes enqueue
 *       the radar job; review + reverse-plan tasks raised and moved (not duplicated) when dates change.
 *  18 — overdue promise → alert + task linked to the interaction, promise never auto-closed; opt-outs suppress.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, USERS } from "../../../../tests/helpers";
import { runCaretaker } from "../caretaker-data";
import { runDeadlineWatch, runRadarRefresh, runReplan } from "../jobs";

const admin = adminClient();
const OWN = USERS.owner.id;
let ws = "";
const today = new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert({ workspace_id: ws, owner_user_id: OWN, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data!.id as string;
}
async function jobs(type: string) {
  const { data } = await admin.from("job").select("id, dedupe_key, state, payload").eq("workspace_id", ws).eq("job_type", type);
  return data ?? [];
}

beforeAll(async () => {
  const slug = tag("brief-r2");
  const { data, error } = await admin.from("workspace").insert({ name: `Brief r2 ${slug}`, slug, timezone: "Asia/Kolkata" }).select("id").single();
  if (error) throw error;
  ws = data!.id;
  const { error: me } = await admin.from("membership").insert({ workspace_id: ws, user_id: OWN, role: "owner", see_all_accounts: true, allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] });
  if (me) throw me;
});

afterAll(async () => {
  if (ws) {
    await admin.from("job").delete().eq("workspace_id", ws);
    await admin.from("workspace").delete().eq("id", ws);
  }
});

describe("07 Priority Adviser (DB)", () => {
  it("never marks a task complete without evidence (DB guard, even for the service role)", async () => {
    const id = await ins("task", { title: "Guarded", status: "open" });
    const { error } = await admin.from("task").update({ status: "done" }).eq("id", id);
    expect(error?.message).toMatch(/completion_evidence_required/);
    const { error: e2 } = await admin.from("task").insert({ workspace_id: ws, title: "Born done", status: "done" });
    expect(e2?.message).toMatch(/completion_evidence_required/);
    const { error: ok } = await admin.from("task").update({ status: "done", completion_evidence: "Called, confirmed by email", completed_at: new Date().toISOString() }).eq("id", id);
    expect(ok).toBeNull();
  });

  it("event-driven re-planning: new reply, task state/due change and approved change enqueue ONE debounced brief.replan per window", async () => {
    await admin.from("job").delete().eq("workspace_id", ws).eq("job_type", "brief.replan");
    await ins("interaction", { occurred_at: new Date().toISOString(), channel: "email", direction: "inbound", subject: "Re: options", is_meaningful: true });
    const t = await ins("task", { title: "Re-plan me", status: "open" });
    await admin.from("task").update({ due_at: new Date(Date.now() + 3_600_000).toISOString() }).eq("id", t);
    const cp = await ins("change_proposal", { target_type: "organisation", operation: "create", patch: {}, state: "proposed", proposed_by_kind: "user", risk: "low" }).catch(() => null);
    if (cp) await admin.from("change_proposal").update({ state: "approved" }).eq("id", cp);
    const js = await jobs("brief.replan");
    expect(js.length).toBeGreaterThanOrEqual(1);
    expect(js.length).toBeLessThanOrEqual(2); // a burst coalesces (at most a window boundary splits it)
    expect(js[0].dedupe_key).toMatch(new RegExp(`^brief\\.replan:${ws}:\\d+$`));
  });

  it("re-plan builds the day order with blocked dependencies shown as blocked (never doable)", async () => {
    const dep = await ins("task", { title: "Finance comparison", status: "open", assigned_user_id: OWN });
    await ins("task", { title: "Send final proposal", status: "open", depends_on: dep, assigned_user_id: OWN, due_at: new Date(Date.now() + 2 * 3_600_000).toISOString() });
    const r: any = await runReplan(admin as never, ws, "test");
    if (r.plans.length === 0) return; // non-workday without weekend brief
    const { data: plan } = await admin.from("daily_plan").select("agenda, trigger_reason").eq("id", r.plans[0].planId).single();
    expect(plan!.trigger_reason).toBe("test");
    const blocked = (plan!.agenda as any).blocked;
    expect(blocked.some((b: any) => b.title === "Send final proposal" && /Finance comparison/.test(b.waitsOn))).toBe(true);
    expect((plan!.agenda as any).timeline.some((t: any) => t.title === "Send final proposal")).toBe(false);
  });

  it("deadline entering 48 h: one private alert per item and a re-plan", async () => {
    const t = await ins("task", { title: "Submit LOI comments", status: "open", assigned_user_id: OWN, due_at: new Date(Date.now() + 20 * 3_600_000).toISOString() });
    const a: any = await runDeadlineWatch(admin as never, ws);
    expect(a.entered).toBeGreaterThanOrEqual(1);
    const b: any = await runDeadlineWatch(admin as never, ws);
    expect(b.entered).toBe(0);
    const { data } = await admin.from("outbox").select("dedupe_key").eq("workspace_id", ws).eq("kind", "deadline_48h").like("dedupe_key", `deadline48:task:${t}:%`);
    expect(data).toHaveLength(1);
  });
});

describe("10 Lease Radar (DB)", () => {
  let lease = "";
  it("lease and lease_event changes enqueue the radar job (trigger → job)", async () => {
    await admin.from("job").delete().eq("workspace_id", ws).eq("job_type", "brief.radar");
    const org = await ins("organisation", { display_name: "Radar Tenant" });
    lease = await ins("lease", { tenant_org_id: org, area_sf: 12000, start_date: "2027-01-01", tenure_months_raw: 60, lockin_months_raw: 36 });
    expect((await jobs("brief.radar")).length).toBeGreaterThanOrEqual(1);
  });

  it("persists calculated dates as distinct calculated lease_event rows; re-runs are reproducible (no duplicates)", async () => {
    await ins("lease_event", { lease_id: lease, event_type: "break", event_date: "2030-01-01", date_basis: "reported", needs_review: true, review_reason: "Break wording ambiguous" });
    const r1: any = await runRadarRefresh(admin as never, ws, today);
    expect(r1.result.events.inserted).toBe(2); // expiry + lock-in (calculated)
    const { data: rows } = await admin.from("lease_event").select("event_type, event_date, date_basis, confirmed, calc_key, formula_raw, calc_inputs").eq("workspace_id", ws).not("calc_key", "is", null).is("archived_at", null);
    expect(rows!.map((x: any) => x.event_type).sort()).toEqual(["expiry", "lockin_end"]);
    expect(rows!.every((x: any) => x.date_basis === "calculated_by_radar" && x.confirmed === false && x.formula_raw && x.calc_inputs.lease_id === lease)).toBe(true);
    expect(rows!.find((x: any) => x.event_type === "expiry")?.event_date).toBe("2032-01-01");
    const r2: any = await runRadarRefresh(admin as never, ws, today);
    expect(r2.result.events).toMatchObject({ inserted: 0, updated: 0, archived: 0, unchanged: 2 });
    // a calculated row can never be "confirmed"
    const { error } = await admin.from("lease_event").update({ confirmed: true }).eq("workspace_id", ws).eq("calc_key", `radar:${lease}:expiry`);
    expect(error?.message).toMatch(/calculated lease events/);
    // review task for the ambiguous clause
    const { data: tasks } = await admin.from("task").select("idempotency_key, title").eq("workspace_id", ws).like("idempotency_key", `brief.radar:${lease}:review:%`);
    expect(tasks).toHaveLength(1);
    expect(tasks![0].title).toMatch(/Review lease clause/);
  });

  it("reverse-plan milestone tasks are created with due dates and moved (not duplicated) when the lease changes", async () => {
    const org = await ins("organisation", { display_name: "Plan Tenant" });
    const l = await ins("lease", { tenant_org_id: org, area_sf: 8000, contractual_expiry: plusDays(160) });
    await runRadarRefresh(admin as never, ws, today);
    const { data: t1 } = await admin.from("task").select("id, idempotency_key, due_at").eq("workspace_id", ws).like("idempotency_key", `brief.radar:${l}:plan:%`);
    expect(t1!.length).toBeGreaterThanOrEqual(1);
    expect(t1!.every((t: any) => !!t.due_at)).toBe(true);
    await admin.from("lease").update({ contractual_expiry: plusDays(170) }).eq("id", l);
    const r: any = await runRadarRefresh(admin as never, ws, today);
    expect(r.result.tasks.moved).toBeGreaterThanOrEqual(1);
    const { data: t2 } = await admin.from("task").select("id, idempotency_key, due_at").eq("workspace_id", ws).like("idempotency_key", `brief.radar:${l}:plan:%`);
    const k1 = new Set(t1!.map((t: any) => t.idempotency_key));
    expect(t2!.filter((t: any) => k1.has(t.idempotency_key)).length).toBe(t1!.length); // same tasks, no duplicates
    expect(t2!.some((t: any) => t1!.find((o: any) => o.id === t.id && o.due_at !== t.due_at))).toBe(true);
  });
});

describe("18 Relationship Caretaker (DB)", () => {
  it("overdue promise → deduped alert + task linked to the interaction; the promise is never auto-completed", async () => {
    const person = await ins("person", { full_name: "Ravi Client" });
    const promises = [{ who: "me", what: "Send floor plans", due: plusDays(-3), status: "open" }];
    const i = await ins("interaction", { occurred_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), channel: "call", direction: "outbound", subject: "Call", promises });
    await ins("interaction_link", { interaction_id: i, entity_type: "person", entity_id: person });
    const r1 = await runCaretaker(admin as never, ws, today, [], OWN);
    expect(r1.tasks).toBeGreaterThanOrEqual(1);
    const { data: tasks } = await admin.from("task").select("id, title, linked_entity_type, linked_entity_id, row_version").eq("workspace_id", ws).like("idempotency_key", `brief.caretaker:promise:${i}:%`);
    expect(tasks).toHaveLength(1);
    expect(tasks![0]).toMatchObject({ linked_entity_type: "interaction", linked_entity_id: i, title: "Deliver: Send floor plans" });
    await runCaretaker(admin as never, ws, today, [], OWN);
    const { count } = await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", ws).like("idempotency_key", `brief.caretaker:promise:${i}:%`);
    expect(count).toBe(1);
    const { data: alerts } = await admin.from("outbox").select("id").eq("workspace_id", ws).eq("kind", "promise_overdue").like("dedupe_key", `caretaker:promise:${i}:%`);
    expect(alerts).toHaveLength(1);
    // completing the follow-up task (with evidence) does not silently close the promise
    await admin.from("task").update({ status: "done", completion_evidence: "Sent by email", completed_at: new Date().toISOString() }).eq("id", tasks![0].id);
    const { data: after } = await admin.from("interaction").select("promises").eq("id", i).single();
    expect(after!.promises).toEqual(promises);
  });

  it("opt-outs suppress suggestions: a suppressed person gets no follow-up task or alert", async () => {
    const person = await ins("person", { full_name: "Opted Out" });
    await ins("consent_permission", { person_id: person, purpose: "outreach", suppressed: true, revoked_at: new Date().toISOString() });
    const i = await ins("interaction", { occurred_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), channel: "email", direction: "outbound", subject: "Mail", promises: [{ who: "me", what: "Send brochure", due: plusDays(-2) }] });
    await ins("interaction_link", { interaction_id: i, entity_type: "person", entity_id: person });
    const r = await runCaretaker(admin as never, ws, today, [], OWN);
    expect(r.withheld).toBeGreaterThanOrEqual(1);
    const { count } = await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", ws).like("idempotency_key", `brief.caretaker:promise:${i}:%`);
    expect(count).toBe(0);
    const { count: a } = await admin.from("outbox").select("id", { count: "exact", head: true }).eq("workspace_id", ws).like("dedupe_key", `caretaker:promise:${i}:%`);
    expect(a).toBe(0);
  });
});
