/**
 * 07:00 recalculation in an ISOLATED throwaway workspace (deleted afterwards, cascade): lead scores written with
 * is_current history, radar enrichment/notice tasks raised idempotently, daily plan selects the deadline account first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, USERS } from "../../../../tests/helpers";
import { loadMemberAccess, loadSettings } from "../db";
import { runRecalc } from "../jobs";
import { buildDailyPlan } from "../plan";

const admin = adminClient();
const OWN = USERS.owner.id;
const DATE = "2031-03-03"; // Monday
let ws = "";
const ids: Record<string, string> = {};

async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert({ workspace_id: ws, owner_user_id: OWN, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data!.id as string;
}

beforeAll(async () => {
  const slug = tag("brief-recalc");
  const { data, error } = await admin.from("workspace").insert({ name: `Brief recalc ${slug}`, slug }).select("id").single();
  if (error) throw error;
  ws = data!.id;
  const { error: me } = await admin.from("membership").insert({ workspace_id: ws, user_id: OWN, role: "owner", see_all_accounts: true, allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] });
  if (me) throw me;
  ids.deadline = await ins("organisation", { display_name: "Deadline Co" });
  ids.confirmed = await ins("organisation", { display_name: "Confirmed Co" });
  ids.unknown = await ins("organisation", { display_name: "Unknown Dates Co" });
  ids.dnc = await ins("organisation", { display_name: "Do Not Call Co", contact_restrictions: "Do not contact — legal" });
  const l1 = await ins("lease", { tenant_org_id: ids.deadline, area_sf: 15000, contractual_expiry: "2031-09-30" });
  await ins("lease_event", { lease_id: l1, event_type: "notice_deadline", event_date: "2031-04-15", date_basis: "contractual" });
  ids.lease2 = await ins("lease", { tenant_org_id: ids.unknown, area_sf: 8000, start_date: "2029-01-01", tenure_months_raw: 35.5 });
  await ins("lease", { tenant_org_id: ids.dnc, area_sf: 30000, contractual_expiry: "2031-05-31" });
  await ins("requirement", { org_id: ids.confirmed, title: "HQ move", status: "client_confirmed", area_target_sf: 25000, preferred_geography_ids: [crypto.randomUUID()], decision_date: "2031-07-31", budget_max: 5000000, confirmed_at: "2031-02-20T00:00:00Z" });
});

afterAll(async () => {
  if (ws) await admin.from("workspace").delete().eq("id", ws);
});

describe("brief.recalc + plan (isolated workspace)", () => {
  it("scores every account with evidence, applies overrides, raises idempotent radar tasks", async () => {
    const r1 = await runRecalc(admin as never, ws, DATE);
    expect(r1).toMatchObject({ leases: 3, scored: 4, written: 4, unchanged: 0 });
    const { data: scores } = await admin.from("lead_score").select("subject_id, total, tier, overrides, is_current").eq("workspace_id", ws).eq("is_current", true);
    const by = Object.fromEntries((scores ?? []).map((s: any) => [s.subject_id, s]));
    expect(by[ids.deadline]).toMatchObject({ tier: "act_this_week" });
    expect(by[ids.deadline].overrides).toContain("deadline_within_90d");
    expect(by[ids.dnc]).toMatchObject({ tier: "suppressed" });
    expect(Number(by[ids.dnc].total)).toBe(0);
    expect(Number(by[ids.confirmed].total)).toBeGreaterThanOrEqual(60); // timing 20 + fit 15 + trigger 20 + budget 5

    const { data: tasks } = await admin.from("task").select("title, idempotency_key, priority").eq("workspace_id", ws);
    const keys = (tasks ?? []).map((t: any) => t.idempotency_key);
    expect(keys).toContain(`brief.radar:${ids.lease2}:fractional_tenure`);
    expect((tasks ?? []).some((t: any) => /Notice deadline 2031-04-15 — Deadline Co/.test(t.title) && t.priority === 90)).toBe(true);

    const r2 = await runRecalc(admin as never, ws, DATE);
    expect(r2).toMatchObject({ written: 0, unchanged: 4 });
    expect((r2 as any).tasks.created).toBe(0);
    const { count } = await admin.from("lead_score").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(count).toBe(4); // no history rows when nothing changed
  });

  it("daily plan puts the deadline account first and never selects suppressed accounts", async () => {
    const access = await loadMemberAccess(admin as never, ws, OWN);
    const settings = await loadSettings(admin as never, ws, OWN);
    const plan = await buildDailyPlan({ db: admin as never, workspaceId: ws, userId: OWN, tz: "Asia/Kolkata", access }, settings, DATE);
    expect(plan.persisted).toBe(true);
    expect(plan.mode).toBe("workday");
    expect(plan.targets[0]).toMatchObject({ orgId: ids.deadline, slot: "deadline" });
    expect(plan.targets.some((t) => t.orgId === ids.dnc)).toBe(false);
    expect(plan.targets[0].components.find((c) => c.key === "timing")!.points).toBe(25);
    const again = await buildDailyPlan({ db: admin as never, workspaceId: ws, userId: OWN, tz: "Asia/Kolkata", access }, settings, DATE);
    expect(again.id).toBe(plan.id); // same input version => same row
  });
});
