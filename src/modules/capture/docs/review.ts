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

/** How many background jobs failed — visible to every member (details stay admin-only). */
export async function failedJobCount(db: Db, ws: string): Promise<number> {
  const { data, error } = await db.schema("mudar_app").rpc("failed_job_count", { p_workspace: ws });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Queued jobs overdue by more than `minutes` (count + oldest due time). Member-safe RPC; null when unavailable. */
export async function jobBacklog(db: Db, ws: string, minutes = 15): Promise<{ overdue: number; oldestDueAt: string | null } | null> {
  const { data, error } = await db.schema("mudar_app").rpc("job_backlog", { p_workspace: ws, p_overdue_minutes: minutes });
  if (error) return null;
  const r = (Array.isArray(data) ? data[0] : data) as { overdue: number | string; oldest_due_at: string | null } | undefined;
  return r ? { overdue: Number(r.overdue ?? 0), oldestDueAt: r.oldest_due_at ?? null } : null;
}

const JOB_WORDS: Record<string, string> = {
  "capture.process": "Reading a capture", "capture.document": "Processing an uploaded file", "imports.process": "Importing a spreadsheet",
  "imports.steward_stale": "Checking for stale records", "brief.recalc": "Rebuilding today's brief", "brief.replan": "Re-planning tasks",
  "brief.radar": "Lease expiry radar", "brief.caretaker": "Daily housekeeping", "brief.deadline_watch": "Deadline watch",
  "deals.rematch": "Matching buildings to a requirement", "deals.req_tasks": "Creating requirement tasks", "deals.concession_npv": "Concession NPV calculation",
  "intelligence.market_analysis": "Market analysis", "intelligence.strategy": "Strategy note", "intelligence.research": "Research",
  "intelligence.research_org": "Company research", "intelligence.patrol": "News patrol", "scoring.recalc": "Lead score update", "scoring.bulk": "Bulk lead scoring",
  "assistant.embed": "Indexing records for the assistant", "assistant.command": "Assistant command", "workflows.sweep": "Workflow check",
  "contacts.reverify": "Re-checking contact details", "outreach.sweep": "Outreach follow-ups", "signals.scan": "Signals scan",
  "meetings.remind": "Meeting reminder", "meetings.autobrief": "Meeting brief", "meetings.calendar": "Calendar sync",
  "integrations.sequence_tick": "Draft sequence step", "integrations.push_subscribe": "Push notifications", "integrations.calendar_conflicts": "Calendar conflicts",
  "admin.export": "Data export", "admin.restore_sample": "Sample data restore", "admin.retention_purge": "Retention clean-up", "tutorials.sync": "Tutorial sync",
};

/** Job type in plain words ("imports.process" → "Importing a spreadsheet"); unknown types are humanised, never hidden. */
export function jobLabel(type: string): string {
  if (JOB_WORDS[type]) return JOB_WORDS[type];
  const [mod, rest] = type.includes(".") ? type.split(/\.(.+)/) : ["", type];
  const words = String(rest ?? type).replace(/[_.:-]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${mod ? ` (${mod})` : ""}`;
}

/** First line of the error, trimmed — the full text stays in the job row. */
export function errorSummary(err: unknown, max = 160): string {
  const line = String(err ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || "No error message was recorded.";
}

const LINK_KEYS: [string, (id: string) => string, string][] = [
  ["document_id", (id) => `/capture/documents/${id}`, "Open file"], ["capture_document_id", (id) => `/capture/documents/${id}`, "Open file"],
  ["capture_id", (id) => `/capture/${id}`, "Open capture"], ["batch_id", (id) => `/imports/${id}`, "Open import"], ["import_batch_id", (id) => `/imports/${id}`, "Open import"],
  ["requirement_id", (id) => `/requirements/${id}`, "Open requirement"], ["opportunity_id", (id) => `/deals/${id}`, "Open deal"],
  ["org_id", (id) => `/companies/${id}`, "Open company"], ["organisation_id", (id) => `/companies/${id}`, "Open company"],
  ["person_id", (id) => `/people/${id}`, "Open person"], ["asset_id", (id) => `/buildings/${id}`, "Open building"],
  ["meeting_id", (id) => `/meetings/${id}`, "Open meeting"],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Link to the record a job was working on, when its payload names one. */
export function jobRecordLink(job: { job_type?: string; payload?: unknown }): { href: string; label: string } | null {
  const raw = (job.payload && typeof job.payload === "object" ? job.payload : {}) as Row;
  const p: Row = {};
  for (const [k, v] of Object.entries(raw)) p[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = v; // documentId → document_id
  for (const [k, href, label] of LINK_KEYS) if (typeof p[k] === "string" && UUID.test(p[k])) return { href: href(p[k]), label };
  if (typeof p.id === "string" && UUID.test(p.id)) {
    if (job.job_type === "capture.document") return { href: `/capture/documents/${p.id}`, label: "Open file" };
    if (job.job_type === "capture.process") return { href: `/capture/${p.id}`, label: "Open capture" };
    if (job.job_type === "imports.process") return { href: `/imports/${p.id}`, label: "Open import" };
  }
  return null;
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
