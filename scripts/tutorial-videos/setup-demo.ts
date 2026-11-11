/**
 * Tutorial-video demo data. Idempotent (deterministic ids + upsert), local Supabase only.
 *
 * Writes ONLY into the synthetic demo workspace "Demo — Pune CRE (synthetic)" (scripts/demo-data), which is the
 * owner's default workspace once it exists. Two parts:
 *   1. the synthetic demo dataset (same rows as scripts/demo-seed.ts; one generated space that collides with the
 *      space_unit_uq index is merged into its twin so the insert succeeds),
 *   2. the tutorial "story" records tagged demo: Zentrix Analytics, Ananya Rao (Head of Real Estate), Kharadi and
 *      Hinjewadi buildings with coordinates, a lease expiring in ~10 months, a 25,000 sf Kharadi requirement and a
 *      Pune-expansion signal.
 *
 *   npx tsx --env-file=.env.local scripts/tutorial-videos/setup-demo.ts
 */
import { createClient } from "@supabase/supabase-js";
import { buildDemoDataset, did, todayIst, edate, DEMO_WORKSPACE_ID, DEMO_NAME, DEMO_SLUG, OWNER_USER_ID, SYNTHETIC_NOTE } from "../demo-data";

type Row = Record<string, any>;
const WS = DEMO_WORKSPACE_ID;
const tid = (kind: string, key: string) => did(`tutorial:${kind}`, key);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export const TUTORIAL = {
  company: tid("organisation", "zentrix"),
  person: tid("person", "ananya"),
  person2: tid("person", "vikram"),
  kharadi: tid("asset", "kharadi"),
  hinjewadi: tid("asset", "hinjewadi"),
  riverside: tid("asset", "riverside"),
  lease: tid("lease", "zentrix-kharadi"),
  requirement: tid("requirement", "zentrix-25k"),
  signal: tid("signal", "zentrix-expansion"),
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.SUPABASE_SECRET_KEY!;
  if (!url || !key) throw new Error("run with --env-file=.env.local");
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createClient(url, key, { auth: { persistSession: false }, db: { schema: "mudar" } });
  const up = async (table: string, rows: Row[], lenient = false) => {
    if (!rows.length) return;
    for (const r of rows) if (r.workspace_id !== WS) throw new Error(`${table}: non-demo workspace row`);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await db.from(table).upsert(chunk, { onConflict: "id", defaultToNull: false });
      if (!error) continue;
      if (!lenient) throw new Error(`${table}: ${error.message} ${error.details ?? ""}`);
      // the synthetic generator has a few rows that violate newer constraints: skip just those
      let skipped = 0;
      for (const r of chunk) { const e = (await db.from(table).upsert(r, { onConflict: "id", defaultToNull: false })).error; if (e) skipped++; }
      if (skipped) console.warn(`  ${table}: skipped ${skipped} invalid synthetic row(s)`);
    }
  };

  // ---- workspace + membership (same as demo-seed)
  await db.from("workspace").upsert({ id: WS, name: DEMO_NAME, slug: DEMO_SLUG, timezone: "Asia/Kolkata", currency: "INR", status: "active" }, { onConflict: "id" });
  await db.from("membership").upsert({ id: "de000000-0000-4000-8000-0000000000a1", workspace_id: WS, user_id: OWNER_USER_ID, role: "owner",
    allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], see_all_accounts: true, display_name: "Owner (demo)" },
    { onConflict: "workspace_id,user_id", ignoreDuplicates: true });

  // ---- 1. synthetic dataset, with the duplicate space merged
  const today = todayIst();
  const batches = buildDemoDataset(today);
  const remap = new Map<string, string>();
  const spaces = batches.find((b) => b.table === "space")!;
  const seen = new Map<string, string>();
  spaces.rows = spaces.rows.filter((r: Row) => {
    if (!r.unit) return true;
    const k = `${r.asset_id}|${String(r.floor_text).toLowerCase()}|${String(r.unit).toLowerCase()}`;
    if (seen.has(k)) { remap.set(r.id, seen.get(k)!); return false; }
    seen.set(k, r.id); return true;
  });
  for (const b of batches) {
    const rows = b.rows.map((r: Row) => {
      const o: Row = { ...r };
      for (const [c, v] of Object.entries(o)) if (typeof v === "string" && remap.has(v) && c !== "id") o[c] = remap.get(v);
      return o;
    });
    // availability snapshots are append-only: only insert missing ones
    if (b.table === "availability") {
      const { data } = await db.from("availability").select("id").eq("workspace_id", WS).limit(5000);
      const have = new Set((data ?? []).map((x: Row) => x.id));
      await up(b.table, rows.filter((r) => !have.has(r.id)), true);
    } else await up(b.table, rows, true);
  }

  // ---- 2. tutorial story records
  const geo = async (name: string) => (await db.from("geography").select("id").eq("workspace_id", WS).ilike("name", name).limit(1)).data?.[0]?.id ?? null;
  const [kharadi, hinj, sbdEast, pbdWest] = await Promise.all([geo("Kharadi"), geo("Hinjewadi Phase 2"), geo("SBD East"), geo("PBD West")]);
  const base = (cls = "corporate_confidential") => ({ workspace_id: WS, owner_user_id: OWNER_USER_ID, classification: cls });
  const note = `Tutorial demo record (demo). ${SYNTHETIC_NOTE}`;

  await up("organisation", [{ ...base(), id: TUTORIAL.company, display_name: "Zentrix Analytics", legal_name: "Zentrix Analytics Pvt Ltd (demo)",
    sector: "Technology", hq_country: "India", headcount_min: 900, headcount_max: 1200, is_gcc: true, source_confidence: "medium", account_owner_note: note }]);
  await up("person", [
    { ...base("permitted_personal"), id: TUTORIAL.person, full_name: "Ananya Rao", preferred_channel: "email", personal_notes: note },
    { ...base("permitted_personal"), id: TUTORIAL.person2, full_name: "Vikram Desai", preferred_channel: "phone", personal_notes: note },
  ]);
  await up("contact_method", [
    { ...base("permitted_personal"), id: tid("contact", "ananya-email"), person_id: TUTORIAL.person, method_type: "email", value: "ananya.rao@zentrix.example", preferred: true },
    { ...base("permitted_personal"), id: tid("contact", "vikram-email"), person_id: TUTORIAL.person2, method_type: "email", value: "vikram.desai@zentrix.example", preferred: true },
  ]);
  await up("employment", [
    { ...base(), id: tid("employment", "ananya"), person_id: TUTORIAL.person, org_id: TUTORIAL.company, title: "Head of Real Estate", function: "Real Estate", seniority: "head", is_current: true, fact_status: "reported" },
    { ...base(), id: tid("employment", "vikram"), person_id: TUTORIAL.person2, org_id: TUTORIAL.company, title: "Chief Financial Officer", function: "Finance", seniority: "c_level", is_current: true, fact_status: "reported" },
  ]);
  await up("relationship_edge", [{ ...base("permitted_personal"), id: tid("edge", "owner>ananya"), from_user_id: OWNER_USER_ID, from_person_id: null, to_person_id: TUTORIAL.person,
    edge_type: "client_of", warmth: "warm", strength_basis: "Regular calls", intro_permission: false, last_meaningful_contact: addDays(today, -20), relationship_owner_user_id: OWNER_USER_ID }]);
  const asset = (id: string, name: string, loc: string | null, mm: string | null, lat: number, lon: number, sf: number, metroKm: number, amenities: string[]) => ({
    ...base(), id, parent_asset_id: null, asset_kind: "building", name, locality_id: loc, micro_market_id: mm, lat, lon, coord_accuracy: "approximate (demo)",
    status: "ready", total_area_sf: sf, floors: 12, floor_size_min_sf: 20000, floor_size_max_sf: 32000, floor_size_text: "20,000–32,000 sf", grade: "A",
    certifications: [], specs: { demo: true, note, metro_km: metroKm, amenities, power_backup: "100%" },
  });
  await up("asset", [
    // micro_market_id = the locality, so the comparison's "preferred micro-market" rule can match the Kharadi requirement
    asset(TUTORIAL.kharadi, "Kharadi Tech Park (demo)", kharadi, kharadi ?? sbdEast, 18.5515, 73.9442, 380000, 1.2, ["Food court", "Gym", "Crèche", "EV charging"]),
    asset(TUTORIAL.riverside, "Kharadi Riverside Towers (demo)", kharadi, kharadi ?? sbdEast, 18.5562, 73.9391, 300000, 2.5, ["Food court", "Gym"]),
    asset(TUTORIAL.hinjewadi, "Hinjewadi Phase 2 Business Centre (demo)", hinj, hinj ?? pbdWest, 18.5866, 73.7006, 420000, 4.0, ["Food court", "Gym", "Retail"]),
  ]);
  // one available floor plate per building, with an asking rent (availability snapshots are append-only: insert once)
  const avail: [string, number, number][] = [[TUTORIAL.kharadi, 26000, 92], [TUTORIAL.riverside, 25500, 84], [TUTORIAL.hinjewadi, 27000, 68]];
  for (const [assetId, sf, rent] of avail) {
    const spaceId = tid("space", assetId);
    await up("space", [{ ...base(), id: spaceId, asset_id: assetId, floor_text: "Floor 6", unit: "Entire floor", carpet_sf: Math.round(sf * 0.72), chargeable_sf: sf, efficiency: 0.72, configuration: "warm_shell" }]);
    const avId = tid("availability", assetId);
    const { data: have } = await db.from("availability").select("id").eq("workspace_id", WS).eq("id", avId).limit(1);
    if (!(have ?? []).length) await up("availability", [{ ...base(), id: avId, space_id: spaceId, as_of: addDays(today, -5), status: "available", available_from: addDays(today, 30),
      quote_id: null, asking_rent_min: rent, asking_rent_max: rent + 4, rent_basis: "chargeable", fitout_basis: "warm_shell", valid_until: addDays(today, 60), fact_status: "reported" }]);
  }
  const expiry = edate(addDays(today, 300), 0);
  const start = edate(expiry, -60);
  await up("lease", [{ ...base(), id: TUTORIAL.lease, tenant_org_id: TUTORIAL.company, tenant_name_raw: "Zentrix Analytics", asset_id: TUTORIAL.kharadi, area_sf: 18000,
    area_basis: "chargeable", rent_per_sf: 85, rent_basis: "chargeable_monthly", start_date: start, start_precision: "day", tenure_months_raw: 60, lockin_months_raw: 36,
    contractual_expiry: expiry, status: "active", fact_status: "reported" }]);
  await up("lease_event", [
    { ...base(), id: tid("lease_event", "expiry"), lease_id: TUTORIAL.lease, event_type: "expiry", event_date: expiry, date_basis: "contractual", formula_raw: `EDATE(${start}, 60)`, notice_days: 180, confirmed: false },
    { ...base(), id: tid("lease_event", "notice"), lease_id: TUTORIAL.lease, event_type: "notice_deadline", event_date: addDays(expiry, -180), date_basis: "contractual", notice_days: 180, confirmed: false },
  ]);
  await up("requirement", [{ ...base(), id: TUTORIAL.requirement, org_id: TUTORIAL.company, title: "Zentrix Analytics — 25,000 sf in Kharadi", objective: "expansion",
    transaction_kinds: ["conventional"], area_min_sf: 22000, area_target_sf: 25000, area_max_sf: 28000, area_basis: "chargeable", preferred_geography_ids: kharadi ? [kharadi] : [],
    constraints: { micro_market_text: "Kharadi", note }, status: "draft" }]);
  await up("signal", [{ ...base(), id: TUTORIAL.signal, category: "expansion", kind: "pune_expansion", title: "Zentrix Analytics plans Pune expansion", org_id: TUTORIAL.company,
    location_text: "Pune", summary: "Demo signal: a (made-up) report that Zentrix Analytics is hiring 300 more people in Pune next year.",
    cre_relevance: "If true, they may need roughly 25,000 sf more office space in Kharadi (inference).", verification: "hypothesis", confidence: "medium",
    latest_evidence_on: today, status: "new", priority: 80, priority_band: "high", dedupe_key: "tutorial-demo:zentrix-expansion" }]);

  const { count } = await db.from("organisation").select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`Tutorial demo data ready in "${DEMO_NAME}" (${WS}): ${count} companies; Zentrix=${TUTORIAL.company}, lease expiry ${expiry}`);
}

if (require.main === module || process.argv[1]?.endsWith("setup-demo.ts")) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
