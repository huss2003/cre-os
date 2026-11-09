"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import * as S from "./service";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof S.ContactError ? e.message : errorMessage(e) });
const done = (msg: string, ...paths: string[]): ActionState => { ["/contacts", ...paths].forEach((p) => revalidatePath(p)); return { ok: true, message: msg }; };

export async function discoverAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const org = s(f, "org_id"); if (!org) return { error: "Choose a company." };
    const r = await S.discoverCompany(ctx.db, ctx.workspaceId, org, { userId: ctx.userId, force: f.get("force") === "1" });
    if ("reused" in r && r.reused) return done("Already researched today — open it in History, or tick 'Run again'.");
    const x = r as { found: number; mocked: boolean };
    return done(x.mocked ? "Web research didn't run (see History for the reason). Your records were still checked." : `Found ${x.found} people. Review them in the Verification queue.`);
  } catch (e) { return fail(e); }
}
export async function enrichOneAction(personId: string, _p: ActionState): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const r = await S.enrichPerson(ctx.db, ctx.workspaceId, personId, { userId: ctx.userId }); return done(r.found ? `Found ${r.found} update(s) to review.` : "Checked. Channels re-verified; nothing new found.", `/contacts/${personId}`); }
  catch (e) { return fail(e); }
}
export async function bulkAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await S.enrichMany(ctx.db, ctx.workspaceId, { personIds: f.getAll("person_id").map(String), orgIds: f.getAll("org_id").map(String).filter(Boolean), web: f.get("web") === "1", userId: ctx.userId });
    return done(`Enriched ${r.done}${r.failed ? `, ${r.failed} failed` : ""}${r.left ? `, ${r.left} left — use Retry in History` : ""}${r.skippedDoNotContact ? `. Skipped ${r.skippedDoNotContact} marked do-not-contact` : ""}.`);
  } catch (e) { return fail(e); }
}
export async function retryAction(jobId: string, _p: ActionState): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.retryJob(ctx.db, ctx.workspaceId, jobId, ctx.userId); return done("Retried.", `/contacts/job/${jobId}`); }
  catch (e) { return fail(e); }
}
export async function approveAction(itemId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await S.approveItem(ctx.db, ctx.workspaceId, ctx.userId, itemId, s(f, "as") || null);
    return done(`Approved. ${r.proposals.length} change(s) recorded; anything needing an admin waits in Review.`, `/contacts/${r.personId}`);
  } catch (e) { return fail(e); }
}
export async function rejectAction(itemId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.rejectItem(ctx.db, ctx.workspaceId, ctx.userId, itemId, s(f, "reason")); return done("Rejected."); }
  catch (e) { return fail(e); }
}
export async function roleAction(personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.setRole(ctx.db, ctx.workspaceId, ctx.userId, personId, s(f, "role"), s(f, "relevance"), s(f, "reason")); return done("Role saved. Contact score recalculated.", `/contacts/${personId}`); }
  catch (e) { return fail(e); }
}
export async function confirmChannelAction(personId: string, methodId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.confirmChannel(ctx.db, ctx.workspaceId, methodId, s(f, "how")); return done("Marked as verified.", `/contacts/${personId}`); }
  catch (e) { return fail(e); }
}
export async function dncAction(personId: string, on: boolean, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.setDoNotContact(ctx.db, ctx.workspaceId, personId, on, s(f, "reason")); return done(on ? "Marked do-not-contact. All channels suppressed." : "Do-not-contact removed (channels stay suppressed until you re-enable them).", `/contacts/${personId}`); }
  catch (e) { return fail(e); }
}
export async function duplicateAction(personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.flagDuplicate(ctx.db, ctx.workspaceId, ctx.userId, s(f, "keep_id") || personId, s(f, "dup_id"), s(f, "reason")); return done("Merge proposed — an admin approves it in Review. It can be undone.", `/contacts/${personId}`, "/approvals"); }
  catch (e) { return fail(e); }
}
export async function managerAction(orgId: string, personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.setManager(ctx.db, ctx.workspaceId, ctx.userId, orgId, personId, s(f, "manager_id") || null, s(f, "note")); return done("Reporting line saved.", `/contacts/company/${orgId}`, `/contacts/${personId}`); }
  catch (e) { return fail(e); }
}
export async function taskAction(personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const title = s(f, "title"); if (!title) return { error: "Write the task." };
    const { error } = await ctx.db.from("task").insert({ workspace_id: ctx.workspaceId, title: title.slice(0, 300), linked_entity_type: "person", linked_entity_id: personId, assigned_user_id: ctx.userId, owner_user_id: ctx.userId, due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), priority: 50, source: "contacts" });
    if (error) throw error;
    return done("Task created.", `/contacts/${personId}`);
  } catch (e) { return fail(e); }
}
export async function interactionAction(personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const channel = s(f, "channel") || "note";
    const { data: i, error } = await ctx.db.from("interaction").insert({ workspace_id: ctx.workspaceId, occurred_at: s(f, "when") ? new Date(s(f, "when")).toISOString() : new Date().toISOString(), channel, subject: s(f, "subject") || null, summary: s(f, "summary") || null, is_meaningful: ["meeting", "call", "visit"].includes(channel), owner_user_id: ctx.userId }).select("id").single();
    if (error) throw error;
    await ctx.db.from("interaction_link").insert({ workspace_id: ctx.workspaceId, interaction_id: i.id, entity_type: "person", entity_id: personId, role: "participant", owner_user_id: ctx.userId });
    return done("Interaction logged. Scores update shortly.", `/contacts/${personId}`);
  } catch (e) { return fail(e); }
}
export async function archiveAction(personId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const { proposeChange } = await import("@/lib/services/changes");
    const { data: p } = await ctx.db.from("person").select("row_version").eq("id", personId).single();
    await proposeChange(ctx.db, ctx.workspaceId, { targetType: "person", targetId: personId, operation: "archive", expectedVersion: p?.row_version, patch: [], reason: s(f, "reason") || "Archived from contact profile", actorUserId: ctx.userId, proposedByKind: "user" } as never);
    return done("Archive proposed — confirm it in Review.", `/contacts/${personId}`, "/approvals");
  } catch (e) { return fail(e); }
}

export async function appointmentAction(_p: ActionState): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await S.appointmentScan(ctx.db, ctx.workspaceId, { userId: ctx.userId });
    return done(r.reused ? "Already scanned today — see History." : `Found ${r.found} appointment(s). Review them in To review.`);
  } catch (e) { return fail(e); }
}
export async function linkedinImportAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const file = f.get("file");
    if (!(file instanceof File) || !file.size) return { error: "Choose your Connections.csv file." };
    if (file.size > 5_000_000) return { error: "File is larger than 5 MB." };
    const r = await S.importLinkedIn(ctx.db, ctx.workspaceId, await file.text(), { userId: ctx.userId, onlyRelevant: f.get("relevant") === "1" });
    return done(`Imported ${r.imported} of ${r.total} connections into To review. Nothing is saved until you approve.`);
  } catch (e) { return fail(e); }
}
