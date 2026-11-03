/**
 * Closing coordinator services: per-item owner / due date / dependency edits (user, RLS) and the overdue / blocked
 * alert run (job, service role — every query filters workspace_id explicitly, S2). Alerts are in-app only (outbox via
 * notify + a deduped task); nothing is sent externally (S3).
 */
import type { Db } from "@/lib/supabase/server";
import { chunkKeys } from "@/modules/brief/keys";
import { notify } from "@/modules/brief/db";
import { type DealsCtx, DealsError, dbError, must } from "../ctx";
import { closingAlerts, dependencyTimeline, isCleared, outstandingDocuments, wouldCycle, type MilestoneLite } from "./closing";
import { feeLedger } from "../fees/ledger";
import { dealReconExceptions } from "../fees/recon-service";

export const MILESTONE_STATUSES = ["open", "in_progress", "done", "blocked", "waived", "not_applicable"] as const;

export interface MilestoneEdit {
  status?: string; proofText?: string | null; dueDate?: string | null; assigneeUserId?: string | null; ownerNote?: string | null; dependsOn?: string | null;
}

export async function updateMilestoneDetails(ctx: DealsCtx, milestoneId: string, p: MilestoneEdit) {
  const m = must(await ctx.db.from("deal_milestone").select("*").eq("id", milestoneId).maybeSingle(), "milestone") as MilestoneLite & { opportunity_id: string; proof_text: string | null };
  const patch: Record<string, unknown> = {};
  if (p.dueDate !== undefined) {
    if (p.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new DealsError(400, "due date must be yyyy-mm-dd");
    patch.due_date = p.dueDate || null;
  }
  if (p.assigneeUserId !== undefined) patch.assignee_user_id = p.assigneeUserId || null;
  if (p.ownerNote !== undefined) patch.owner_note = p.ownerNote?.trim() || null;
  if (p.proofText !== undefined) patch.proof_text = p.proofText?.trim() || null;
  const siblings = ((await ctx.db.from("deal_milestone").select("id, title, status, depends_on").eq("opportunity_id", m.opportunity_id)).data ?? []) as { id: string; title: string; status: string; depends_on: string | null }[];
  if (p.dependsOn !== undefined) {
    const dep = p.dependsOn || null;
    if (dep && !siblings.some((s) => s.id === dep)) throw new DealsError(400, "dependency must be an item of the same deal");
    if (wouldCycle(siblings, milestoneId, dep)) throw new DealsError(422, "that dependency would create a cycle");
    patch.depends_on = dep;
  }
  if (p.status !== undefined && p.status !== m.status) {
    if (!(MILESTONE_STATUSES as readonly string[]).includes(p.status)) throw new DealsError(400, "unknown status");
    if (p.status === "done") {
      const proof = (p.proofText !== undefined ? p.proofText : m.proof_text) ?? "";
      if (m.proof_required && !proof.trim()) throw new DealsError(422, "this item needs proof (document name, email reference, signed copy)");
      const depId = (patch.depends_on as string | null | undefined) !== undefined ? (patch.depends_on as string | null) : m.depends_on;
      const dep = depId ? siblings.find((s) => s.id === depId) : null;
      if (dep && !isCleared(dep.status)) throw new DealsError(422, `blocked: waiting on "${dep.title}"`);
      patch.completed_at = new Date().toISOString();
    }
    patch.status = p.status;
  }
  if (!Object.keys(patch).length) return m;
  if (patch.status === "done") patch.completed_by = ctx.userId;
  const r = await ctx.db.from("deal_milestone").update(patch).eq("id", milestoneId).select("*").single();
  if (r.error) throw dbError(r.error, "milestone");
  return r.data;
}

/** Members for the owner picker (display name falls back to a short id — never an invented name). */
export async function workspaceMembers(ctx: DealsCtx): Promise<{ userId: string; name: string }[]> {
  const r = await ctx.db.from("membership").select("user_id, display_name, role").eq("workspace_id", ctx.workspaceId);
  return ((r.data ?? []) as { user_id: string; display_name: string | null }[]).map((m) => ({ userId: m.user_id, name: m.display_name ?? `user ${m.user_id.slice(0, 8)}` }));
}

// ---------------------------------------------------------------- job side
/**
 * Raise overdue / blocked alerts for one workspace. Idempotent: the outbox row and the task share a dedupe key per
 * milestone + condition (+ due date), so re-running the same day — or any later day for the same condition — adds nothing.
 */
export async function runClosingAlerts(admin: Db, workspaceId: string, asOf: string): Promise<{ alerts: number; tasksCreated: number }> {
  const { data: opps, error } = await admin.from("opportunity").select("id, name, classification, owner_user_id, account_owner_user_id, outcome")
    .eq("workspace_id", workspaceId).is("archived_at", null).in("outcome", ["open", "won"]).limit(5000);
  if (error) throw error;
  if (!opps?.length) return { alerts: 0, tasksCreated: 0 };
  const oppById = new Map(opps.map((o: { id: string }) => [o.id, o as { id: string; name: string; classification: string; owner_user_id: string | null; account_owner_user_id: string | null }]));
  const ms: MilestoneLite[] = [];
  const ids = [...oppById.keys()];
  for (let i = 0; i < ids.length; i += 100) { // UUID lists travel in the URL: 100 per request stays under the gateway URI limit
    const { data, error: e2 } = await admin.from("deal_milestone").select("id, opportunity_id, title, kind, status, due_date, depends_on, required_for_stage, proof_required, assignee_user_id, sort_order")
      .eq("workspace_id", workspaceId).is("archived_at", null).in("opportunity_id", ids.slice(i, i + 100));
    if (e2) throw e2;
    ms.push(...((data ?? []) as MilestoneLite[]));
  }
  const byOpp = new Map<string, MilestoneLite[]>();
  for (const m of ms) byOpp.set(m.opportunity_id!, [...(byOpp.get(m.opportunity_id!) ?? []), m]);
  const alerts = [...byOpp.values()].flatMap((list) => closingAlerts(list, asOf));
  if (!alerts.length) return { alerts: 0, tasksCreated: 0 };
  const existing = new Set<string>();
  const keys = alerts.map((a) => a.dedupeKey);
  // Long dedupe keys: split by encoded length (a fixed 200-key chunk exceeds the URI limit), and fail loudly on error.
  for (const part of chunkKeys(keys)) {
    const { data, error: e3 } = await admin.from("task").select("idempotency_key").eq("workspace_id", workspaceId).in("idempotency_key", part);
    if (e3) throw e3;
    for (const r of data ?? []) existing.add(r.idempotency_key as string);
  }
  let tasksCreated = 0;
  for (const a of alerts) {
    const opp = oppById.get(a.opportunityId!)!;
    const userId = a.assigneeUserId ?? opp.account_owner_user_id ?? opp.owner_user_id;
    await notify(admin, workspaceId, userId, "deals.closing_alert", a.dedupeKey, {
      kind: a.kind, title: `${a.kind === "overdue" ? "Overdue" : "Blocked"} closing item — ${opp.name}`, message: a.message,
      opportunityId: opp.id, milestoneId: a.milestoneId, href: `/deals/${opp.id}`,
    });
    if (existing.has(a.dedupeKey)) continue;
    const ins = await admin.from("task").insert({
      workspace_id: workspaceId, classification: opp.classification, owner_user_id: userId, assigned_user_id: userId,
      title: `${a.kind === "overdue" ? "Chase" : "Unblock"}: ${a.title} — ${opp.name}`, description: a.message,
      priority: a.kind === "overdue" ? 80 : 75, due_at: new Date(`${asOf}T12:00:00+05:30`).toISOString(), status: "open",
      linked_entity_type: "opportunity", linked_entity_id: opp.id, source: "workflow", idempotency_key: a.dedupeKey,
    });
    if (ins.error && ins.error.code !== "23505") throw ins.error;
    if (!ins.error) tasksCreated++;
  }
  return { alerts: alerts.length, tasksCreated };
}

/** Everything /deals/[id] needs for the closing coordinator and the revenue view of one deal. */
export async function getClosingView(ctx: DealsCtx, opportunityId: string, asOf: string) {
  const opp = must(await ctx.db.from("opportunity").select("id, name, stage, outcome, expected_fee, credit_share, expected_close, crm_external_id, requirement_id").eq("id", opportunityId).maybeSingle(), "opportunity") as { id: string; name: string; stage: string; requirement_id: string | null };
  const [ms, fees, docs, members, recon, closeHist] = await Promise.all([
    ctx.db.from("deal_milestone").select("*").eq("opportunity_id", opportunityId).is("archived_at", null).order("sort_order"),
    ctx.db.from("fee_milestone").select("*").eq("opportunity_id", opportunityId).is("archived_at", null).order("created_at"),
    opp.requirement_id
      ? ctx.db.from("document_version").select("id, purpose, status, family_id, version_no, input_versions, created_at").eq("linked_entity_type", "requirement").eq("linked_entity_id", opp.requirement_id).is("archived_at", null)
      : Promise.resolve({ data: [] as never[] }),
    workspaceMembers(ctx),
    dealReconExceptions(ctx, opportunityId),
    ctx.db.from("opportunity_close_history").select("old_expected_close, new_expected_close, changed_at, stage").eq("opportunity_id", opportunityId).order("changed_at", { ascending: false }).limit(20),
  ]);
  const milestones = (ms.data ?? []) as MilestoneLite[];
  return {
    timeline: dependencyTimeline(milestones, asOf),
    outstanding: outstandingDocuments(milestones, (docs.data ?? []) as never[], asOf),
    members, recon, closeHistory: closeHist.data ?? [],
    ledger: feeLedger(opp as never, (fees.data ?? []) as never[]),
  };
}
