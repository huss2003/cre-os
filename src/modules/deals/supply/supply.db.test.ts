/** Module 14 — DB integration (WS1, tagged fixtures, RLS as signed-in users). */
/* Fixture spaces use a unique area (3137 SF) so the shared WS1 inventory never crowds them out of the stored top-200,
 * and they are archived afterwards so other suites' WS1 shortlists never pick up the deliberately stale fixture. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, WS2, tag, userClient } from "../../../../tests/helpers";
import { DealsError, type DealsCtx } from "../ctx";
import { createRequirement } from "../requirements/service";
import { runShortlist } from "../matching/service";
import {
  assertReadyToPresent, availabilityStatusForSpace, findAlternatives, matchRequirement, operatorCentres, reconfirmationDue,
  recordShortlistFeedback, shortlistHistory, upsertOperatorCentre,
} from "./service";

let owner: DealsCtx, other: DealsCtx;
const AS_OF = "2026-11-12";
const t = tag("m14");
const ids: { reqId?: string; good?: string; occupied?: string; stale?: string; leaseOnly?: string } = {};

const created: { table: string; id: string }[] = [];
afterAll(async () => {
  for (const c of created.reverse()) await owner.db.from(c.table).update({ archived_at: new Date().toISOString() }).eq("workspace_id", WS1).eq("id", c.id);
});
async function building(name: string, category: string | null, specs: Record<string, unknown>) {
  const a = await owner.db.from("asset").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_kind: "building", name, category, status: "ready", specs }).select("id").single();
  if (a.error) throw a.error;
  created.push({ table: "asset", id: a.data.id });
  return a.data.id as string;
}
async function space(assetId: string, floor: string, avRow: Record<string, unknown> | null) {
  const s = await owner.db.from("space").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: assetId, floor_text: floor, chargeable_sf: 3137 }).select("id").single();
  if (s.error) throw s.error;
  created.push({ table: "space", id: s.data.id });
  if (avRow) {
    const r = await owner.db.from("availability").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, space_id: s.data.id, rent_basis: "chargeable", ...avRow }).select("id").single();
    if (r.error) throw r.error;
    created.push({ table: "availability", id: r.data.id });
  }
  return s.data.id as string;
}

beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
  other = { db: await userClient("other"), workspaceId: WS2, userId: USERS.other.id, role: "owner" };
  const a1 = await building(`Supply ${t} A`, "conventional_office", { power_kva: 900, car_parks: 80 });
  const a2 = await building(`Supply ${t} B`, "conventional_office", { power_kva: 900 });
  ids.good = await space(a1, "5", { as_of: "2026-11-10", status: "available", supply_status: "immediately_available", available_from: "2026-11-01", valid_until: "2026-12-31",
    fact_status: "currently_confirmed", last_verified_on: "2026-11-10", asking_rent_max: 85, cam_psf_month: 14, source_label: "landlord email" });
  ids.occupied = await space(a1, "6", { as_of: "2026-11-10", status: "available", supply_status: "occupied", fact_status: "currently_confirmed", last_verified_on: "2026-11-10", asking_rent_max: 60 });
  ids.stale = await space(a2, "2", { as_of: "2026-06-01", status: "available", available_from: "2026-07-01", valid_until: "2026-07-31", fact_status: "reported", asking_rent_max: 80 });
  ids.leaseOnly = await space(a2, "3", null);
  const l = await owner.db.from("lease").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: a2, space_id: ids.leaseOnly, tenant_name_raw: `Tenant ${t}`, contractual_expiry: "2026-12-31" });
  if (l.error) throw l.error;
  const req = await createRequirement(owner, { title: `Req ${t}`, orgName: `Org ${t}`, changes: [
    { key: "area", value: [3130, 3137, 3145] }, { key: "area_basis", value: "chargeable" },
    { key: "budget", value: [60, 110] }, { key: "budget_basis", value: "per_sf_month" }] }) as { id: string };
  ids.reqId = req.id;
});

describe("Module 14 · supply engine (DB)", () => {
  it("matchRequirement: hard-filter failures stay visible and below eligible options, with explanations", async () => {
    const r = (await matchRequirement(owner, ids.reqId!, { asOf: AS_OF })).filter((x) => [ids.good, ids.occupied, ids.stale, ids.leaseOnly].includes(x.spaceId));
    const good = r.find((x) => x.spaceId === ids.good)!, occ = r.find((x) => x.spaceId === ids.occupied)!;
    expect(good.eligibility).toBe("eligible");
    expect(good.supplyStatus.confidence).toBe("high");
    expect(occ.eligibility).toBe("ineligible");
    expect(occ.explanation.fails.join()).toMatch(/occupied/);
    expect(good.rank).toBeLessThan(occ.rank);
    const stale = r.find((x) => x.spaceId === ids.stale)!;
    expect(stale.eligibility).toBe("needs_verification");
    expect(stale.explanation.verificationRequired.join()).toMatch(/stale/i);
  });
  it("lease expiry does not establish vacancy", async () => {
    const s = await availabilityStatusForSpace(owner, ids.leaseOnly!, AS_OF);
    expect(s).toMatchObject({ status: "unconfirmed", immediate: false, leaseExpiryOnly: true });
  });
  it("findAlternatives with lease-style criteria excludes the current space and keeps failures visible", async () => {
    const r = await findAlternatives(owner, { areaMinSf: 3130, areaMaxSf: 3145, areaBasis: "chargeable", excludeSpaceIds: [ids.good!], propertyTypes: ["conventional_office"], asOf: AS_OF, limit: 5000 });
    expect(r.some((x) => x.spaceId === ids.good)).toBe(false);
    expect(r.find((x) => x.spaceId === ids.occupied)?.eligibility).toBe("ineligible");
  });
  it("shortlist feedback, rejection reasons, history; reconfirmation gate before presentation", async () => {
    await runShortlist(owner, ids.reqId!, { asOf: AS_OF });
    const h = await shortlistHistory(owner, ids.reqId!);
    const optGood = h.options.find((o) => o.space_id === ids.good)!;
    const optStale = h.options.find((o) => o.space_id === ids.stale)!;
    await recordShortlistFeedback(owner, { optionId: optGood.id as string, kind: "client_feedback", comment: "likes the floor plate", sentiment: "positive" });
    await expect(recordShortlistFeedback(owner, { optionId: optStale.id as string, kind: "rejection" })).rejects.toBeInstanceOf(DealsError);
    const due = await reconfirmationDue(owner, ids.reqId!, { asOf: AS_OF });
    expect(due.find((d) => d.spaceId === ids.stale)!.items.map((i) => i.code)).toContain("stale_availability");
    expect(due.find((d) => d.spaceId === ids.good)?.items.map((i) => i.code) ?? []).not.toContain("stale_availability");
    await expect(assertReadyToPresent(owner, ids.reqId!, { asOf: AS_OF, purpose: "site_visit" })).rejects.toMatchObject({ status: 422 });
    await recordShortlistFeedback(owner, { optionId: optStale.id as string, kind: "rejection", reasonCode: "timing", comment: "stale" });
    const h2 = await shortlistHistory(owner, ids.reqId!);
    expect(h2.options.find((o) => o.id === optStale.id)!.option_status).toBe("rejected");
    expect(h2.feedback.map((f) => f.kind).sort()).toEqual(["client_feedback", "rejection"]);
    expect((await reconfirmationDue(owner, ids.reqId!, { asOf: AS_OF })).some((d) => d.spaceId === ids.stale)).toBe(false);
  });
  it("operator centres: seats, pricing, services, charges, brokerage; unknown seats kept; tenant-isolated", async () => {
    const c = await upsertOperatorCentre(owner, { operator_name: `Op ${t}`, centre_name: "Baner Hub", category: "managed_office", capacity_seats: 400, seats_available: null,
      private_offices: 30, price_per_seat_min: 9000, price_per_seat_max: 14000, services: ["IT", "housekeeping"], amenities: ["cafe"],
      contract_terms: { lockin_months: 12 }, additional_charges: [{ label: "parking", amount: 3000, basis: "per_car_month" }], brokerage_conditions: "1 month per year", last_verified_on: "2026-11-01" }) as { id: string; row_version: number };
    const list = await operatorCentres(owner, { operatorName: `Op ${t}`, minSeats: 50 });
    expect(list.map((x) => x.id)).toContain(c.id);
    const upd = await upsertOperatorCentre(owner, { id: c.id, row_version: c.row_version, operator_name: `Op ${t}`, centre_name: "Baner Hub", seats_available: 20 });
    expect(upd.seats_available).toBe(20);
    await expect(upsertOperatorCentre(owner, { id: c.id, row_version: c.row_version, operator_name: `Op ${t}`, centre_name: "x" })).rejects.toMatchObject({ status: 409 });
    expect((await operatorCentres(owner, { operatorName: `Op ${t}`, minSeats: 50 })).map((x) => x.id)).not.toContain(c.id);
    const seen = await other.db.from("operator_centre").select("id").eq("id", c.id);
    expect(seen.data ?? []).toEqual([]);
  });
});
