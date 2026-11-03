import "server-only";
import type { Db } from "@/lib/supabase/server";
import { ChangeError, MATERIAL_FIELDS, proposeChange } from "@/lib/services/changes";
import { createTask } from "@/lib/services/tasks";
import { notify } from "@/modules/brief/db";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

/**
 * Database Steward (workflow 02): field-level conflict report, "why do we believe this" provenance, and freshness.
 * Deterministic code only. Conflicts are never auto-applied; a fix is a change proposal carrying the source evidence.
 */

const ENTITY_TABLES = new Set(["organisation", "person", "asset", "lease", "lease_event", "requirement", "opportunity", "availability",
  "employment", "contact_method", "quote", "fee_milestone", "market_transaction", "stakeholder", "space"]);
const LABEL_COLS = ["display_name", "full_name", "name", "title", "tenant_name_raw", "event_type", "value"];
const label = (r: AnyRow | null | undefined) => (r ? (LABEL_COLS.map((c) => r[c]).find((v) => typeof v === "string" && v) as string | undefined) ?? null : null);
const same = (a: unknown, b: unknown) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  const na = Number(a), nb = Number(b);
  if (typeof a !== "boolean" && Number.isFinite(na) && Number.isFinite(nb) && String(a) !== "" && String(b) !== "") return na === nb;
  return JSON.stringify(a) === JSON.stringify(b) || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};
function assertEntity(type: string) {
  if (!ENTITY_TABLES.has(type)) throw new ChangeError("invalid_parameter", `unsupported record type ${type}`);
}

// ------------------------------------------------------------------ conflict report

export interface ConflictView {
  id: string; entity_type: string; entity_id: string; entity_label: string | null; field: string; material: boolean;
  master_value_then: unknown; master_value_now: unknown; source_value: unknown; source_label: string | null; source_locator: string | null;
  observed_at: string; status: string; change_proposal_id: string | null; proposal_state: string | null; still_disagrees: boolean;
  staged_row_id: string | null; source_object_id: string | null;
}

/** Every field where a source observation disagrees with the master value (both values, source, date). */
export async function listConflicts(db: Db, ws: string, opts: { status?: "open" | "all"; entityType?: string; entityId?: string; limit?: number } = {}): Promise<ConflictView[]> {
  let q = db.from("field_conflict").select("*").eq("workspace_id", ws).is("archived_at", null);
  if ((opts.status ?? "open") === "open") q = q.in("status", ["open", "proposed"]);
  if (opts.entityType) q = q.eq("entity_type", opts.entityType);
  if (opts.entityId) q = q.eq("entity_id", opts.entityId);
  const { data, error } = await q.order("observed_at", { ascending: false }).limit(opts.limit ?? 200);
  if (error) throw error;
  const rows = (data ?? []) as AnyRow[];
  const byType = new Map<string, string[]>();
  for (const r of rows) if (ENTITY_TABLES.has(r.entity_type)) byType.set(r.entity_type, [...(byType.get(r.entity_type) ?? []), r.entity_id]);
  const cache = new Map<string, AnyRow>();
  for (const [t, ids] of byType) {
    const { data: recs } = await db.from(t).select("*").eq("workspace_id", ws).in("id", [...new Set(ids)]);
    for (const rec of recs ?? []) cache.set(`${t}:${rec.id}`, rec);
  }
  const pids = rows.map((r) => r.change_proposal_id).filter(Boolean);
  const states = new Map<string, string>();
  if (pids.length) {
    const { data: ps } = await db.from("change_proposal").select("id, state").eq("workspace_id", ws).in("id", pids);
    for (const p of ps ?? []) states.set(p.id, p.state);
  }
  const out: ConflictView[] = [];
  const nowAgree: string[] = [];
  for (const r of rows) {
    const rec = cache.get(`${r.entity_type}:${r.entity_id}`);
    if (!rec) continue;                                   // not visible to this user (RLS) or gone
    const now = rec[r.field];
    const disagrees = !same(r.source_value, now);
    if (!disagrees && r.status !== "dismissed" && r.status !== "resolved") nowAgree.push(r.id);
    out.push({
      id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, entity_label: label(rec), field: r.field, material: r.material,
      master_value_then: r.master_value, master_value_now: now ?? null, source_value: r.source_value, source_label: r.source_label, source_locator: r.source_locator,
      observed_at: r.observed_at, status: disagrees ? r.status : "resolved", change_proposal_id: r.change_proposal_id,
      proposal_state: r.change_proposal_id ? states.get(r.change_proposal_id) ?? null : null, still_disagrees: disagrees,
      staged_row_id: r.staged_row_id, source_object_id: r.source_object_id,
    });
  }
  // the master now matches the source (fix applied or edited) => the conflict is resolved
  if (nowAgree.length) {
    await db.from("field_conflict").update({ status: "resolved", resolution_note: "Record now matches the source value", resolved_at: new Date().toISOString() })
      .eq("workspace_id", ws).in("id", nowAgree).in("status", ["open", "proposed"]);
  }
  return (opts.status ?? "open") === "open" ? out.filter((c) => c.still_disagrees && c.status !== "dismissed") : out;
}

