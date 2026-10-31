/**
 * Leases + lease events with key dates spread across past / 0–3 / 3–12 / 12–24 / 24+ months from today
 * (one fractional tenure quarantined with needs_review), market transactions 2022–2025 and
 * market observations (stock / supply / absorption / rent) per micro-market for 2018–2025.
 */
import { Rng, addDays, base, did, edate, SEED_VERSION, type GenContext, type Row } from "./core";
import { MICRO_MARKETS, microMarketId, type MicroMarketKey } from "./geography";
import { OCCUPIERS, orgId, orgByKey } from "./organisations";
import { RENT_BASE, type AssetDef, type SpaceDef } from "./assets";

const ENGINE = "demo-seed";
type Bucket = "past" | "0-3m" | "3-12m" | "12-24m" | "24m+";
const BUCKETS: Array<[Bucket, number, number, number]> = [
  // bucket, count, min offset days, max offset days (expiry relative to today)
  ["past", 6, -540, -10],
  ["0-3m", 7, 5, 88],
  ["3-12m", 10, 95, 360],
  ["12-24m", 10, 370, 725],
  ["24m+", 11, 740, 2200],
];

export function buildLeases(ctx: GenContext, assets: AssetDef[], spaces: SpaceDef[]) {
  const rng = new Rng("leases");
  const leases: Row[] = [];
  const events: Row[] = [];
  const leasable = assets.filter((a) => a.kind !== "campus" && a.status === "ready");
  let seq = 0;

  const ev = (leaseKey: string, type: string, extra: Row) =>
    events.push({
      ...base(), id: did("lease_event", `${leaseKey}:${type}`), lease_id: did("lease", leaseKey), event_type: type,
      event_date: null, date_basis: "calculated_from_source_tenure", formula_raw: null, notice_days: null, notice_day_rule: null,
      confirmed: false, needs_review: false, review_reason: null, engine_version: ENGINE, source_object_id: ctx.sourceObjectId, ...extra,
    });

  const addLease = (opts: { key: string; bucket: Bucket | "fractional" | "renewal"; expiryTarget?: string; tenure: number; start?: string; amends?: string; tenantKey?: string; assetKey?: string }) => {
    seq++;
    const asset = opts.assetKey ? leasable.find((a) => a.key === opts.assetKey)! : rng.pick(leasable);
    const matched = opts.tenantKey !== undefined || rng.chance(0.85);
    const tenant = opts.tenantKey ? orgByKey(opts.tenantKey) : rng.pick(OCCUPIERS);
    const tenure = opts.tenure;
    const lockin = rng.pick([24, 36, 36, null] as const);
    const start = opts.start ?? edate(opts.expiryTarget!, -Math.ceil(tenure));
    const integral = Number.isInteger(tenure);
    const expiry = integral ? edate(start, tenure) : null;
    const yearsAgo = Math.max(0, (Date.parse(ctx.today) - Date.parse(start)) / (365.25 * 86400000));
    const rent = Math.round(RENT_BASE[asset.microMarket] * Math.pow(0.965, yearsAgo) * rng.float(0.9, 1.08));
    const space = spaces.find((s) => s.assetKey === asset.key && s.latestStatus === "leased");
    const registered = rng.chance(0.75);
    leases.push({
      ...base(), id: did("lease", opts.key),
      tenant_org_id: matched ? orgId(tenant.key) : null,
      tenant_name_raw: matched ? tenant.name.toUpperCase() : `${rng.pick(["Zephyrine", "Okapi Trail", "Brambleton"])} Services (unmatched, synthetic)`,
      landlord_org_id: orgId(asset.developer), asset_id: asset.id, space_id: space && rng.chance(0.5) ? space.id : null,
      area_sf: rng.step(6000, 90000, 500), area_basis: "chargeable",
      rent_per_sf: rent, rent_basis: "chargeable_per_month",
      registration_ref: registered ? `DEMO-REG-${start.slice(0, 4)}-${String(seq).padStart(5, "0")}` : null,
      registration_date: registered ? addDays(start, -rng.int(3, 40)) : null,
      start_date: start, start_precision: rng.chance(0.85) ? "day" : "month",
      tenure_months_raw: tenure, lockin_months_raw: lockin,
      contractual_expiry: expiry,
      status: expiry == null ? "unknown" : expiry < ctx.today ? (opts.bucket === "past" && seq % 3 === 0 ? "holding_over" : "expired") : "active",
      fact_status: "historical_observed", amends_lease_id: opts.amends ? did("lease", opts.amends) : null,
      source_object_id: ctx.sourceObjectId,
    });

    if (expiry) {
      const noticeDays = rng.pick([90, 180, 180]);
      const rule = rng.chance(0.8) ? "calendar" : "business";
      ev(opts.key, "expiry", { event_date: expiry, formula_raw: `EDATE(${start}, ${tenure})`, notice_days: noticeDays, notice_day_rule: rule, confirmed: rng.chance(0.3) });
      if (rng.chance(0.6) && rule === "calendar") {
        ev(opts.key, "notice_deadline", {
          event_date: addDays(expiry, -noticeDays), date_basis: "contractual",
          formula_raw: `Clause ${rng.int(3, 9)}.${rng.int(1, 6)}: ${noticeDays} days' written notice before expiry (synthetic)`,
          notice_days: noticeDays, notice_day_rule: "calendar", confirmed: rng.chance(0.4),
        });
      }
    } else {
      ev(opts.key, "expiry", {
        event_date: null, formula_raw: `EDATE(${start}, ${tenure})`, needs_review: true,
        review_reason: `Fractional tenure in source (${tenure} months) — expiry not calculated; confirm against the lease deed.`,
      });
    }
    if (lockin != null && lockin < tenure) ev(opts.key, "lockin_end", { event_date: edate(start, lockin), formula_raw: `EDATE(${start}, ${lockin})` });
    if (tenure >= 60) {
      const nextEsc = [36, 72, 108].map((m) => edate(start, m)).find((d) => d > ctx.today && (!expiry || d < expiry));
      if (nextEsc) ev(opts.key, "escalation", { event_date: nextEsc, date_basis: "contractual", formula_raw: "15% every 36 months (synthetic)" });
    }
  };

  for (const [bucket, count, lo, hi] of BUCKETS) {
    for (let i = 0; i < count; i++) {
      addLease({ key: `L-${bucket}-${i + 1}`, bucket, expiryTarget: addDays(ctx.today, rng.int(lo, hi)), tenure: rng.pick([36, 60, 60, 108, 120]) });
    }
  }
  // fractional tenure (needs_review)
  addLease({ key: "L-fractional-1", bucket: "fractional", tenure: 62.5, start: edate(ctx.today, -55) });
  // a renewal amending the first expired lease (same tenant & asset)
  const first = leases[0];
  const firstEnd = first.contractual_expiry as string;
  const firstTenant = OCCUPIERS.find((o) => orgId(o.key) === first.tenant_org_id);
  const firstAsset = leasable.find((a) => a.id === first.asset_id)!;
  addLease({ key: "L-renewal-1", bucket: "renewal", tenure: 60, start: addDays(firstEnd, 1), amends: "L-past-1", tenantKey: firstTenant?.key ?? "pebblewick", assetKey: firstAsset.key });
  return { leases, events };
}

