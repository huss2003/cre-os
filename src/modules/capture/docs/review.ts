import "server-only";
import type { Db } from "@/lib/supabase/server";
import { hasRole, type Role } from "@/lib/auth/context";
import { createTask } from "@/lib/services/tasks";
import { ChangeError } from "@/lib/services/changes";
import { clarifyChange } from "@/modules/changes/service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Review (spec §12.4) attention queues beyond the proposal tabs. Each list shows only items needing action; counts on top.
 * Failed jobs are admin-only (job RLS + retry_job require admin).
 */
export interface AttentionQueues {
  documents: Row[];          // capture_document needing input / failed
  unverified: Row[];         // contact details not yet verified (recent first)
  drafts: number;            // outreach drafts awaiting approval (listed on tab=drafts)
  failedJobs: Row[] | null;  // null = not an admin
  companyMatches: Row[];     // identity_match_candidate organisation, pending
  duplicateContacts: Row[];  // identity_match_candidate person, pending
  needsInfo: Row[];          // proposals in 'clarify' (Request more info)
}

export async function listFailedJobs(db: Db, ws: string, limit = 50) {
  const { data, error } = await db.from("job").select("id, job_type, state, attempts, max_attempts, last_error, updated_at, payload")
    .eq("workspace_id", ws).in("state", ["failed", "dead"]).order("updated_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as Row[];
}

export async function retryJob(db: Db, ws: string, role: Role, jobId: string) {
  if (!hasRole({ role }, "admin")) throw new ChangeError("forbidden", "Only an admin can retry background jobs.");
  const { data } = await db.from("job").select("id").eq("workspace_id", ws).eq("id", jobId).maybeSingle();
  if (!data) throw new ChangeError("not_found", "job not found");
  const { error } = await db.schema("mudar_app").rpc("retry_job", { p_job: jobId });
  if (error) throw new ChangeError(error.code === "23505" ? "conflict" : "error", error.message);
}

export async function attentionQueues(db: Db, ws: string, role: Role): Promise<AttentionQueues> {
  const admin = hasRole({ role }, "admin");
  const [docs, unverified, drafts, jobs, cands, clar] = await Promise.all([
    db.from("capture_document").select("id, file_name, detected_type, status, error, created_at").eq("workspace_id", ws).is("archived_at", null)
      .in("status", ["needs_input", "failed"]).order("created_at", { ascending: false }).limit(50),
    db.from("contact_method").select("id, person_id, method_type, value, verify_status, source_name, created_at, person:person_id(full_name)").eq("workspace_id", ws)
      .is("archived_at", null).eq("suppressed", false).or("verify_status.is.null,verify_status.in.(unverified,unknown)").order("created_at", { ascending: false }).limit(25),
    db.from("draft").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("state", ["drafted", "approved"]).is("archived_at", null),
    admin ? listFailedJobs(db, ws) : Promise.resolve(null),
    db.from("identity_match_candidate").select("id, batch_id, entity_type, left_id, right_raw, score, suggested, created_at").eq("workspace_id", ws)
      .eq("decision", "pending").is("archived_at", null).in("entity_type", ["organisation", "person"]).order("score", { ascending: false }).limit(100),
    db.from("change_proposal").select("id, target_type, operation, reason, updated_at").eq("workspace_id", ws).eq("state", "clarify").is("archived_at", null)
      .order("updated_at", { ascending: false }).limit(50),
  ]);
  const c = (cands.data ?? []) as Row[];
  return {
    documents: (docs.data ?? []) as Row[],
    unverified: (unverified.data ?? []) as Row[],
    drafts: drafts.count ?? 0,
    failedJobs: jobs,
    companyMatches: c.filter((x) => x.entity_type === "organisation"),
    duplicateContacts: c.filter((x) => x.entity_type === "person"),
    needsInfo: (clar.data ?? []) as Row[],
  };
}

/**
 * "Request more info" on a proposal: the change_proposal state machine already has 'clarify' (approve_change decision),
 * so we use it (no new state) and add an internal task linked to the proposal. Re-requesting is idempotent per proposal.
 */
export async function requestMoreInfo(db: Db, ws: string, userId: string, proposalId: string, note: string) {
  const n = note.trim();
  if (!n) throw new ChangeError("invalid_parameter", "Say what information is missing.");
  const { data: p } = await db.from("change_proposal").select("id, target_type, operation, state, reason").eq("workspace_id", ws).eq("id", proposalId).maybeSingle();
  if (!p) throw new ChangeError("not_found", "proposal not found");
  if (!["proposed", "approved", "clarify"].includes(p.state as string)) throw new ChangeError("conflict", `This proposal is already ${p.state}.`);
  if (p.state !== "clarify") await clarifyChange(db, proposalId, { note: n });
  const task = await createTask(db, ws, {
    title: `More info needed: ${p.operation} ${p.target_type}`.slice(0, 200),
    description: `${n}\n\nProposal: ${String(p.reason ?? "").slice(0, 500)}`,
    linkedEntityType: "change_proposal", linkedEntityId: proposalId, source: "manual", ownerUserId: userId, assignedUserId: userId,
    idempotencyKey: `review:needs_info:${proposalId}`,
  });
  return { taskId: (task as Row).id as string };
}
