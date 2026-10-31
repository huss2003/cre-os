/*
 * Import pipeline (spec Part I §6, Part III "Import adapters and reconciliation", Part V "Import acceptance rules"):
 *   read-only source > hashed import > row-level staging > schema mapping > type checks > candidate matching >
 *   exception queue > validated upserts > reconciliation.
 *
 * Works with either the user's RLS client (inline processing from the upload route) or the service-role client
 * (job "imports.process"). Every query filters workspace_id explicitly (rule S2).
 *
 * Idempotency (S8): every row written here has a DETERMINISTIC id derived from (workspace, type, natural key), and is
 * inserted with ON CONFLICT DO NOTHING. Re-importing an identical file is a no-op at the hash level; re-processing a
 * batch or importing a revised version links to the existing masters/events instead of duplicating them.
 * Existing canonical fields are never overwritten by an import (S4); merges only happen through proposeChange('merge').
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/supabase/server";
import { assertIngestionAllowed, IngestionPausedError } from "@/modules/admin/killswitch";
import { proposeChange } from "@/lib/services/changes";
import { parseFile } from "./parse";
import { type ApprovedMapping, type SheetDetection, detectWorkbook, getAdapter, getRole, mapWorkbook } from "./detect";
import { type DiffRow, type Reconciliation, type StagedRowDraft, type WriteStats, buildStaged, diffKey, diffVersions, markDuplicates, reconcile } from "./reconcile";
import { canonicalBuilding, canonicalOrg, exactKey } from "./normalize";
import { buildingBlock, findCandidates, orgBlock, scoreBuilding, scoreOrganisation } from "./identity";
import { LEASE_ENGINE_VERSION } from "./lease-events";
import {
  type AdapterOptions, type AssetObservationRecord, type ControlCheck, type IdentityThresholds, type LeaseRecord, type MarketRowRecord,
  type ParsedRow, type RowIssue, type SizeRules, type TransactionRecord, DEFAULT_SIZE_RULES, DEFAULT_THRESHOLDS,
} from "./types";


export const BUCKET = "mudar-workspace-files";
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export class ImportError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* ------------------------------------------------------------------ deterministic ids + chunked helpers */

