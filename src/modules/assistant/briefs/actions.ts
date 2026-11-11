"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { deliverMorningBrief, saveBriefSetting } from "./morning";
import { analyseNotes, approveNotes, discardNote, NoteError } from "../notes/service";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof NoteError ? e.message : errorMessage(e) });
const bc = (ctx: Awaited<ReturnType<typeof requireContext>>) => ({ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId, timezone: ctx.timezone });

/** Opt in/out of the automatic weekday morning brief and pick the time. */
export async function saveBriefSettingAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const enabled = s(f, "enabled") === "on" || s(f, "enabled") === "true";
    const r = await saveBriefSetting(bc(ctx), { enabled, time: s(f, "time") || "08:00" });
    revalidatePath("/home");
    return { ok: true, message: r.enabled ? `Morning brief on — weekdays at ${r.time_local} (${r.timezone}).` : "Morning brief off." };
  } catch (e) { return fail(e); }
}

/** Build today's brief now (idempotent per day) and open it. */
export async function runBriefNowAction(_p: ActionState, _f: FormData): Promise<ActionState> {
  let id: string | null = null;
  try {
    const ctx = await requireContext("editor");
    const r = await deliverMorningBrief(bc(ctx));
    id = r.conversationId;
  } catch (e) { return fail(e); }
  revalidatePath("/home");
  redirect(id ? `/assistant/${id}` : "/assistant");
}

export async function analyseNotesAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let id: string | null = null;
  try {
    const ctx = await requireContext("editor");
    const r = await analyseNotes(bc(ctx), { text: s(f, "notes"), meetingId: s(f, "meetingId") || null, orgId: s(f, "orgId") || null, requirementId: s(f, "requirementId") || null });
    id = r.note.id;
  } catch (e) { return fail(e); }
  redirect(`/assistant/notes?id=${id}`);
}

export async function approveNotesAction(noteId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const selected = f.getAll("p").filter((x): x is string => typeof x === "string");
    const r = await approveNotes(bc(ctx), noteId, selected);
    revalidatePath("/assistant/notes");
    const n = Object.keys(r.results.applied ?? {}).length, errs = Object.keys(r.results.errors ?? {}).length;
    return { ok: true, message: `${n} update${n === 1 ? "" : "s"} applied${errs ? `, ${errs} failed (see below)` : ""}. Record changes wait in Approvals.` };
  } catch (e) { return fail(e); }
}

export async function discardNoteAction(noteId: string, _p: ActionState, _f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await discardNote(bc(ctx), noteId); revalidatePath("/assistant/notes"); return { ok: true, message: "Discarded — nothing was saved." }; }
  catch (e) { return fail(e); }
}
