/**
 * Regression (real-data e2e, Pune lease files: 990 leases / 752 radar task candidates): existing-task lookups by long
 * idempotency keys were sent 200 at a time in one URL => HTTP 414, error ignored => every run re-selected the SAME
 * capped batch, so deferred radar tasks were never raised. ISOLATED throwaway workspace (deleted afterwards).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, tag, USERS } from "../../../../tests/helpers";
import { loadSettings } from "../db";
import { chunkKeys, rowsByKeys, KEY_URL_BUDGET } from "../keys";
import { ENRICHMENT_TASKS_PER_RUN, loadRadar, raiseRadarTasks } from "../radar-data";

const admin = adminClient();
const OWN = USERS.owner.id;
const DATE = "2031-03-03";
const N = 260;
let ws = "";

beforeAll(async () => {
  const slug = tag("radar-keys");
  const { data, error } = await admin.from("workspace").insert({ name: `Radar keys ${slug}`, slug }).select("id").single();
  if (error) throw error;
  ws = data!.id;
  const { error: me } = await admin.from("membership").insert({ workspace_id: ws, user_id: OWN, role: "owner", see_all_accounts: true, allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] });
  if (me) throw me;
  // fractional tenure => one enrichment task candidate per lease (capped per run)
  const rows = Array.from({ length: N }, (_, i) => ({ workspace_id: ws, owner_user_id: OWN, tenant_name_raw: `Tenant ${i}`, area_sf: 5000 + i, start_date: "2029-01-01", start_precision: "day", tenure_months_raw: 35.5 }));
  const { error: le } = await admin.from("lease").insert(rows);
  if (le) throw le;
});

afterAll(async () => {
  if (ws) await admin.from("workspace").delete().eq("id", ws);
});

describe("radar task keys (long idempotency keys)", () => {
  it("chunkKeys keeps every request under the URL budget and loses no key", () => {
    const keys = Array.from({ length: 700 }, (_, i) => `brief.radar:${crypto.randomUUID()}:plan:options_start:${i}`);
    const parts = chunkKeys(keys);
    expect(parts.flat()).toEqual(keys);
    for (const p of parts) expect(p.map((k) => encodeURIComponent(`"${k}"`).length + 3).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(KEY_URL_BUDGET);
    expect(chunkKeys(["x".repeat(KEY_URL_BUDGET * 2)])).toHaveLength(1); // an oversize key still gets its own chunk
  });

  it("a second run raises the NEXT batch of deferred tasks (no repeats, no duplicates) and lookups never fail silently", async () => {
    const settings = await loadSettings(admin, ws, null);
    const load = await loadRadar(admin, ws, DATE, settings);
    expect(load.items).toHaveLength(N);
    const r1 = await raiseRadarTasks(admin, ws, load, DATE, OWN);
    expect(r1.created).toBe(ENRICHMENT_TASKS_PER_RUN);
    const r2 = await raiseRadarTasks(admin, ws, load, DATE, OWN);
    expect(r2.created).toBe(ENRICHMENT_TASKS_PER_RUN);
    const { count } = await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", ws);
    expect(count).toBe(2 * ENRICHMENT_TASKS_PER_RUN); // before the fix: 25 (run 2 re-selected run 1's tasks)
    expect(r2.deferred).toBe(N - 2 * ENRICHMENT_TASKS_PER_RUN);

    const { data: keys } = await admin.from("task").select("idempotency_key").eq("workspace_id", ws);
    const all = [...(keys ?? []).map((k: { idempotency_key: string }) => k.idempotency_key), ...load.items.map((i) => `brief.radar:${i.leaseId}:fractional_tenure`)];
    const found = await rowsByKeys<{ idempotency_key: string }>(admin, "task", ws, "idempotency_key", all, "idempotency_key");
    expect(found).toHaveLength(2 * ENRICHMENT_TASKS_PER_RUN);
  });
});
