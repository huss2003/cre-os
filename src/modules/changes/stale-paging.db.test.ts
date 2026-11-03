/**
 * Regression (real-data e2e: 1,231 imported Pune companies): the stale-record detector read the candidate RPC in one
 * response, which PostgREST caps at max_rows = 1000 — records beyond 1000 were never flagged (and could be marked fresh).
 * ISOLATED throwaway workspace (deleted afterwards).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, USERS } from "../../../tests/helpers";
import { runStaleDetector } from "./steward";

const admin = adminClient();
const N = 1050;
let ws = "";

beforeAll(async () => {
  const slug = tag("stale-paging");
  const { data, error } = await admin.from("workspace").insert({ name: `Stale paging ${slug}`, slug }).select("id").single();
  if (error) throw error;
  ws = data!.id;
  const rows = Array.from({ length: N }, (_, i) => ({ workspace_id: ws, owner_user_id: USERS.owner.id, display_name: `Imported Co ${String(i).padStart(4, "0")}` }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await admin.from("organisation").insert(rows.slice(i, i + 500));
    if (e) throw e;
  }
}, 60_000);

afterAll(async () => {
  if (ws) await admin.from("workspace").delete().eq("id", ws);
});

describe("stale-record detector paging", () => {
  it("flags all 1,050 stale companies (not 1,000) and refreshes all of them once fresh again", async () => {
    const later = new Date(Date.now() + 200 * 86_400_000); // org window 180 days
    const r = await runStaleDetector(admin, ws, { now: later, maxTasks: 0 });
    expect(r.stale).toBe(N);
    const { count } = await admin.from("record_freshness").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "stale");
    expect(count).toBe(N);
    const back = await runStaleDetector(admin, ws, { maxTasks: 0 });
    expect(back).toMatchObject({ stale: 0, refreshed: N });
  }, 60_000);
});