/** "Propose fix": a change proposal setting the master to the source value, with the staged row + file as evidence. */
export async function proposeConflictFix(db: Db, ws: string, conflictId: string, opts: { actorUserId?: string | null } = {}) {
  const { data: c } = await db.from("field_conflict").select("*").eq("workspace_id", ws).eq("id", conflictId).maybeSingle();
  if (!c) throw new ChangeError("not_found", "conflict");
  if (!["open", "proposed"].includes(c.status)) throw new ChangeError("invalid_state", `conflict is ${c.status}`);
  assertEntity(c.entity_type);
  const { data: rec } = await db.from(c.entity_type).select("*").eq("workspace_id", ws).eq("id", c.entity_id).maybeSingle();
  if (!rec) throw new ChangeError("not_found", "record");
  if (same(c.source_value, rec[c.field])) throw new ChangeError("invalid_state", "the record already matches the source");
  const p = await proposeChange(db, ws, {
    targetType: c.entity_type, targetId: c.entity_id, operation: "update", expectedVersion: Number(rec.row_version),
    patch: [{ op: "replace", path: `/${c.field}`, value: c.source_value }],
    reason: `Conflict fix: ${label(rec) ?? c.entity_type} ${c.field} ${JSON.stringify(rec[c.field] ?? null)} → ${JSON.stringify(c.source_value)} per ${c.source_label ?? "source"} ${c.source_locator ?? ""}`.trim(),
    evidenceIds: [c.staged_row_id, c.source_object_id].filter(Boolean), proposedByKind: "user", idempotencyKey: `imports.conflict:${c.id}`,
    classification: rec.classification, ownerUserId: rec.owner_user_id ?? null, actorUserId: opts.actorUserId ?? null,
  });
  await db.from("field_conflict").update({ status: "proposed", change_proposal_id: p.id }).eq("workspace_id", ws).eq("id", c.id);
  return p;
}

/** The master value is right: keep it, close the conflict with a note (history kept). */
export async function dismissConflict(db: Db, ws: string, userId: string, conflictId: string, note: string | null) {
  const { data, error } = await db.from("field_conflict").update({ status: "dismissed", resolution_note: note?.slice(0, 1000) || "Record value kept", resolved_by: userId, resolved_at: new Date().toISOString() })
    .eq("workspace_id", ws).eq("id", conflictId).in("status", ["open", "proposed"]).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new ChangeError("not_found", "open conflict");
  return data;
}

// ------------------------------------------------------------------ provenance ("why do we believe this")

export interface EvidenceItem { id: string; kind: "file" | "staged_row" | "capture" | "source" | "unknown"; label: string; locator: string | null; excerpt: string | null; at: string | null; href: string | null }
export interface FieldProvenance {
  field: string; value: unknown; material: boolean;
  changes: { proposal_id: string; state: string; operation: string; reason: string | null; at: string; proposed_by_kind: string; evidence: EvidenceItem[] }[];
  origin: EvidenceItem[];
  conflicts: ConflictView[];
  traceable: boolean;
}

