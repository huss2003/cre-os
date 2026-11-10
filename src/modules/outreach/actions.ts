"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { SuppressedRecipientError, DraftConflictError, DraftForbiddenError } from "@/lib/services/drafts";
import type { Channel, Scenario, Lang } from "./rules";
import * as S from "./service";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({
  error: e instanceof S.OutreachError ? e.message : e instanceof SuppressedRecipientError ? "This recipient is suppressed or has withdrawn consent — the message was paused."
    : e instanceof DraftConflictError ? "The message changed since you reviewed it. Review it again." : e instanceof DraftForbiddenError ? "You don't have permission to approve this." : errorMessage(e),
});
const done = (msg: string, id?: string): ActionState => { revalidatePath("/outreach"); if (id) revalidatePath(`/outreach/${id}`); return { ok: true, message: msg }; };

export async function createAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let first: string;
  try {
    const ctx = await requireContext("editor");
    const channels = f.getAll("channel").map(String) as Channel[];
    if (!channels.length) return { error: "Pick at least one channel." };
    const r = await S.createOutreach(ctx.db, ctx.workspaceId, ctx.userId, { personId: s(f, "person_id"), channels, scenario: (s(f, "scenario") || undefined) as Scenario | undefined, signalId: s(f, "signal_id") || null, language: (s(f, "language") || "en") as Lang, viaPersonId: s(f, "via") || null });
    first = r.ids[0];
  } catch (e) { return fail(e); }
  revalidatePath("/outreach");
  redirect(`/outreach/${first}`);
}
export async function saveAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.editItem(ctx.db, ctx.workspaceId, ctx.userId, id, { subject: f.has("subject") ? s(f, "subject") || null : undefined, body: String(f.get("body") ?? ""), recipientAddress: f.has("to") ? s(f, "to") || null : undefined, learn: f.get("learn") === "1" }); return done("Saved as a new version.", id); }
  catch (e) { return fail(e); }
}
export async function aiAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const op = s(f, "op") === "translate" ? s(f, "lang") || "english" : s(f, "op"); await S.aiEdit(ctx.db, ctx.workspaceId, ctx.userId, id, op); return done("Rewritten — the message above now shows the new version.", id); }
  catch (e) { return fail(e); }
}
export async function requestAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.requestApproval(ctx.db, ctx.workspaceId, ctx.userId, id); return done("Sent for approval.", id); }
  catch (e) { return fail(e); }
}
export async function approveAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.approve(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "hash")); return done("Approved for exactly this recipient and text.", id); }
  catch (e) { return fail(e); }
}
export async function rejectAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.reject(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "note")); return done("Sent back to draft.", id); }
  catch (e) { return fail(e); }
}
export async function openAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    if (f.get("ok_to") !== "1" || f.get("ok_text") !== "1") return { error: "Tick both boxes to confirm the recipient and the text." };
    const ctx = await requireContext("editor");
    const r = await S.openForSend(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "hash"));
    revalidatePath(`/outreach/${id}`);
    return { ok: true, message: r.href ? `OPEN:${r.href}` : "Copy the text and send it from your app, then press I sent it." };
  } catch (e) { return fail(e); }
}
export async function sentAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const r = await S.markSent(ctx.db, ctx.workspaceId, ctx.userId, id); return done(r.already ? "Already recorded." : "Recorded as sent. The next follow-up is planned and will pause automatically if they reply.", id); }
  catch (e) { return fail(e); }
}
export async function responseAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await S.recordResponse(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "text"));
    return done(`Reply saved (${r.outcome.replace(/_/g, " ")}). ${r.tasks.length ? `${r.tasks.length} task(s) created. ` : ""}${r.proposals.length ? "Deal update sent to Review. " : ""}Next: ${r.nextAction}`, id);
  } catch (e) { return fail(e); }
}
export async function pauseAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.pauseItem(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "reason")); return done("Paused.", id); }
  catch (e) { return fail(e); }
}
export async function resumeAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.resumeItem(ctx.db, ctx.workspaceId, ctx.userId, id); return done("Resumed.", id); }
  catch (e) { return fail(e); }
}
export async function prepareAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.prepareFollowup(ctx.db, ctx.workspaceId, ctx.userId, id); return done("Follow-up drafted.", id); }
  catch (e) { return fail(e); }
}
export async function closeAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.closeItem(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "outcome") === "no_response" ? "no_response" : "closed"); return done("Closed.", id); }
  catch (e) { return fail(e); }
}
export async function sweepAction(): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const r = await S.sweep(ctx.db, ctx.workspaceId); return done(`Checked ${r.checked}; paused ${r.paused}.`); }
  catch (e) { return fail(e); }
}
export async function restoreAction(id: string, version: number): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.restoreVersion(ctx.db, ctx.workspaceId, ctx.userId, id, version); return done(`Version ${version} restored.`, id); }
  catch (e) { return fail(e); }
}
