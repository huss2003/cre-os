import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminClient, userClient, USERS, tag } from "../../../tests/helpers";
import { runSupervisor, reconcileAlerts } from "./supervisor";
import { acknowledgeAlert, getHealth } from "./health";

// Private throwaway workspace so alerts/notifications never touch other modules' fixtures.
describe("System Supervisor alerts (workflow 22)", () => {
  const admin = adminClient();
  let ws = "";
  const prevTick = new Date(Date.UTC(2031, 0, 1, 0, Math.floor(Math.random() * 1000))).toISOString();
  beforeAll(async () => {
    const slug = tag("sup").toLowerCase();
    const { data, error } = await admin.from("workspace").insert({ name: `Supervisor ${slug}`, slug }).select().single();
    if (error) throw error;
    ws = data.id;
    // 30 h old, so "no successful backup in 26 h" applies
    await admin.from("workspace").update({ created_at: new Date(Date.now() - 30 * 3_600_000).toISOString() }).eq("id", ws);
    await admin.from("membership").insert({ workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true });
  });
  afterAll(async () => {
    if (!ws) return;
    for (const t of ["outbox", "supervisor_alert", "job", "model_usage", "connector_cursor", "connector_account", "backup_run", "membership"]) {
      await admin.from(t).delete().eq("workspace_id", ws);
    }
    await admin.from("workspace").delete().eq("id", ws);
  });

  const alerts = async () => (await admin.from("supervisor_alert").select("*").eq("workspace_id", ws).order("opened_at")).data ?? [];
  const outbox = async () => (await admin.from("outbox").select("user_id, kind, payload, dedupe_key").eq("workspace_id", ws)).data ?? [];
  const run = () => runSupervisor(admin, { workspaceIds: [ws], heartbeat: { gapMinutes: 42, prevStartedAt: prevTick } });

  it("raises deduplicated private alerts for dead jobs, missed/failed backups, AI budget 80%, failed connectors and a scheduler gap", async () => {
    const { data: job } = await admin.from("job").insert({ workspace_id: ws, job_type: "integrations.sync", state: "dead", attempts: 5, last_error: "SECRET-TRACE token=abc" }).select().single();
    await admin.from("backup_run").insert({ workspace_id: ws, kind: "logical_export", status: "failed", error: "SECRET-TRACE" });
    await admin.from("model_usage").insert({ workspace_id: ws, workflow: "admin.test", model: "test", pricing_version: "test", estimated_usd: 28.5 }); // ~85% of ₹3,000 at ₹90/USD
    const { data: acc } = await admin.from("connector_account").insert({ workspace_id: ws, user_id: USERS.owner.id, provider: "google", status: "error", last_error: "SECRET-TRACE" }).select().single();

    const s1 = await run();
    expect(s1.checkErrors).toEqual([]);
    const open = await alerts();
    expect(open.map((a) => a.kind).sort()).toEqual(["ai_budget_80", "backup_failed", "backup_missed", "connector_failed", "dead_job", "scheduler_gap"]);
    expect(open.find((a) => a.kind === "dead_job")?.subject).toBe(job.id);
    expect(open.find((a) => a.kind === "connector_failed")?.subject).toBe(acc.id);
    expect(open.every((a) => a.notified_at)).toBe(true);

    // private in-app notifications to owners/admins only, shown on /today (urgent_alert / brief_alert), no sensitive logs
    const ob = await outbox();
    expect(ob).toHaveLength(6);
    expect(new Set(ob.map((o) => o.user_id))).toEqual(new Set([USERS.owner.id]));
    expect(ob.find((o) => o.payload.alert_kind === "ai_budget_80")?.kind).toBe("brief_alert");
    expect(ob.filter((o) => o.kind === "urgent_alert")).toHaveLength(5);
    expect(JSON.stringify(ob)).not.toContain("SECRET-TRACE");
    expect(JSON.stringify(open)).not.toContain("SECRET-TRACE");
    const owner = await userClient("owner");
    const { data: mine } = await owner.from("outbox").select("kind, payload").eq("workspace_id", ws).in("kind", ["urgent_alert", "brief_alert"]);
    expect(mine?.length).toBe(6);
    expect(mine?.every((m) => typeof m.payload.title === "string" && m.payload.title.length > 10)).toBe(true);

    // deduplicated: the same conditions on the next tick open nothing and notify nobody
    const s2 = await run();
    expect(s2).toMatchObject({ opened: 0, notifications: 0 });
    expect(await outbox()).toHaveLength(6);
    expect((await alerts()).length).toBe(6);
  });

  it("resolves alerts when the condition clears, never when the check did not run; budget 100% supersedes 80%", async () => {
    await admin.from("connector_account").update({ status: "connected" }).eq("workspace_id", ws);
    await admin.from("job").update({ state: "succeeded" }).eq("workspace_id", ws).eq("state", "dead");
    // a pass where no check ran (e.g. every query failed) must not mark anything healthy
    await reconcileAlerts(admin, ws, [], []);
    expect((await alerts()).filter((a) => !a.resolved_at).map((a) => a.kind).sort()).toEqual(
      ["ai_budget_80", "backup_failed", "backup_missed", "connector_failed", "dead_job"]);

    await admin.from("model_usage").insert({ workspace_id: ws, workflow: "admin.test", model: "test", pricing_version: "test", estimated_usd: 10 });
    const s = await runSupervisor(admin, { workspaceIds: [ws] });
    expect(s.checkErrors).toEqual([]);
    const all = await alerts();
    const openKinds = all.filter((a) => !a.resolved_at).map((a) => a.kind).sort();
    expect(openKinds).toEqual(["ai_budget_100", "backup_failed", "backup_missed"]);
    expect(all.find((a) => a.kind === "connector_failed")?.resolved_at).toBeTruthy();
    expect(all.find((a) => a.kind === "dead_job")?.resolved_at).toBeTruthy();
    expect((await outbox()).some((o) => o.payload.alert_kind === "ai_budget_100" && o.kind === "urgent_alert")).toBe(true);
  });

  it("owner can acknowledge (no further notifications); /admin health shows alerts, heartbeat, latency and pause state", async () => {
    const owner = await userClient("owner");
    const budget = (await alerts()).find((a) => a.kind === "ai_budget_100" && !a.resolved_at)!;
    await acknowledgeAlert(owner, ws, budget.id, USERS.owner.id);
    expect((await alerts()).find((a) => a.id === budget.id)?.acknowledged_at).toBeTruthy();
    const colleague = await userClient("colleague"); // not a member of this workspace
    await expect(acknowledgeAlert(colleague, ws, budget.id, USERS.colleague.id)).rejects.toThrow(/not found/);

    const h = await getHealth(owner, ws);
    expect(h.alerts.checked).toBe(true);
    expect(h.alerts.open.map((a) => a.kind).sort()).toEqual(["ai_budget_100", "backup_failed", "backup_missed"]);
    expect(h.alerts.recent.length).toBeGreaterThanOrEqual(3); // resolved + the scheduler-gap event
    expect(h.scheduler.checked).toBe(true);
    expect(typeof h.scheduler.stale).toBe("boolean");
    expect(h.jobs.latency.checked).toBe(true);
    expect(h.jobs.paused).toMatchObject({ checked: true, workspacePaused: false });
    expect(h.connectors.every((c) => c.healthy)).toBe(true);
    expect(h.spend.budgetExceeded).toBe(true);
  });
});