async function resolveEvidence(db: Db, ws: string, ids: string[]): Promise<Map<string, EvidenceItem>> {
  const out = new Map<string, EvidenceItem>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const [so, sr, cap] = await Promise.all([
    db.from("source_object").select("id, kind, file_name, version, uri, retrieved_at").eq("workspace_id", ws).in("id", uniq),
    db.from("staged_row").select("id, batch_id, sheet, locator, raw_json, created_at").eq("workspace_id", ws).in("id", uniq),
    db.from("capture").select("id, kind, raw_text, transcript, source_at").eq("workspace_id", ws).in("id", uniq),
  ]);
  for (const s of so.data ?? []) out.set(s.id, { id: s.id, kind: s.kind === "file" ? "file" : "source", label: `${s.file_name ?? s.uri ?? s.kind}${s.version ? ` v${s.version}` : ""}`, locator: null, excerpt: null, at: s.retrieved_at, href: null });
  for (const r of sr.data ?? []) {
    const cells = Object.entries((r.raw_json ?? {}) as Record<string, { v: unknown }>).slice(0, 8).map(([k, v]) => `${k}: ${v?.v ?? ""}`).join(" · ");
    out.set(r.id, { id: r.id, kind: "staged_row", label: `Import row ${r.locator}`, locator: r.locator, excerpt: cells.slice(0, 400), at: r.created_at, href: r.batch_id ? `/imports/${r.batch_id}` : null });
  }
  for (const c of cap.data ?? []) out.set(c.id, { id: c.id, kind: "capture", label: `Capture (${c.kind})`, locator: null, excerpt: String(c.transcript ?? c.raw_text ?? "").slice(0, 400), at: c.source_at, href: `/capture/${c.id}` });
  for (const id of uniq) if (!out.has(id)) out.set(id, { id, kind: "unknown", label: "Evidence not visible to you (or removed)", locator: null, excerpt: null, at: null, href: null });
  return out;
}

const SKIP_FIELDS = new Set(["id", "workspace_id", "classification", "owner_user_id", "created_at", "updated_at", "row_version", "archived_at", "search", "value_hash", "natural_key"]);