export function buildMarket(ctx: GenContext, assets: AssetDef[]) {
  const rng = new Rng("market");
  const transactions: Row[] = [];
  const ready = assets.filter((a) => a.kind !== "campus" && a.status === "ready");
  for (let i = 0; i < 40; i++) {
    const year = 2022 + (i % 4);
    const q = rng.int(0, 3);
    const start = `${year}-${String(q * 3 + 1).padStart(2, "0")}-01`;
    const end = addDays(edate(start, 3), -1);
    const asset = rng.pick(ready);
    const dealType = rng.pick(["conventional", "conventional", "conventional", "renewal", "expansion", "pre_commitment", "managed", "coworking"]);
    const seatBased = dealType === "managed" || dealType === "coworking";
    const tenant = rng.pick(OCCUPIERS);
    const matched = rng.chance(0.85);
    const rentBase = RENT_BASE[asset.microMarket] * Math.pow(1.04, year - 2025);
    const rmin = seatBased ? rng.step(8000, 15000, 250) : Math.round(rentBase * rng.float(0.9, 1.08));
    const brokerKnown = rng.chance(0.5);
    transactions.push({
      ...base(), id: did("market_transaction", `T-${i + 1}`),
      tenant_org_id: matched ? orgId(tenant.key) : null,
      tenant_name_raw: matched ? tenant.name : "Undisclosed occupier (synthetic)",
      asset_id: asset.id, space_id: null, deal_type: dealType,
      period_start: start, period_end: end, period_precision: "quarter",
      area_sf: seatBased ? null : rng.step(5000, 250000, 500), seats: seatBased ? rng.int(40, 600) : null,
      rent_min: rng.chance(0.85) ? rmin : null, rent_max: null, rent_basis: seatBased ? "per_seat_per_month" : "chargeable_per_month",
      broker_org_id: brokerKnown && rng.chance(0.5) ? orgId("meridian_ashlar") : null,
      broker_name_raw: brokerKnown ? rng.pick(["Meridian Ashlar Advisors", "Demo Advisory Desk", "Direct with landlord"]) : null,
      inclusions: seatBased ? "Furnished, IT-ready, housekeeping (synthetic)" : null,
      source_object_id: ctx.sourceObjectId,
      extras: { synthetic: true, seed_version: SEED_VERSION },
    });
    // rent_max mirrors rent_min with a small band when known
    const t = transactions[transactions.length - 1];
    if (t.rent_min != null) t.rent_max = (t.rent_min as number) + (seatBased ? rng.step(0, 1500, 250) : rng.int(0, 8));
  }

  // ---------------------------------------------------------------- observations 2018–2025
  const observations: Row[] = [];
  const STOCK_2017: Record<MicroMarketKey, number> = { sbd_east: 21.5, pbd_west: 27.0, sbd_west: 8.5, cbd: 6.2, hadapsar: 13.8, pcmc: 3.9 };
  const DEFS: Record<string, { unit: string; definition: string }> = {
    stock: { unit: "msf", definition: "Completed Grade A office stock at year end, million sq ft (chargeable). Synthetic." },
    supply: { unit: "msf", definition: "New Grade A completions during the calendar year, million sq ft. Synthetic." },
    absorption: { unit: "msf", definition: "Gross absorption (leasing incl. pre-commitments, excl. renewals) in the year, million sq ft. Synthetic." },
    rent: { unit: "INR/sf/month", definition: "Weighted average Grade A asking rent on chargeable area at year end, INR per sq ft per month (warm shell). Synthetic." },
  };
  for (const m of MICRO_MARKETS) {
    const r = new Rng(`market:obs:${m.key}`);
    let stock = STOCK_2017[m.key];
    let rent = RENT_BASE[m.key] * 0.8;
    for (let y = 2018; y <= 2025; y++) {
      const covid = y === 2020 ? 0.45 : y === 2021 ? 0.7 : 1;
      const supply = Number((stock * r.float(0.03, 0.1, 4) * (y === 2020 ? 0.6 : 1)).toFixed(2));
      stock = Number((stock + supply).toFixed(2));
      const absorption = Number((supply * r.float(0.7, 1.25, 4) * covid).toFixed(2));
      rent = rent * (y === 2020 || y === 2021 ? r.float(0.98, 1.01, 4) : r.float(1.02, 1.06, 4));
      const values: Record<string, number> = { stock, supply, absorption, rent: Number(rent.toFixed(2)) };
      for (const metric of ["stock", "supply", "absorption", "rent"]) {
        observations.push({
          ...base(), id: did("market_observation", `${m.key}:${metric}:${y}`), metric,
          geography_id: microMarketId(m.key), geography_raw: m.name,
          period_start: `${y}-01-01`, period_end: `${y}-12-31`, period_type: "full_year",
          unit: DEFS[metric].unit, value: values[metric], definition: DEFS[metric].definition,
          release_date: `${y + 1}-01-25`, source_object_id: ctx.sourceObjectId, source_version: SEED_VERSION,
        });
      }
    }
  }
  return { transactions, observations };
}