/** Deterministic UUID (v5-shaped) for (workspace, type, key). Same input => same id => idempotent inserts. */
export function detId(ws: string, type: string, key: string): string {
  const h = createHash("sha256").update(`${ws}\u0000${type}\u0000${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function selectIn<T = Record<string, unknown>>(db: Db, ws: string, table: string, col: string, values: string[], columns: string): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(values)], 150)) {
    if (!part.length) continue;
    const { data, error } = await db.from(table).select(columns).eq("workspace_id", ws).in(col, part);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

async function insertIgnore(db: Db, table: string, rows: Record<string, unknown>[]) {
  for (const part of chunk(rows, 400)) {
    if (!part.length) continue;
    const { error } = await db.from(table).upsert(part, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function upsertMerge(db: Db, table: string, rows: Record<string, unknown>[]) {
  for (const part of chunk(rows, 400)) {
    if (!part.length) continue;
    const { error } = await db.from(table).upsert(part, { onConflict: "id" });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function selectAll<T>(db: Db, ws: string, table: string, columns: string, filter: { eq?: Record<string, string>; isNull?: string[] } = {}): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns).eq("workspace_id", ws);
    for (const [k, v] of Object.entries(filter.eq ?? {})) q = q.eq(k, v);
    for (const k of filter.isNull ?? []) q = q.is(k, null);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/* ------------------------------------------------------------------ settings */

export async function loadImportSettings(db: Db, ws: string): Promise<{ sizeRules: SizeRules; thresholds: IdentityThresholds }> {
  const { data } = await db.from("workspace_setting").select("key, value").eq("workspace_id", ws)
    .in("key", ["size_rules", "imports.size_rules", "imports.identity_thresholds"]);
  const get = (k: string) => (data ?? []).find((r: { key: string }) => r.key === k)?.value as Record<string, unknown> | undefined;
  // Settings page saves { min_sf, max_sf } under "size_rules"; "imports.size_rules" (exclusive bounds) overrides it.
  const general = get("size_rules") ?? {};
  const sr: Record<string, unknown> = { min_exclusive_sf: general.min_sf, max_exclusive_sf: general.max_sf, ...(get("imports.size_rules") ?? {}) };
  const th = get("imports.identity_thresholds") ?? {};
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    sizeRules: {
      min_exclusive_sf: n(sr.min_exclusive_sf, DEFAULT_SIZE_RULES.min_exclusive_sf),
      max_exclusive_sf: n(sr.max_exclusive_sf, DEFAULT_SIZE_RULES.max_exclusive_sf),
      small_band_below_sf: n(sr.small_band_below_sf, DEFAULT_SIZE_RULES.small_band_below_sf),
    },
    thresholds: { auto_link: n(th.auto_link, DEFAULT_THRESHOLDS.auto_link), review: n(th.review, DEFAULT_THRESHOLDS.review) },
  };
}

/* ------------------------------------------------------------------ 1. register (hash, store original, version) */

export interface ImportOptions {
  as_of?: string | null;
  period_year?: number | null;
  classification?: "public" | "permitted_personal" | "corporate_confidential" | "licensed_restricted";
}

export interface RegisterResult {
  batchId: string;
  sourceObjectId: string;
  duplicate: boolean; // same sha256 already imported in this workspace => no-op
  version: number;
  sha256: string;
}

function safeName(name: string) {
  const base = name.replace(/^.*[\\/]/, "").trim() || "upload";
  return base.replace(/[^\w.\-() &]+/g, "_").slice(0, 160);
}

function contentType(name: string) {
  if (/\.xlsx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.csv$/i.test(name)) return "text/csv";
  return "application/octet-stream";
}

export async function registerImport(
  db: Db,
  input: { workspaceId: string; userId: string; fileName: string; bytes: Uint8Array; options?: ImportOptions },
): Promise<RegisterResult> {
  const ws = input.workspaceId;
  if (!input.bytes.length) throw new ImportError(400, "empty file");
  if (input.bytes.length > MAX_IMPORT_BYTES) throw new ImportError(413, "file too large (25 MB max)");
  if (!/\.(xlsx|csv|txt)$/i.test(input.fileName)) throw new ImportError(400, "upload an .xlsx or .csv file (macro-enabled and legacy .xls files are not accepted)");
  const sha = sha256Hex(input.bytes);
  const fileName = safeName(input.fileName);

  // Same hash => idempotent no-op (whatever the file name).
  const { data: same } = await db.from("source_object").select("id, version").eq("workspace_id", ws).eq("kind", "file").eq("sha256", sha)
    .is("archived_at", null).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (same) {
    const { data: b } = await db.from("import_batch").select("id").eq("workspace_id", ws).eq("source_object_id", same.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (b) return { batchId: b.id, sourceObjectId: same.id, duplicate: true, version: same.version, sha256: sha };
  }

  // Same name, new hash => new version of that source.
  const { data: prev } = await db.from("source_object").select("id, version").eq("workspace_id", ws).eq("kind", "file").eq("file_name", fileName)
    .neq("sha256", sha).is("archived_at", null).order("version", { ascending: false }).limit(1).maybeSingle();

  const classification = input.options?.classification ?? "corporate_confidential";
  let sourceId = same?.id as string | undefined;
  let version = same?.version ?? (prev ? prev.version + 1 : 1);
  if (!sourceId) {
    // licensed/restricted originals live under <ws>/private/** (owner-only storage policy); others under <ws>/imports/**
    const path = classification === "licensed_restricted" ? `${ws}/private/imports/${sha}/${fileName}` : `${ws}/imports/${sha}/${fileName}`;
    const up = await db.storage.from(BUCKET).upload(path, input.bytes, { contentType: contentType(fileName), upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new ImportError(500, `storage upload failed: ${up.error.message}`);
    const { data: so, error } = await db.from("source_object").insert({
      workspace_id: ws, owner_user_id: input.userId, classification,
      kind: "file", uri: `storage://${BUCKET}/${path}`, file_name: fileName, sha256: sha, version,
      previous_version_id: prev?.id ?? null,
      meta: { size: input.bytes.length, module: "imports", storage_bucket: BUCKET, storage_path: path, read_only: true },
    }).select("id, version").single();
    if (error) throw error;
    sourceId = so.id as string;
    version = so.version;
  }

  let previousBatchId: string | null = null;
  if (prev) {
    const { data: pb } = await db.from("import_batch").select("id").eq("workspace_id", ws).eq("source_object_id", prev.id)
      .in("status", ["completed", "completed_with_exceptions", "needs_mapping"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    previousBatchId = pb?.id ?? null;
  }
  const { data: batch, error: be } = await db.from("import_batch").insert({
    workspace_id: ws, owner_user_id: input.userId, classification,
    source_object_id: sourceId, previous_batch_id: previousBatchId, file_name: fileName, status: "registered",
    options: { as_of: input.options?.as_of ?? null, period_year: input.options?.period_year ?? null, classification },
    created_by: input.userId,
  }).select("id").single();
  if (be) throw be;
  return { batchId: batch.id, sourceObjectId: sourceId!, duplicate: false, version, sha256: sha };
}

/* ------------------------------------------------------------------ 2. process */

interface Ctx {
  db: Db;
  ws: string;
  batchId: string;
  src: string;
  owner: string | null;
  classification: string;
  sourceVersion: string;
  thresholds: IdentityThresholds;
}

type Target = { type: string; id: string; role: "master" | "observation"; created: boolean; via?: string };

function stamp(ctx: Ctx, row: Record<string, unknown>) {
  return { workspace_id: ctx.ws, owner_user_id: ctx.owner, classification: ctx.classification, ...row };
}

interface KeyRes { id: string; created: boolean }

/** Resolve natural keys to master ids (creating key rows for new ones). Follows applied merges for archived masters. */
async function resolveKeys(ctx: Ctx, entityType: string, keys: string[]): Promise<Map<string, KeyRes>> {
  const uniq = [...new Set(keys)];
  const keyIds = new Map(uniq.map((k) => [k, detId(ctx.ws, `key:${entityType}`, k)]));
  const existing = await selectIn<{ id: string; entity_id: string; first_source_object_id: string | null }>(
    ctx.db, ctx.ws, "import_entity_key", "id", [...keyIds.values()], "id, entity_id, first_source_object_id");
  const byId = new Map(existing.map((e) => [e.id, e]));
  const out = new Map<string, KeyRes>();
  const toInsert: Record<string, unknown>[] = [];
  for (const k of uniq) {
    const kid = keyIds.get(k)!;
    const e = byId.get(kid);
    if (e) out.set(k, { id: e.entity_id, created: e.first_source_object_id === ctx.src });
    else {
      const id = detId(ctx.ws, entityType, k);
      out.set(k, { id, created: true });
      toInsert.push(stamp(ctx, { id: kid, entity_type: entityType, natural_key: k, entity_id: id, first_source_object_id: ctx.src }));
    }
  }
  await insertIgnore(ctx.db, "import_entity_key", toInsert);
  if (entityType === "asset" || entityType === "organisation") await followMerges(ctx, entityType, out, keyIds);
  return out;
}

/** If a master was merged away (archived loser of an applied merge proposal), link to the winner instead. */
async function followMerges(ctx: Ctx, table: string, res: Map<string, KeyRes>, keyIds: Map<string, string>) {
  const ids = [...new Set([...res.values()].filter((r) => !r.created).map((r) => r.id))];
  if (!ids.length) return;
  const archived = (await selectIn<{ id: string; archived_at: string | null }>(ctx.db, ctx.ws, table, "id", ids, "id, archived_at")).filter((r) => r.archived_at);
  for (const a of archived) {
    const { data } = await ctx.db.from("change_proposal").select("target_id").eq("workspace_id", ctx.ws).eq("target_type", table)
      .eq("operation", "merge").eq("state", "applied").contains("patch", [{ path: "/loser_id", value: a.id }]).limit(1).maybeSingle();
    if (!data?.target_id) continue;
    for (const [k, r] of res) {
      if (r.id !== a.id) continue;
      r.id = data.target_id;
      await ctx.db.from("import_entity_key").update({ entity_id: data.target_id }).eq("workspace_id", ctx.ws).eq("id", keyIds.get(k)!);
    }
  }
}

async function existingIds(ctx: Ctx, table: string, ids: string[]): Promise<Set<string>> {
  return new Set((await selectIn<{ id: string }>(ctx.db, ctx.ws, table, "id", ids, "id")).map((r) => r.id));
}

const assetKey = (building: string, locality: string) => `${exactKey(building)}|${exactKey(locality)}`;
const geoKey = (level: string, name: string) => `${level}|${exactKey(name)}`;

function assetStatus(raw: string | null): string | null {
  if (!raw) return null;
  if (/under\s*construction|\bu\/?c\b/i.test(raw)) return "under_construction";
  if (/ready|complete|operational|occupied|\boc\b/i.test(raw)) return "ready";
  if (/planned|proposed|approved|launch/i.test(raw)) return "planned";
  return null; // keep unknown; raw wording stays on the observation
}

function bump(m: Record<string, { new: number; existing_linked: number }>, type: string, created: boolean) {
  m[type] ??= { new: 0, existing_linked: 0 };
  if (created) m[type].new++;
  else m[type].existing_linked++;
}
function bumpObs(m: Record<string, { new: number; existing: number }>, type: string, isNew: boolean, n = 1) {
  m[type] ??= { new: 0, existing: 0 };
  if (isNew) m[type].new += n;
  else m[type].existing += n;
}

/** Validated upserts for accepted rows. Returns targets per staged row + write stats. */
async function writeRecords(ctx: Ctx, staged: StagedRowDraft[]): Promise<{ targets: Map<string, Target[]>; stats: WriteStats; issues: { locator: string; issue: RowIssue }[] }> {
  const live = staged.filter((r) => (r.status === "accepted" || r.status === "duplicate") && r.record && r.record.kind !== "reference");
  const assetsObs = live.filter((r) => r.record!.kind === "asset_observation") as (StagedRowDraft & { record: AssetObservationRecord })[];
  const leases = live.filter((r) => r.record!.kind === "lease_row") as (StagedRowDraft & { record: LeaseRecord })[];
  const txs = live.filter((r) => r.record!.kind === "transaction") as (StagedRowDraft & { record: TransactionRecord })[];
  const markets = live.filter((r) => r.record!.kind === "market_row") as (StagedRowDraft & { record: MarketRowRecord })[];
  const targets = new Map<string, Target[]>();
  const addT = (loc: string, t: Target) => (targets.get(loc) ?? targets.set(loc, []).get(loc)!).push(t);
  const masters: WriteStats["masters"] = {};
  const observations: WriteStats["observations"] = {};
  const extraIssues: { locator: string; issue: RowIssue }[] = [];
  const aliases: Record<string, unknown>[] = [];
  const alias = (type: string, id: string, raw: string, canonical: string) => {
    if (!raw || !canonical) return;
    aliases.push(stamp(ctx, { id: detId(ctx.ws, "entity_alias", `${type}|${id}|${canonical}`), entity_type: type, entity_id: id, raw_alias: raw, canonical_alias: canonical, source_object_id: ctx.src }));
  };

  // ---- geographies (localities from buildings/leases; micro-markets from market matrices)
  const geoNeeds = new Map<string, { level: string; name: string }>();
  for (const r of assetsObs) geoNeeds.set(geoKey("locality", r.record.locality), { level: "locality", name: r.record.locality });
  for (const r of leases) geoNeeds.set(geoKey("locality", r.record.locality), { level: "locality", name: r.record.locality });
  for (const r of markets) for (const o of r.record.observations) geoNeeds.set(geoKey("micro_market", o.geography_raw), { level: "micro_market", name: o.geography_raw });
  const geoRes = await resolveKeys(ctx, "geography", [...geoNeeds.keys()]);
  await insertIgnore(ctx.db, "geography", [...geoNeeds].filter(([k]) => geoRes.get(k)!.created).map(([k, g]) => stamp(ctx, { id: geoRes.get(k)!.id, level: g.level, name: g.name })));
  for (const [k, g] of geoNeeds) alias("geography", geoRes.get(k)!.id, g.name, exactKey(g.name));

  // ---- building masters (one master per exact building|locality key; many observations)
  const assetPayload = new Map<string, Record<string, unknown>>();
  const rank = (l: string) => (l === "existing" ? 0 : l === "ready_snapshot" ? 1 : 2);
  const sortedObs = [...assetsObs].sort((a, b) => rank(a.record.sourceTabLabel) - rank(b.record.sourceTabLabel));
  for (const r of sortedObs) {
    const o = r.record;
    const k = assetKey(o.building_name, o.locality);
    if (assetPayload.has(k)) continue;
    const floors = o.floors_text && /^\d+$/.test(o.floors_text.trim()) ? Number(o.floors_text.trim()) : null;
    assetPayload.set(k, {
      name: o.building_name, asset_kind: "building", locality_id: geoRes.get(geoKey("locality", o.locality))!.id, status: assetStatus(o.status_raw),
      total_area_sf: o.total_area_sf, total_area_source_zero: o.total_area_source_zero, floor_size_min_sf: o.floor_size_min_sf,
      floor_size_max_sf: o.floor_size_max_sf, floor_size_text: o.floor_size_text, floors, natural_key: k,
    });
  }
  for (const r of leases) {
    const k = assetKey(r.record.building_name, r.record.locality);
    if (!assetPayload.has(k)) {
      assetPayload.set(k, { name: r.record.building_name, asset_kind: "building", locality_id: geoRes.get(geoKey("locality", r.record.locality))!.id, natural_key: k });
    }
  }
  const assetRes = await resolveKeys(ctx, "asset", [...assetPayload.keys()]);
  await insertIgnore(ctx.db, "asset", [...assetPayload].filter(([k]) => assetRes.get(k)!.created).map(([k, p]) => stamp(ctx, { id: assetRes.get(k)!.id, ...p })));
  for (const [k, p] of assetPayload) alias("asset", assetRes.get(k)!.id, String(p.name), canonicalBuilding(p.name));
  // transactions only LINK to known buildings (never create building masters from tracker labels)
  const txAssetKeys = txs.filter((r) => r.record.building_name && r.record.locality).map((r) => assetKey(r.record.building_name!, r.record.locality!));
  const knownTxAssets = new Map<string, string>();
  {
    const kids = [...new Set(txAssetKeys)].filter((k) => !assetRes.has(k));
    const found = await selectIn<{ natural_key: string; entity_id: string }>(ctx.db, ctx.ws, "import_entity_key", "id", kids.map((k) => detId(ctx.ws, "key:asset", k)), "natural_key, entity_id");
    for (const f of found) knownTxAssets.set(f.natural_key, f.entity_id);
    for (const [k, r] of assetRes) knownTxAssets.set(k, r.id);
  }

  // ---- organisation masters (exact name key only; similar names go to the review queue, never auto-merged)
  const orgNames = new Map<string, string>();
  for (const r of leases) orgNames.set(exactKey(r.record.tenant_name), r.record.tenant_name);
  for (const r of txs) {
    orgNames.set(exactKey(r.record.tenant_name), r.record.tenant_name);
    if (r.record.operator_name) orgNames.set(exactKey(r.record.operator_name), r.record.operator_name);
  }
  const orgRes = await resolveKeys(ctx, "organisation", [...orgNames.keys()]);
  await insertIgnore(ctx.db, "organisation", [...orgNames].filter(([k]) => orgRes.get(k)!.created).map(([k, name]) => stamp(ctx, {
    id: orgRes.get(k)!.id, display_name: name, source_confidence: "import_name_only",
  })));
  for (const [k, name] of orgNames) alias("organisation", orgRes.get(k)!.id, name, canonicalOrg(name));

  // ---- leases + lease events (lease and lock-in rows of one agreement share a lease; events stay distinct)
  const leaseGroups = new Map<string, (StagedRowDraft & { record: LeaseRecord })[]>();
  for (const r of leases) (leaseGroups.get(r.record.identity_key) ?? leaseGroups.set(r.record.identity_key, []).get(r.record.identity_key)!).push(r);
  const leaseIds = new Map([...leaseGroups.keys()].map((k) => [k, detId(ctx.ws, "lease", k)]));
  const existingLeases = await existingIds(ctx, "lease", [...leaseIds.values()]);
  const leaseRows: Record<string, unknown>[] = [];
  const eventRows: Record<string, unknown>[] = [];
  const eventIds: string[] = [];
  for (const [k, rows] of leaseGroups) {
    const id = leaseIds.get(k)!;
    const first = rows[0].record;
    const lease = rows.find((r) => r.record.eventKind === "expiry")?.record;
    const lock = rows.find((r) => r.record.eventKind === "lockin_end")?.record;
    if (!existingLeases.has(id)) {
      leaseRows.push(stamp(ctx, {
        id, tenant_org_id: orgRes.get(exactKey(first.tenant_name))!.id, tenant_name_raw: first.tenant_name,
        asset_id: assetRes.get(assetKey(first.building_name, first.locality))!.id, area_sf: first.area_sf, rent_per_sf: first.rent_per_sf,
        registration_date: first.registration_date, start_date: first.start_date, start_precision: "day",
        tenure_months_raw: lease?.tenure_months ?? null, lockin_months_raw: lock?.tenure_months ?? null,
        status: "unknown", fact_status: "historical_observed", source_object_id: ctx.src,
      }));
    }
    const seenKinds = new Set<string>();
    for (const r of rows) {
      const rec = r.record;
      const evId = detId(ctx.ws, "lease_event", `${k}|${rec.eventKind}`);
      addT(r.locator, { type: "lease", id, role: "observation", created: !existingLeases.has(id) });
      addT(r.locator, { type: "organisation", id: orgRes.get(exactKey(rec.tenant_name))!.id, role: "master", created: orgRes.get(exactKey(rec.tenant_name))!.created });
      addT(r.locator, { type: "asset", id: assetRes.get(assetKey(rec.building_name, rec.locality))!.id, role: "master", created: assetRes.get(assetKey(rec.building_name, rec.locality))!.created });
      addT(r.locator, { type: "lease_event", id: evId, role: "observation", created: false });
      if (seenKinds.has(rec.eventKind) || r.status === "duplicate") continue;
      seenKinds.add(rec.eventKind);
      eventIds.push(evId);
      const mismatch = r.flags.includes("formula_cache_mismatch");
      const reasons = [
        !rec.tenure_is_integer ? `Fractional tenure ${rec.tenure_months} months: no date derived; confirm the intended tenure` : null,
        mismatch ? `Source cached expiry ${rec.source_expiry_cached_date} differs from independent calculation ${rec.calculated_event_date}` : null,
      ].filter(Boolean);
      eventRows.push(stamp(ctx, {
        id: evId, lease_id: id, event_type: rec.eventKind, event_date: rec.calculated_event_date, date_basis: "calculated_from_source_tenure",
        formula_raw: rec.source_expiry_formula ? `${rec.source_expiry_formula} [cached: ${rec.source_expiry_cached ?? "none"}]` : (rec.source_expiry_cached !== null ? `[value: ${rec.source_expiry_cached}]` : null),
        needs_review: reasons.length > 0, review_reason: reasons.join("; ") || null, engine_version: LEASE_ENGINE_VERSION, source_object_id: ctx.src,
      }));
    }
  }
  const existingEvents = await existingIds(ctx, "lease_event", eventIds);
  await insertIgnore(ctx.db, "lease", leaseRows);
  await insertIgnore(ctx.db, "lease_event", eventRows.filter((e) => !existingEvents.has(e.id as string)));
  bumpObs(observations, "lease", true, leaseRows.length);
  bumpObs(observations, "lease", false, leaseGroups.size - leaseRows.length);
  bumpObs(observations, "lease_event", true, eventIds.filter((i) => !existingEvents.has(i)).length);
  bumpObs(observations, "lease_event", false, eventIds.filter((i) => existingEvents.has(i)).length);
  for (const list of targets.values()) for (const t of list) if (t.type === "lease_event") t.created = !existingEvents.has(t.id);

  // ---- historical market transactions (not live leads)
  const txIds = txs.map((r) => detId(ctx.ws, "market_transaction", r.record.identity_key));
  const existingTx = await existingIds(ctx, "market_transaction", txIds);
  const txRows: Record<string, unknown>[] = [];
  const txSeen = new Set<string>();
  txs.forEach((r, i) => {
    const rec = r.record;
    const id = txIds[i];
    const tenant = orgRes.get(exactKey(rec.tenant_name))!;
    const operator = rec.operator_name ? orgRes.get(exactKey(rec.operator_name)) : undefined;
    const assetId = rec.building_name && rec.locality ? knownTxAssets.get(assetKey(rec.building_name, rec.locality)) ?? null : null;
    addT(r.locator, { type: "market_transaction", id, role: "observation", created: !existingTx.has(id) });
    addT(r.locator, { type: "organisation", id: tenant.id, role: "master", created: tenant.created });
    if (operator) addT(r.locator, { type: "organisation", id: operator.id, role: "master", created: operator.created, via: "operator" });
    if (assetId) addT(r.locator, { type: "asset", id: assetId, role: "master", created: false, via: "exact_key_link" });
    if (existingTx.has(id) || txSeen.has(id) || r.status === "duplicate") return;
    txSeen.add(id);
    txRows.push(stamp(ctx, {
      id, tenant_org_id: tenant.id, tenant_name_raw: rec.tenant_name, asset_id: assetId, deal_type: rec.deal_type,
      period_start: rec.period_start, period_end: rec.period_end, period_precision: rec.period_precision, area_sf: rec.area_sf, seats: rec.seats,
      rent_min: rec.rent_min, rent_max: rec.rent_max, rent_basis: rec.rent_basis, broker_name_raw: rec.broker_name_raw, source_object_id: ctx.src,
      extras: { ...rec.extras, layout: rec.layout, building_name_raw: rec.building_name, locality_raw: rec.locality, operator_name_raw: rec.operator_name, operator_org_id: operator?.id ?? null, locator: r.locator },
    }));
  });
  await insertIgnore(ctx.db, "market_transaction", txRows);
  bumpObs(observations, "market_transaction", true, txRows.length);
  bumpObs(observations, "market_transaction", false, new Set(txIds).size - txRows.length);

  // ---- market observations (one per non-blank geography x period cell)
  const moRows: Record<string, unknown>[] = [];
  const moIds: string[] = [];
  for (const r of markets) {
    for (const o of r.record.observations) {
      const gid = geoRes.get(geoKey("micro_market", o.geography_raw))!.id;
      const id = detId(ctx.ws, "market_observation", [o.metric, exactKey(o.geography_raw), o.period_start, o.period_type, o.unit, o.value, o.definition].join("|"));
      moIds.push(id);
      addT(r.locator, { type: "market_observation", id, role: "observation", created: true });
      if (r.status === "duplicate") continue;
      moRows.push(stamp(ctx, {
        id, metric: o.metric, geography_id: gid, geography_raw: o.geography_raw, period_start: o.period_start, period_end: o.period_end,
        period_type: o.period_type, unit: o.unit, value: o.value, definition: o.definition, source_object_id: ctx.src, source_version: ctx.sourceVersion,
      }));
    }
  }
  const existingMo = await existingIds(ctx, "market_observation", moIds);
  const moNew = moRows.filter((m) => !existingMo.has(m.id as string));
  await insertIgnore(ctx.db, "market_observation", moNew);
  for (const list of targets.values()) for (const t of list) if (t.type === "market_observation") t.created = !existingMo.has(t.id);
  bumpObs(observations, "market_observation", true, new Set(moNew.map((m) => m.id)).size);
  bumpObs(observations, "market_observation", false, new Set(moIds.filter((i) => existingMo.has(i))).size);

  // ---- building observations (each source row of each version is its own observation)
  const aoRows: Record<string, unknown>[] = [];
  const aoIds = assetsObs.map((r) => detId(ctx.ws, "asset_observation", `${ctx.src}|${r.locator}`));
  const existingAo = await existingIds(ctx, "asset_observation", aoIds);
  assetsObs.forEach((r, i) => {
    const o = r.record;
    const a = assetRes.get(assetKey(o.building_name, o.locality))!;
    const id = aoIds[i];
    addT(r.locator, { type: "asset", id: a.id, role: "master", created: a.created });
    addT(r.locator, { type: "asset_observation", id, role: "observation", created: !existingAo.has(id) });
    if (existingAo.has(id)) return;
    aoRows.push(stamp(ctx, {
      id, asset_id: a.id, source_object_id: ctx.src, staged_row_id: detId(ctx.ws, "staged_row", `${ctx.batchId}|${r.sheet}|${r.row_number}`),
      locator: r.locator, source_tab_label: o.sourceTabLabel, building_name_raw: o.building_name, locality_raw: o.locality,
      floor_size_text: o.floor_size_text, floor_size_min_sf: o.floor_size_min_sf, floor_size_max_sf: o.floor_size_max_sf,
      total_area_sf: o.total_area_sf, total_area_source_zero: o.total_area_source_zero, floors_text: o.floors_text, status_raw: o.status_raw,
      transactions_count: o.transactions_count, avg_rent: o.avg_rent, rent_basis: null, as_of: o.as_of, fact_status: "historical_observed",
      extras: { duplicate_row: r.status === "duplicate" },
    }));
  });
  await insertIgnore(ctx.db, "asset_observation", aoRows);
  bumpObs(observations, "asset_observation", true, aoRows.length);
  bumpObs(observations, "asset_observation", false, aoIds.length - aoRows.length);

  // ---- aliases (deduplicated by deterministic id)
  const aliasMap = new Map(aliases.map((a) => [a.id as string, a]));
  await insertIgnore(ctx.db, "entity_alias", [...aliasMap.values()]);

  // ---- master counts (distinct entities, separate from observation counts)
  const distinct = new Map<string, Target>();
  for (const list of targets.values()) for (const t of list) if (t.role === "master") distinct.set(`${t.type}|${t.id}`, t);
  for (const t of distinct.values()) bump(masters, t.type, t.created);
  for (const [k, r] of geoRes) bump(masters, "geography", r.created && !!k);
  let linked = 0;
  for (const list of targets.values()) if (list.some((t) => t.role === "master" && !t.created)) linked++;

  // ---- identity candidates for masters first created by this source (review queue; never auto-merged)
  const newAssets = [...assetRes].filter(([, r]) => r.created).map(([k, r]) => ({ id: r.id, name: String(assetPayload.get(k)!.name), locality: k.split("|")[1] ?? "" }));
  const newOrgs = [...orgRes].filter(([, r]) => r.created).map(([k, r]) => ({ id: r.id, name: orgNames.get(k)! }));
  let candidates = 0;
  const candRows: Record<string, unknown>[] = [];
  if (newAssets.length) {
    const pool = (await selectAll<{ id: string; name: string; natural_key: string | null; lat: number | null; lon: number | null }>(ctx.db, ctx.ws, "asset", "id, name, natural_key, lat, lon", { isNull: ["archived_at"] }))
      .map((a) => ({ id: a.id, name: a.name, locality: (a.natural_key ?? "").split("|")[1] ?? "", lat: a.lat, lon: a.lon }));
    for (const c of findCandidates(newAssets, pool, scoreBuilding, (x) => buildingBlock(x.name, x.locality), ctx.thresholds)) {
      candRows.push(stamp(ctx, {
        id: detId(ctx.ws, "identity_match_candidate", `asset|${[c.left.id, c.right.id].sort().join("|")}`), batch_id: ctx.batchId, entity_type: "asset",
        left_id: c.left.id, right_id: c.right.id, right_raw: { name: c.right.name, locality: c.right.locality, left_name: c.left.name },
        score: c.score.score, evidence: { ...c.score.evidence, hard_agree: c.score.hardAgree, decision_band: c.decision }, suggested: c.score.suggested, decision: "pending",
      }));
    }
  }
  if (newOrgs.length) {
    const pool = (await selectAll<{ id: string; display_name: string; legal_name: string | null; cin: string | null; gstin: string | null; domain: string | null }>(
      ctx.db, ctx.ws, "organisation", "id, display_name, legal_name, cin, gstin, domain", { isNull: ["archived_at"] }))
      .map((o) => ({ id: o.id, name: o.display_name, legal_name: o.legal_name, cin: o.cin, gstin: o.gstin, domain: o.domain }));
    for (const c of findCandidates(newOrgs, pool, scoreOrganisation, (x) => orgBlock(x.name), ctx.thresholds)) {
      candRows.push(stamp(ctx, {
        id: detId(ctx.ws, "identity_match_candidate", `organisation|${[c.left.id, c.right.id].sort().join("|")}`), batch_id: ctx.batchId, entity_type: "organisation",
        left_id: c.left.id, right_id: c.right.id, right_raw: { name: c.right.name, left_name: c.left.name },
        score: c.score.score, evidence: { ...c.score.evidence, hard_agree: c.score.hardAgree, decision_band: c.decision }, suggested: c.score.suggested, decision: "pending",
      }));
    }
  }
  await insertIgnore(ctx.db, "identity_match_candidate", candRows);
  candidates = candRows.length;

  return { targets, stats: { masters, observations, rows_linked_to_existing_master: linked, match_candidates: candidates }, issues: extraIssues };
}

async function loadMappings(db: Db, ws: string): Promise<ApprovedMapping[]> {
  const { data, error } = await db.from("adapter_mapping").select("id, adapter, sheet_role, schema_signature, header_row, positional, column_map, version")
    .eq("workspace_id", ws).eq("approved", true).is("archived_at", null);
  if (error) throw error;
  return (data ?? []) as ApprovedMapping[];
}

interface SourceObjectRow { id: string; file_name: string | null; sha256: string; version: number; uri: string | null; meta: Record<string, unknown> | null }

async function downloadOriginal(db: Db, ws: string, sourceObjectId: string): Promise<{ bytes: Uint8Array; so: SourceObjectRow }> {
  const { data: so, error } = await db.from("source_object").select("id, file_name, sha256, version, uri, meta").eq("workspace_id", ws).eq("id", sourceObjectId).single<SourceObjectRow>();
  if (error) throw error;
  const path = (so.meta?.storage_path as string | undefined) ?? String(so.uri ?? "").replace(`storage://${BUCKET}/`, "");
  if (!path.startsWith(`${ws}/`)) throw new Error("source object path is outside this workspace");
  const dl = await db.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) throw new Error(`could not read original: ${dl.error?.message ?? "missing"}`);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  if (sha256Hex(bytes) !== so.sha256) throw new Error("stored original does not match its recorded SHA-256; refusing to process");
  return { bytes, so };
}

