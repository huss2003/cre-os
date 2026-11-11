import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanText, fieldLabel, proposalHeadline } from "@/modules/changes/display";

type Client = SupabaseClient<any, any, any>;

export interface DbOverview {
  organisations: number; people: number; buildings: number; spaces: number; requirements: number; opportunities: number;
  leases: number; interactions: number; sources: number; pending_imports: number;
  identity_reviews: number; change_reviews: number; conflicts: number; import_exceptions: number;
}

/** One round-trip: record counts + review-queue sizes for the Database screen (RLS applies). */
export async function databaseOverview(db: Client, workspaceId: string): Promise<{ data: DbOverview | null; error: string | null }> {
  const { data, error } = await db.schema("mudar_app").rpc("database_overview", { ws: workspaceId });
  return { data: (data as DbOverview) ?? null, error: error?.message ?? null };
}

export interface ReviewItem { kind: "identity" | "exception" | "conflict" | "change"; label: string; detail: string; href: string; at: string | null }

/** Workspace-wide review queue: uncertain matches, import exceptions (missing fields, bad dates/units), contradictory values, proposed changes. */
export async function reviewQueue(db: Client, workspaceId: string, limit = 25): Promise<{ items: ReviewItem[]; failed: string[] }> {
  const [idm, exc, conf, chg] = await Promise.all([
    db.from("identity_match_candidate").select("id, batch_id, entity_type, score, right_raw, created_at")
      .eq("workspace_id", workspaceId).eq("decision", "pending").is("archived_at", null).order("score", { ascending: false }).limit(limit),
    db.from("import_exception").select("id, batch_id, kind, severity, message, locator, created_at")
      .eq("workspace_id", workspaceId).eq("status", "open").is("archived_at", null).order("created_at", { ascending: false }).limit(limit),
    db.from("field_conflict").select("id, entity_type, entity_id, field, created_at")
      .eq("workspace_id", workspaceId).eq("status", "open").is("archived_at", null).order("created_at", { ascending: false }).limit(limit),
    db.from("change_proposal").select("id, target_type, operation, state, reason, created_at")
      .eq("workspace_id", workspaceId).in("state", ["proposed", "clarify", "conflict"]).is("archived_at", null).order("created_at", { ascending: false }).limit(limit),
  ]);
  const failed: string[] = [];
  const items: ReviewItem[] = [];
  if (idm.error) failed.push("duplicate suggestions");
  for (const r of idm.data ?? []) {
    const name = (r.right_raw as Record<string, unknown>)?.name ?? (r.right_raw as Record<string, unknown>)?.display_name ?? "new record";
    items.push({ kind: "identity", label: `Possible duplicate ${String(r.entity_type).replace(/_/g, " ")}`, detail: `${String(name)} · match ${(Number(r.score) * 100).toFixed(0)}%`,
      href: r.batch_id ? `/imports/${r.batch_id}#identity` : "/imports", at: r.created_at });
  }
  if (exc.error) failed.push("import exceptions");
  for (const r of exc.data ?? []) items.push({ kind: "exception", label: humanKind(r.kind), detail: `${r.message ?? ""}${r.locator ? ` · ${r.locator}` : ""}`,
    href: r.batch_id ? `/imports/${r.batch_id}` : "/imports", at: r.created_at });
  if (conf.error) failed.push("contradictory values");
  for (const r of conf.data ?? []) items.push({ kind: "conflict", label: `Contradictory ${fieldLabel(String(r.field))}`, detail: `${String(r.entity_type).replace(/_/g, " ")} has two different sourced values`,
    href: "/approvals", at: r.created_at });
  if (chg.error) failed.push("proposed changes");
  for (const r of chg.data ?? []) items.push({ kind: "change", label: proposalHeadline(String(r.operation ?? "update"), String(r.target_type), String(r.state)), detail: cleanText(r.reason) || "No reason given",
    href: `/approvals`, at: r.created_at });
  items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return { items, failed };
}

const humanKind = (k: string | null) => (k ?? "issue").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export interface AuditRow { id: number; occurred_at: string; actor_user_id: string | null; actor_kind: string; action: string; entity_type: string; entity_id: string | null;
  changes: { field: string; before: unknown; after: unknown }[]; reason: string | null; evidence: string | null; change_proposal_id: string | null }

const SKIP = new Set(["updated_at", "row_version", "search", "created_at"]);

/** Recent audit events reduced to field-level before → after, with reason/evidence from the linked approval when there is one. */
export async function recentChanges(db: Client, workspaceId: string, limit = 20): Promise<{ rows: AuditRow[]; error: string | null }> {
  const { data, error } = await db.from("audit_event")
    .select("id, occurred_at, actor_user_id, actor_kind, action, entity_type, entity_id, before, after, change_proposal_id")
    .eq("workspace_id", workspaceId).order("occurred_at", { ascending: false }).limit(limit);
  if (error) return { rows: [], error: error.message };
  const cpIds = [...new Set((data ?? []).map((r) => r.change_proposal_id).filter(Boolean))] as string[];
  const cps = cpIds.length
    ? (await db.from("change_proposal").select("id, reason, evidence_ids").in("id", cpIds.slice(0, 100))).data ?? []
    : [];
  const cpMap = new Map(cps.map((c: any) => [c.id, c]));
  const rows = (data ?? []).map((r: any) => {
    const b = (r.before ?? {}) as Record<string, unknown>, a = (r.after ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !SKIP.has(k));
    const changes = r.action === "update"
      ? keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])).map((k) => ({ field: k, before: b[k] ?? null, after: a[k] ?? null }))
      : [];
    const cp = r.change_proposal_id ? cpMap.get(r.change_proposal_id) : null;
    return { id: r.id, occurred_at: r.occurred_at, actor_user_id: r.actor_user_id, actor_kind: r.actor_kind, action: r.action, entity_type: r.entity_type,
      entity_id: r.entity_id, changes, reason: cp?.reason ?? null, evidence: cp?.evidence_ids?.length ? `${cp.evidence_ids.length} source(s)` : null, change_proposal_id: r.change_proposal_id };
  });
  return { rows, error: null };
}