/** Per-field provenance for one record: applied changes with their evidence, import origin, open conflicts. */
export async function recordProvenance(db: Db, ws: string, type: string, id: string) {
  assertEntity(type);
  const { data: rec } = await db.from(type).select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!rec) throw new ChangeError("not_found", "record");
  const [{ data: props }, { data: staged }, { data: keys }] = await Promise.all([
    db.from("change_proposal").select("id, operation, patch, state, reason, evidence_ids, proposed_by_kind, updated_at, capture_id, applied_audit_id")
      .eq("workspace_id", ws).eq("target_type", type).eq("target_id", id).is("reversal_of", null).in("state", ["applied", "proposed", "approved", "clarify"])
      .order("applied_audit_id", { ascending: true, nullsFirst: false }).limit(200),
    db.from("staged_row").select("id").eq("workspace_id", ws).contains("targets", JSON.stringify([{ id }])).order("created_at").limit(5),
    db.from("import_entity_key").select("first_source_object_id").eq("workspace_id", ws).eq("entity_id", id).limit(3),
  ]);
  const originIds = [...(staged ?? []).map((s: AnyRow) => s.id), ...(keys ?? []).map((k: AnyRow) => k.first_source_object_id), rec.source_object_id].filter(Boolean);
  const ev = await resolveEvidence(db, ws, [...originIds, ...(props ?? []).flatMap((p: AnyRow) => p.evidence_ids ?? [])]);
  const conflicts = await listConflicts(db, ws, { entityType: type, entityId: id });
  const material = new Set(MATERIAL_FIELDS[type] ?? []);
  const origin = [...new Set(originIds)].map((x) => ev.get(x)!).filter(Boolean);
  const fields: FieldProvenance[] = Object.keys(rec).filter((f) => !SKIP_FIELDS.has(f)).map((f) => {
    const changes = (props ?? []).filter((p: AnyRow) => (p.patch as { path: string }[]).some((o) => o.path.replace(/^\//, "").split("/")[0] === f))
      .map((p: AnyRow) => ({ proposal_id: p.id, state: p.state, operation: p.operation, reason: p.reason, at: p.updated_at, proposed_by_kind: p.proposed_by_kind,
        evidence: (p.evidence_ids ?? []).map((x: string) => ev.get(x)!).filter(Boolean) }));
    const applied = changes.filter((c) => c.state === "applied");
    const hasValue = rec[f] !== null && rec[f] !== undefined && !(Array.isArray(rec[f]) && rec[f].length === 0);
    const traceable = !hasValue || applied.some((c) => c.evidence.length > 0) || origin.length > 0;
    return { field: f, value: rec[f], material: material.has(f), changes, origin: applied.length ? [] : origin, conflicts: conflicts.filter((c) => c.field === f), traceable };
  });
  const freshness = ["organisation", "person", "asset", "availability"].includes(type) ? await getFreshness(db, ws, type, id) : null;
  return {
    record: { type, id, label: label(rec), classification: rec.classification, created_at: rec.created_at, updated_at: rec.updated_at },
    fields: fields.filter((f) => f.material || f.changes.length || f.conflicts.length || (f.value !== null && f.value !== undefined && f.value !== "" && !(typeof f.value === "object" && f.value && Object.keys(f.value).length === 0))),
    untraceableMaterial: fields.filter((f) => f.material && !f.traceable).map((f) => f.field),
    freshness,
  };
}

// ------------------------------------------------------------------ freshness / stale-record detector

export const DEFAULT_WINDOWS = { organisation: 180, person: 180, asset: 365, availability: 45 } as const;
export type Windows = Partial<Record<keyof typeof DEFAULT_WINDOWS, number>>;
export const WINDOWS_SETTING = "steward.freshness_windows";

export async function loadWindows(db: Db, ws: string): Promise<Windows> {
  const { data } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", WINDOWS_SETTING).maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  const out: Windows = { ...DEFAULT_WINDOWS };
  for (const k of Object.keys(DEFAULT_WINDOWS) as (keyof typeof DEFAULT_WINDOWS)[]) {
    if (typeof v[k] === "number" && Number.isFinite(v[k])) out[k] = Math.max(0, Math.round(v[k] as number));
  }
  return out;
}

/** Page size for the stale-candidate RPC (must not exceed PostgREST max_rows = 1000). */
export const STALE_PAGE = 1000;

const TYPE_LABEL: Record<string, string> = { organisation: "company", person: "person", asset: "building", availability: "availability" };

/**
 * Stale-record detector (job imports.steward_stale, service role; every query filters workspace_id). Flags records whose
 * key facts were not verified within the window, creates ONE review task per record per verification state
 * (dedupe key includes the last-verified date), and clears flags for records verified since.
 */
export async function runStaleDetector(admin: Db, ws: string, opts: { now?: Date; windows?: Windows; maxTasks?: number; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? await loadWindows(admin, ws);
  const limit = opts.limit ?? 2000;
  // PostgREST returns at most max_rows (1000) rows per response: page through the (totally ordered) candidates, otherwise
  // records beyond the first 1000 are never flagged and the "refreshed" pass below wrongly marks them fresh.
  type Cand = { entity_type: string; entity_id: string; label: string; owner_user_id: string | null; classification: string; last_verified_at: string; basis: string; window_days: number };
  const cands: Cand[] = [];
  for (let from = 0; from < limit; from += STALE_PAGE) {
    const to = Math.min(from + STALE_PAGE, limit) - 1;
    const { data, error } = await admin.schema("mudar_app").rpc("steward_stale_candidates", { p_ws: ws, p_windows: windows, p_now: now.toISOString(), p_limit: limit }).range(from, to);
    if (error) throw error;
    cands.push(...((data ?? []) as Cand[]));
    if ((data ?? []).length < to - from + 1) break;
  }
  const prev: AnyRow[] = []; // paged too: one response is capped at 1000 rows
  for (let from = 0; ; from += STALE_PAGE) {
    const { data, error: pe } = await admin.from("record_freshness").select("id, entity_type, entity_id, status, stale_since, task_id").eq("workspace_id", ws)
      .order("id").range(from, from + STALE_PAGE - 1);
    if (pe) throw pe;
    prev.push(...(data ?? []));
    if ((data ?? []).length < STALE_PAGE) break;
  }
  const prevBy = new Map((prev ?? []).map((p: AnyRow) => [`${p.entity_type}:${p.entity_id}`, p]));
  const nowIso = now.toISOString();
  const rows = cands.map((c) => {
    const p = prevBy.get(`${c.entity_type}:${c.entity_id}`);
    return { workspace_id: ws, entity_type: c.entity_type, entity_id: c.entity_id, status: "stale", last_verified_at: c.last_verified_at, basis: c.basis,
      window_days: c.window_days, stale_since: p?.status === "stale" && p.stale_since ? p.stale_since : nowIso, owner_user_id: c.owner_user_id, classification: c.classification };
  });
  for (let i = 0; i < rows.length; i += 300) {
    const { error: ue } = await admin.from("record_freshness").upsert(rows.slice(i, i + 300), { onConflict: "workspace_id,entity_type,entity_id" });
    if (ue) throw ue;
  }
  // review tasks for the oldest first (deduped: re-runs and later days reuse the same task until the record is verified)
  let tasks = 0;
  const perOwner = new Map<string, number>();
  for (const c of cands.slice(0, opts.maxTasks ?? 50)) {
    const since = c.last_verified_at.slice(0, 10);
    const t = await createTask(admin, ws, {
      title: `Verify ${TYPE_LABEL[c.entity_type] ?? c.entity_type}: ${c.label}`.slice(0, 300),
      description: `Key facts not verified since ${since} (${c.basis.replace(/_/g, " ")}; window ${c.window_days} days). Confirm or correct the record, then mark it verified.`,
      linkedEntityType: c.entity_type, linkedEntityId: c.entity_id, source: "workflow", priority: 40,
      idempotencyKey: `steward:stale:${c.entity_type}:${c.entity_id}:${since}`, classification: c.classification,
      ownerUserId: c.owner_user_id, assignedUserId: c.owner_user_id,
    });
    tasks++;
    await admin.from("record_freshness").update({ task_id: t.id }).eq("workspace_id", ws).eq("entity_type", c.entity_type).eq("entity_id", c.entity_id);
    if (c.owner_user_id) perOwner.set(c.owner_user_id, (perOwner.get(c.owner_user_id) ?? 0) + 1);
  }
  // records that were stale but are now within their window
  let refreshed = 0;
  if (cands.length < limit) {
    const staleNow = new Set(cands.map((c) => `${c.entity_type}:${c.entity_id}`));
    const back = (prev ?? []).filter((p: AnyRow) => p.status === "stale" && !staleNow.has(`${p.entity_type}:${p.entity_id}`)).map((p: AnyRow) => p.id);
    for (let i = 0; i < back.length; i += 100) {
      await admin.from("record_freshness").update({ status: "fresh", stale_since: null }).eq("workspace_id", ws).in("id", back.slice(i, i + 100));
    }
    refreshed = back.length;
  }
  const day = nowIso.slice(0, 10);
  for (const [uid, n] of perOwner) {
    await notify(admin, ws, uid, "steward.stale", `steward.stale:${ws}:${uid}:${day}`, { count: n, href: "/approvals/stale" }).catch(() => undefined);
  }
  return { stale: cands.length, tasks, refreshed };
}

export async function getFreshness(db: Db, ws: string, type: string, id: string) {
  const { data } = await db.from("record_freshness").select("status, last_verified_at, basis, window_days, stale_since, task_id, verified_by, verified_note")
    .eq("workspace_id", ws).eq("entity_type", type).eq("entity_id", id).maybeSingle();
  return data ?? null;
}

export interface StaleRow { id: string; entity_type: string; entity_id: string; last_verified_at: string | null; basis: string | null; window_days: number | null; stale_since: string | null; task_id: string | null; label: string | null }
export async function listStale(db: Db, ws: string, limit = 200): Promise<StaleRow[]> {
  const { data, error } = await db.from("record_freshness").select("id, entity_type, entity_id, last_verified_at, basis, window_days, stale_since, task_id")
    .eq("workspace_id", ws).eq("status", "stale").is("archived_at", null).order("last_verified_at", { ascending: true }).limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as AnyRow[];
  const byType = new Map<string, string[]>();
  for (const r of rows) byType.set(r.entity_type, [...(byType.get(r.entity_type) ?? []), r.entity_id]);
  const labels = new Map<string, string | null>();
  for (const [t, ids] of byType) {
    const { data: recs } = await db.from(t).select("*").eq("workspace_id", ws).in("id", ids);
    for (const r of recs ?? []) labels.set(`${t}:${r.id}`, label(r) ?? (t === "availability" ? `${r.status} (as of ${r.as_of})` : null));
  }
  return rows.filter((r) => labels.has(`${r.entity_type}:${r.entity_id}`)).map((r) => ({ ...r, label: labels.get(`${r.entity_type}:${r.entity_id}`) ?? null }) as StaleRow);
}

/** A person confirmed the record's key facts: fresh again, and the open review task is closed. */
export async function markVerified(db: Db, ws: string, userId: string, type: string, id: string, note: string | null) {
  if (!["organisation", "person", "asset", "availability"].includes(type)) throw new ChangeError("invalid_parameter", "unsupported record type");
  const { data: rec } = await db.from(type).select("id, owner_user_id, classification").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!rec) throw new ChangeError("not_found", "record");
  const at = new Date().toISOString();
  const { error } = await db.from("record_freshness").upsert({
    workspace_id: ws, entity_type: type, entity_id: id, status: "fresh", last_verified_at: at, basis: "marked_verified", stale_since: null,
    verified_by: userId, verified_note: note?.slice(0, 500) || null, owner_user_id: rec.owner_user_id, classification: rec.classification,
  }, { onConflict: "workspace_id,entity_type,entity_id" });
  if (error) throw error;
  await db.from("task").update({ status: "done", completed_at: at, completion_evidence: `Marked verified${note ? `: ${note.slice(0, 200)}` : ""}` })
    .eq("workspace_id", ws).like("idempotency_key", `steward:stale:${type}:${id}:%`).in("status", ["open", "snoozed", "stale"]);
  return { status: "fresh", last_verified_at: at };
}