export interface ProcessResult {
  status: "skipped" | "paused" | "completed" | "completed_with_exceptions" | "needs_mapping" | "failed";
  batchId: string;
  counts?: Reconciliation;
  error?: string;
}

/**
 * Process one batch. Claims it with an optimistic status/row_version check so the inline run and the job never
 * process the same batch concurrently. `allowFrom` lists the statuses that may be (re)processed.
 */
export async function processBatch(
  db: Db,
  args: { workspaceId: string; batchId: string; allowFrom?: string[] },
): Promise<ProcessResult> {
  const ws = args.workspaceId;
  const allow = args.allowFrom ?? ["registered"];
  const { data: batch, error: be } = await db.from("import_batch").select("*").eq("workspace_id", ws).eq("id", args.batchId).maybeSingle();
  if (be) throw be;
  if (!batch) throw new ImportError(404, "batch not found");
  const stale = batch.status === "processing" && batch.processing_started_at && Date.now() - Date.parse(batch.processing_started_at) > 15 * 60_000;
  if (!allow.includes(batch.status) && !stale) return { status: "skipped", batchId: batch.id };

  try {
    await assertIngestionAllowed(db, ws);
  } catch (e) {
    if (e instanceof IngestionPausedError) {
      await db.from("import_batch").update({ error: `Not processed: ${e.message}` }).eq("workspace_id", ws).eq("id", batch.id);
      return { status: "paused", batchId: batch.id, error: e.message };
    }
    throw e;
  }

  const { data: claimed } = await db.from("import_batch")
    .update({ status: "processing", processing_started_at: new Date().toISOString(), attempt: (batch.attempt ?? 0) + 1, error: null })
    .eq("workspace_id", ws).eq("id", batch.id).eq("row_version", batch.row_version).select("id").maybeSingle();
  if (!claimed) return { status: "skipped", batchId: batch.id };

  try {
    const { bytes, so } = await downloadOriginal(db, ws, batch.source_object_id);
    const wb = await parseFile(bytes, so.file_name ?? batch.file_name);
    const settings = await loadImportSettings(db, ws);
    const options = (batch.options ?? {}) as { as_of?: string | null; period_year?: number | null; classification?: string };
    const opts: AdapterOptions = { as_of: options.as_of ?? null, period_year: options.period_year ?? null, file_name: batch.file_name, size_rules: settings.sizeRules };
    const detections = detectWorkbook(wb, await loadMappings(db, ws));
    const mapped = mapWorkbook(wb, detections, opts);
    const rowsBySheet = new Map(wb.sheets.map((s) => [s.name, new Map<number, ParsedRow>(s.rows.map((r) => [r.rowNumber, r]))]));
    const staged = buildStaged(mapped, rowsBySheet);
    markDuplicates(staged);

    const ctx: Ctx = {
      db, ws, batchId: batch.id, src: batch.source_object_id, owner: batch.created_by ?? batch.owner_user_id ?? null,
      classification: options.classification ?? batch.classification ?? "corporate_confidential",
      sourceVersion: `${so.file_name ?? batch.file_name}@v${so.version}#${String(so.sha256).slice(0, 12)}`, thresholds: settings.thresholds,
    };
    const { targets, stats } = await writeRecords(ctx, staged);

    // staged rows (every considered row, with locator, raw cells + formula text, mapping and targets)
    await upsertMerge(db, "staged_row", staged.map((r) => stamp(ctx, {
      id: detId(ws, "staged_row", `${batch.id}|${r.sheet}|${r.row_number}`), batch_id: batch.id, source_object_id: ctx.src,
      sheet: r.sheet, row_number: r.row_number, locator: r.locator, raw_json: r.raw_json, row_hash: r.row_hash, status: r.status, reason: r.reason,
      flags: r.flags, mapped_json: r.record ? { ...r.record, adapter: r.adapter, role: r.role } : null, targets: targets.get(r.locator) ?? [],
    })));

    // exception queue: row issues + sheet issues + failed controls
    const exc: Record<string, unknown>[] = [];
    const addExc = (locator: string | null, sheet: string | null, stagedId: string | null, i: RowIssue) => {
      exc.push(stamp(ctx, {
        id: detId(ws, "import_exception", `${batch.id}|${locator ?? sheet ?? ""}|${i.kind}`), batch_id: batch.id, staged_row_id: stagedId, sheet, locator,
        kind: i.kind, severity: i.severity, message: i.message, details: i.details ?? {}, status: "open",
      }));
    };
    for (const r of staged) for (const i of r.issues) addExc(r.locator, r.sheet, detId(ws, "staged_row", `${batch.id}|${r.sheet}|${r.row_number}`), i);
    const controls: ControlCheck[] = [];
    for (const m of mapped) {
      for (const i of m.result.issues) addExc(null, m.detection.sheet, null, i);
      controls.push(...m.result.controls);
      for (const c of m.result.controls.filter((c) => !c.ok)) {
        addExc(c.locator, c.sheet, null, { kind: "control_mismatch", severity: "review", message: `Control ${c.name}: expected ${c.expected}, computed ${c.actual} (${c.note ?? ""})`, details: { ...c } });
      }
    }
    const excById = new Map(exc.map((e) => [e.id as string, e]));
    await insertIgnore(db, "import_exception", [...excById.values()]);
    // exceptions from an earlier run of this batch that no longer apply (e.g. mapping now approved) are resolved
    const { data: open } = await db.from("import_exception").select("id").eq("workspace_id", ws).eq("batch_id", batch.id).eq("status", "open");
    const staleIds = (open ?? []).map((o: { id: string }) => o.id).filter((id: string) => !excById.has(id));
    for (const part of chunk(staleIds, 150)) {
      await db.from("import_exception").update({ status: "resolved", resolution_note: "Cleared by re-processing", resolved_at: new Date().toISOString() })
        .eq("workspace_id", ws).in("id", part);
    }
    const { count: openCount } = await db.from("import_exception").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("batch_id", batch.id)
      .eq("status", "open").in("severity", ["review", "blocking"]);

    // diff against the previous version of the same source
    let diff = null;
    if (batch.previous_batch_id) {
      const prevRows = await selectAll<{ sheet: string; locator: string; row_hash: string; identity_key: string | null; fields: Record<string, unknown> | null }>(
        db, ws, "staged_row", "sheet, locator, row_hash, identity_key:mapped_json->>identity_key, fields:mapped_json->fields", { eq: { batch_id: batch.previous_batch_id } });
      const toDiff = (r: { sheet: string; locator: string; row_hash: string; identity_key: string | null; fields: Record<string, unknown> | null }): DiffRow => ({
        key: diffKey(r.sheet, r.identity_key, r.row_hash), sheet: r.sheet, identity_key: r.identity_key ?? "", row_hash: r.row_hash, fields: r.fields, locator: r.locator,
      });
      diff = diffVersions(batch.previous_batch_id, prevRows.map(toDiff), staged.map((r) => toDiff({
        sheet: r.sheet, locator: r.locator, row_hash: r.row_hash, identity_key: r.record?.identity_key ?? null, fields: (r.record?.fields as Record<string, unknown>) ?? null,
      })));
    }

    const counts = reconcile(staged, detections, controls, stats, openCount ?? 0);
    const mappedSheets = detections.filter((d) => d.status === "mapped");
    const unknown = detections.filter((d) => d.status === "unknown");
    const status: ProcessResult["status"] =
      unknown.length && !mappedSheets.length ? "needs_mapping" : (openCount ?? 0) > 0 || unknown.length ? "completed_with_exceptions" : "completed";
    const adapters = [...new Set(mappedSheets.map((d) => d.adapter))];
    await db.from("import_batch").update({
      status, adapter: adapters.join(",") || null,
      adapter_version: [...new Set(mappedSheets.map((d) => `${d.adapter}@${d.adapterVersion}`))].join(",") || null,
      mapping_version: [...new Set(mappedSheets.map((d) => (d.mappingSource === "approved_mapping" ? `mapping:${d.mappingId}@${d.mappingVersion}` : `builtin:${d.adapter}@${d.adapterVersion}`)))].join(",") || null,
      sheets: detections.map(sheetSummary), counts, diff, finished_at: new Date().toISOString(), error: null,
    }).eq("workspace_id", ws).eq("id", batch.id);
    return { status, batchId: batch.id, counts };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("import_batch").update({ status: "failed", error: msg.slice(0, 2000), finished_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", batch.id);
    return { status: "failed", batchId: batch.id, error: msg };
  }
}

function sheetSummary(d: SheetDetection) {
  return {
    sheet: d.sheet, status: d.status, adapter: d.adapter, adapter_version: d.adapterVersion, role: d.role, header_row: d.headerRow,
    signature: d.signature, mapping_source: d.mappingSource, mapping_id: d.mappingId, mapping_version: d.mappingVersion,
    column_map: d.columnMap, unlabeled_columns: d.unlabeledColumns, headers: d.headers.slice(0, 60), extra_columns: d.extraColumns,
    suggestions: d.suggestions, rows_considered: d.rowsConsidered, layout_rows: d.layoutRows,
  };
}

/* ------------------------------------------------------------------ 3. mapping review */

export interface ApproveMappingInput {
  batchId: string;
  sheet: string;
  adapter: string;
  role: string;
  columnMap: Record<string, number>;
  positional: boolean;
  headerRow: number;
  name?: string;
  note?: string;
}

/** Save an APPROVED adapter_mapping for the sheet's schema signature (a human decision, never automatic). */
export async function approveMapping(db: Db, ws: string, userId: string, input: ApproveMappingInput) {
  const role = getRole(input.adapter, input.role);
  if (!role || !role.fields) throw new ImportError(400, "unknown adapter role (or role is not column-mappable)");
  const { data: batch } = await db.from("import_batch").select("id, sheets").eq("workspace_id", ws).eq("id", input.batchId).maybeSingle();
  if (!batch) throw new ImportError(404, "batch not found");
  const sheet = (batch.sheets as ReturnType<typeof sheetSummary>[]).find((s) => s.sheet === input.sheet);
  if (!sheet) throw new ImportError(400, "sheet not found in batch");
  if (sheet.status !== "unknown") throw new ImportError(409, "sheet is already mapped");
  const cols = Object.entries(input.columnMap).filter(([k, v]) => role.fields!.some((f) => f.key === k) && Number.isInteger(v) && v >= 0);
  const columnMap = Object.fromEntries(cols);
  const missing = role.fields.filter((f) => f.required && columnMap[f.key] === undefined).map((f) => f.label);
  if (missing.length) throw new ImportError(400, `required fields not mapped: ${missing.join(", ")}`);
  if (new Set(Object.values(columnMap)).size !== Object.values(columnMap).length) throw new ImportError(400, "a column is mapped to two fields");
  const positional = input.positional || sheet.header_row === 0;
  const { data: prev } = await db.from("adapter_mapping").select("version").eq("workspace_id", ws).eq("schema_signature", sheet.signature)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  const adapter = getAdapter(input.adapter)!;
  const { data, error } = await db.from("adapter_mapping").insert({
    workspace_id: ws, owner_user_id: userId,
    name: input.name || `${adapter.label} — ${input.sheet}`, adapter: input.adapter, sheet_role: input.role, schema_signature: sheet.signature,
    header_row: positional ? 0 : sheet.header_row, positional, column_map: columnMap, sample_headers: sheet.headers ?? [],
    version: (prev?.version ?? 0) + 1, approved: true, approved_by: userId, approved_at: new Date().toISOString(),
    note: input.note ?? (positional ? "Approved positional map: first row is data" : null),
  }).select("*").single();
  if (error) throw error;
  return data;
}

/* ------------------------------------------------------------------ 4. identity review */

export type MatchDecision = "link" | "keep_separate" | "related";

export async function decideMatch(db: Db, ws: string, userId: string, candidateId: string, decision: MatchDecision) {
  const { data: c } = await db.from("identity_match_candidate").select("*").eq("workspace_id", ws).eq("id", candidateId).maybeSingle();
  if (!c) throw new ImportError(404, "candidate not found");
  if (c.decision !== "pending") throw new ImportError(409, `already decided (${c.decision})`);
  const now = new Date().toISOString();
  let proposalId: string | null = null;
  let newDecision: string = "kept_separate";
  if (decision === "link") {
    if (c.entity_type === "person" && !c.evidence?.hard_agree) throw new ImportError(400, "people are never merged on name alone");
    if (c.evidence?.different_towers) throw new ImportError(400, "different towers are never merged");
    if (c.suggested === "relate_group" || c.suggested === "relate_campus") throw new ImportError(400, "group/subsidiary and campus/tower pairs are related, not merged");
    const p = await proposeChange(db, ws, {
      targetType: c.entity_type, targetId: c.left_id, operation: "merge",
      patch: [{ op: "replace", path: "/loser_id", value: c.right_id }],
      reason: `Import identity review: merge ${c.right_raw?.name ?? c.right_id} into ${c.right_raw?.left_name ?? c.left_id} (score ${c.score})`,
      evidenceIds: [], proposedByKind: "user", idempotencyKey: `imports.merge:${c.id}`, ownerUserId: userId,
    });
    proposalId = p.id;
    newDecision = "merge_proposed";
  } else if (decision === "related") {
    if (c.entity_type === "organisation") {
      const p = await proposeChange(db, ws, {
        targetType: "organisation_relation", operation: "link",
        patch: [
          { op: "add", path: "/from_org_id", value: c.right_id },
          { op: "add", path: "/to_org_id", value: c.left_id },
          { op: "add", path: "/relation_type", value: "affiliate" },
        ],
        reason: `Import identity review: ${c.right_raw?.name ?? "organisation"} related to ${c.right_raw?.left_name ?? "organisation"} (group/subsidiary, not merged)`,
        proposedByKind: "user", idempotencyKey: `imports.relate:${c.id}`, ownerUserId: userId,
      });
      proposalId = p.id;
    } else if (c.entity_type === "asset") {
      const leftScope = (c.evidence?.scope?.[0] ?? []) as string[];
      const [campus, tower] = leftScope.length === 0 ? [c.left_id, c.right_id] : [c.right_id, c.left_id];
      const { data: t } = await db.from("asset").select("row_version").eq("workspace_id", ws).eq("id", tower).maybeSingle();
      const p = await proposeChange(db, ws, {
        targetType: "asset", targetId: tower, operation: "update", expectedVersion: t?.row_version ?? null,
        patch: [{ op: "replace", path: "/parent_asset_id", value: campus }],
        reason: "Import identity review: tower linked to its campus (not merged)", proposedByKind: "user", idempotencyKey: `imports.relate:${c.id}`, ownerUserId: userId,
      });
      proposalId = p.id;
    } else throw new ImportError(400, "related is only available for organisations and buildings");
    newDecision = "related";
  }
  const { error } = await db.from("identity_match_candidate").update({
    decision: newDecision, change_proposal_id: proposalId, decided_by: userId, decided_at: now,
  }).eq("workspace_id", ws).eq("id", c.id).eq("row_version", c.row_version);
  if (error) throw error;
  return { decision: newDecision, changeProposalId: proposalId };
}

/* ------------------------------------------------------------------ 5. exception queue */

export async function resolveException(db: Db, ws: string, userId: string, id: string, status: "resolved" | "dismissed", note: string | null) {
  const { data, error } = await db.from("import_exception").update({
    status, resolution_note: note, resolved_by: userId, resolved_at: new Date().toISOString(),
  }).eq("workspace_id", ws).eq("id", id).eq("status", "open").select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new ImportError(409, "exception is not open (or not visible)");
  return data;
}

/* ------------------------------------------------------------------ 6. reads for pages / API */

export async function getReconciliation(db: Db, ws: string, batchId: string) {
  const { data: b, error } = await db.from("import_batch")
    .select("id, file_name, status, adapter, adapter_version, mapping_version, counts, diff, sheets, error, created_at, finished_at, previous_batch_id, source_object_id, options")
    .eq("workspace_id", ws).eq("id", batchId).maybeSingle();
  if (error) throw error;
  if (!b) throw new ImportError(404, "batch not found");
  const { data: so } = await db.from("source_object").select("id, file_name, sha256, version, previous_version_id, retrieved_at").eq("workspace_id", ws).eq("id", b.source_object_id).maybeSingle();
  return { batch: b, source: so };
}
