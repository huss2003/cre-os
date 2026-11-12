/**
 * Demo data for the "supply" tutorial videos (Module 14 Property Supply & Matching). Local Supabase + demo workspace ONLY. Synthetic.
 *   - Harbour Point (demo) [conventional office, 900 kVA, 90 car parks]: Floor 4 immediately available (verified this week, landlord email,
 *     rent + CAM); Floor 5 available from April 2027 (future supply ≠ immediate); Floor 6 occupied.
 *   - Riverstone Tech Annex (demo) [conventional office]: Floor 2 seen five months ago (stale, old pricing); Floor 3 only a lease expiring
 *     (lease expiry ≠ vacancy).
 *   - Two operator centres (managed office + coworking) with seats, pricing, services, charges and brokerage.
 *   - Requirement "Lumen Harbour Tech — 18–19.5k SF (tutorial)" and a stored shortlist (so feedback can be recorded).
 * Re-runnable: availability rows are reset to these values; the tutorial requirement is archived and recreated; operator centres
 * and buildings are inserted once (stable ids).
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-supply.ts
 */
import { did, DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { userClient } from "../../tests/helpers";
import type { DealsCtx } from "@/modules/deals/ctx";
import { createRequirement } from "@/modules/deals/requirements/service";
import { runShortlist } from "@/modules/deals/matching/service";

type Row = Record<string, any>;
const id = (kind: string, key: string) => did(`tutorial:supply:${kind}`, key);
const TITLE = "Lumen Harbour Tech — 18–19.5k SF (tutorial)";
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createAdminClient();
  const ctx: DealsCtx = { db: await userClient("owner"), workspaceId: WS, userId: OWNER, role: "owner" };
  const base = { workspace_id: WS, owner_user_id: OWNER, classification: "corporate_confidential" };
  const once = async (table: string, rows: Row[]) => { for (const row of rows) { const { error } = await db.from(table).upsert(row, { onConflict: "id", ignoreDuplicates: true }); if (error) throw new Error(`${table}: ${error.message}`); } };
  const put = async (table: string, rows: Row[]) => { for (const row of rows) { const { error } = await db.from(table).upsert(row, { onConflict: "id" }); if (error) throw new Error(`${table}: ${error.message}`); } };
  const kharadi = (await db.from("geography").select("id").eq("workspace_id", WS).eq("name", "Kharadi").limit(1)).data?.[0]?.id ?? null;

  const A = id("asset", "harbour"), B = id("asset", "riverstone");
  await once("asset", [
    { ...base, id: A, asset_kind: "building", name: "Harbour Point (demo)", category: "conventional_office", status: "ready", grade: "A", micro_market_id: kharadi, address: "Kharadi, Pune (demo)", specs: { power_kva: 900, car_parks: 90 } },
    { ...base, id: B, asset_kind: "building", name: "Riverstone Tech Annex (demo)", category: "conventional_office", status: "ready", grade: "B", micro_market_id: kharadi, address: "Kharadi, Pune (demo)", specs: { power_kva: 600 } },
  ]);
  const S = { f4: id("space", "h4"), f5: id("space", "h5"), f6: id("space", "h6"), r2: id("space", "r2"), r3: id("space", "r3") };
  await once("space", [
    { ...base, id: S.f4, asset_id: A, floor_text: "4", chargeable_sf: 18750, carpet_sf: 13100, contiguous_group: "H-4/5", divisible: true, min_divisible_sf: 9000 },
    { ...base, id: S.f5, asset_id: A, floor_text: "5", chargeable_sf: 18750, carpet_sf: 13100, contiguous_group: "H-4/5", divisible: false },
    { ...base, id: S.f6, asset_id: A, floor_text: "6", chargeable_sf: 18750, carpet_sf: 13100 },
    { ...base, id: S.r2, asset_id: B, floor_text: "2", chargeable_sf: 18900, carpet_sf: 13000 },
    { ...base, id: S.r3, asset_id: B, floor_text: "3", chargeable_sf: 18900, carpet_sf: 13000 },
  ]);
  const av = (k: string, space: string, r: Row) => ({ ...base, id: id("availability", k), space_id: space, rent_basis: "chargeable", archived_at: null, ...r });
  await put("availability", [
    av("h4", S.f4, { as_of: addDays(TODAY, -3), status: "available", supply_status: "immediately_available", available_from: addDays(TODAY, -10), valid_until: addDays(TODAY, 45),
      fact_status: "currently_confirmed", last_verified_on: addDays(TODAY, -3), asking_rent_max: 92, cam_psf_month: 14, source_label: "Landlord email (demo)", furnishing: "warm_shell", area_type: "chargeable", lockin_months: 36, lease_term_months: 108 }),
    av("h5", S.f5, { as_of: addDays(TODAY, -3), status: "available", supply_status: "future_available", available_from: "2027-04-01", fact_status: "currently_confirmed",
      last_verified_on: addDays(TODAY, -3), asking_rent_max: 95, source_label: "Landlord email (demo)" }),
    av("h6", S.f6, { as_of: addDays(TODAY, -3), status: "available", supply_status: "occupied", fact_status: "currently_confirmed", last_verified_on: addDays(TODAY, -3), asking_rent_max: 90, source_label: "Site visit (demo)" }),
    av("r2", S.r2, { as_of: addDays(TODAY, -150), status: "available", available_from: addDays(TODAY, -140), valid_until: addDays(TODAY, -100), fact_status: "reported", asking_rent_max: 78, source_label: "Broker list (demo)" }),
  ]);
  await once("lease", [{ ...base, id: id("lease", "r3"), asset_id: B, space_id: S.r3, tenant_name_raw: "Ottervale Systems (demo)", contractual_expiry: "2027-03-31", fact_status: "reported" }]);

  await once("operator_centre", [
    { ...base, id: id("centre", "nest"), operator_name: "NestWorks (demo)", centre_name: "Kharadi Hub", category: "managed_office", capacity_seats: 600, seats_available: 140, private_offices: 12,
      price_per_seat_min: 11000, price_per_seat_max: 14500, services: ["housekeeping", "IT helpdesk", "reception"], amenities: ["cafeteria", "gym"],
      additional_charges: [{ label: "Car park ₹4,000/month" }, { label: "Meeting rooms beyond 10 hrs" }], contract_terms: { lock_in_months: 12, notice_months: 3 },
      brokerage_conditions: "1 month on 12-month term", source_label: "Operator rate card (demo)", last_verified_on: addDays(TODAY, -6), fact_status: "currently_confirmed" },
    { ...base, id: id("centre", "loop"), operator_name: "LoopDesk (demo)", centre_name: "Viman Nagar", category: "coworking", capacity_seats: 220, seats_available: null, private_offices: 4,
      price_per_seat_min: 8500, price_per_seat_max: null, services: ["housekeeping"], amenities: ["terrace"], source_label: "Website (demo)", fact_status: "reported" },
  ]);

  // the operators video adds "Skyhive (demo)": archive it so each run adds it once
  await db.from("operator_centre").update({ archived_at: new Date().toISOString() }).eq("workspace_id", WS).eq("operator_name", "Skyhive (demo)").is("archived_at", null);

  // requirement + stored shortlist
  const old = ((await db.from("requirement").select("id").eq("workspace_id", WS).eq("title", TITLE).is("archived_at", null)).data ?? []) as Row[];
  if (old.length) await db.from("requirement").update({ archived_at: new Date().toISOString() }).eq("workspace_id", WS).in("id", old.map((r) => r.id));
  const org = (await db.from("organisation").select("id").eq("workspace_id", WS).eq("display_name", "Lumen Harbour Tech (demo)").limit(1)).data?.[0]?.id as string | undefined;
  const req = await createRequirement(ctx, { title: TITLE, ...(org ? { orgId: org } : { orgName: "Lumen Harbour Tech (demo)" }), changes: [
    { key: "area", value: [18000, 18750, 19500] }, { key: "area_basis", value: "chargeable" }, { key: "budget", value: [70, 100] }, { key: "budget_basis", value: "per_sf_month" }] } as never) as { id: string };
  const run = await runShortlist(ctx, req.id, { note: "Tutorial shortlist" });
  console.log("SUPPLY", req.id, JSON.stringify({ options: (run as Row).options?.length ?? null }));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
