"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import * as S from "./service";
import * as M from "./more";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const fail = (e: unknown): ActionState => ({ error: e instanceof S.MeetingError ? e.message : errorMessage(e) });
const done = (msg: string, id?: string): ActionState => { revalidatePath("/meetings"); if (id) { revalidatePath(`/meetings/${id}`); revalidatePath(`/meetings/${id}/live`); } return { ok: true, message: msg }; };
const istIso = (d: string, t: string) => new Date(`${d}T${t || "10:00"}:00+05:30`).toISOString();

export async function createAction(_p: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor");
    const ext = s(f, "external").split(/\n|;/).map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/[^\s<>,]+@[^\s<>,]+/); return { email: m?.[0]?.toLowerCase() ?? null, name: l.replace(m?.[0] ?? "", "").replace(/[<>,]/g, "").trim() || null }; });
    const start = istIso(s(f, "date"), s(f, "time"));
    const r = await S.createMeeting(ctx.db, ctx.workspaceId, ctx.userId, { title: s(f, "title"), start, end: new Date(Date.parse(start) + Number(s(f, "minutes") || 60) * 6e4).toISOString(), location: s(f, "location") || null, type: s(f, "type") || undefined, purpose: s(f, "purpose") || null, orgId: s(f, "org_id") || null, opportunityId: s(f, "opportunity_id") || null, requirementId: s(f, "requirement_id") || null, assetIds: f.getAll("asset_id").map(String).filter(Boolean), personIds: f.getAll("person_id").map(String).filter(Boolean), external: ext, notes: s(f, "notes") || null });
    id = r.id;
    if (f.get("prepare") === "1") await S.generateBrief(ctx.db, ctx.workspaceId, ctx.userId, id).catch(() => null);
  } catch (e) { return fail(e); }
  revalidatePath("/meetings");
  redirect(`/meetings/${id}`);
}
export async function icsAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const file = f.get("file"); if (!(file instanceof File) || !file.size) return { error: "Choose an .ics file." };
    if (file.size > 2_000_000) return { error: "File is too large (max 2 MB)." };
    const r = await S.importIcs(ctx.db, ctx.workspaceId, ctx.userId, await file.text());
    return done(`Imported ${r.created} meeting(s)${r.skipped ? `, skipped ${r.skipped} (already imported or cancelled)` : ""}.`);
  } catch (e) { return fail(e); }
}
export async function syncAction(): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const r = await S.syncFromCalendar(ctx.db, ctx.workspaceId, ctx.userId); return r.error ? { error: r.error } : done(r.created ? `Found ${r.created} new calendar meeting(s).` : "No new meetings from a connected calendar. Connect Google or Outlook in Settings → Connections, or import an .ics file."); }
  catch (e) { return fail(e); }
}
export async function briefAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); const r = await S.generateBrief(ctx.db, ctx.workspaceId, ctx.userId, id); return done(`Brief v${r.version} ready — readiness ${r.readiness}/100.${r.mocked ? " (AI off: rule-based wording)" : ""}`, id); }
  catch (e) { return fail(e); }
}
export async function editAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const lines = (k: string) => s(f, k).split("\n").map((x) => x.trim()).filter(Boolean);
    const v = await S.editBrief(ctx.db, ctx.workspaceId, ctx.userId, id, { purpose_why: s(f, "why"), we_want: s(f, "we_want"), ideal: s(f, "ideal"), next_steps: lines("next_steps"), avoid: lines("avoid"), extra_questions: lines("extra_questions") });
    return done(`Saved as version ${v}.`, id);
  } catch (e) { return fail(e); }
}
export async function reviewAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.markReviewed(ctx.db, ctx.workspaceId, ctx.userId, id); return done("Marked as reviewed.", id); } catch (e) { return fail(e); }
}
export async function setupAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.setMeetingPurpose(ctx.db, ctx.workspaceId, id, { purpose: s(f, "purpose"), type: s(f, "type"), opportunityId: s(f, "opportunity_id") || null, requirementId: s(f, "requirement_id") || null, assetIds: f.getAll("asset_id").map(String).filter(Boolean) }); return done("Saved. Regenerate the brief to use it.", id); }
  catch (e) { return fail(e); }
}
export async function attendeeAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.addAttendee(ctx.db, ctx.workspaceId, ctx.userId, id, { personId: s(f, "person_id") || null, name: s(f, "name") || null, email: s(f, "email") || null }); return done("Attendee added.", id); } catch (e) { return fail(e); }
}
export async function resolveAction(id: string, attId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.resolveAttendee(ctx.db, ctx.workspaceId, attId, s(f, "person_id") || null); return done("Updated.", id); } catch (e) { return fail(e); }
}
export async function materialAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.addMaterial(ctx.db, ctx.workspaceId, ctx.userId, id, { title: s(f, "title"), url: s(f, "url"), internalOnly: f.get("shareable") !== "1" }); return done("Added.", id); } catch (e) { return fail(e); }
}
export async function checkAction(id: string, key: string, done_: boolean): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.toggleChecklist(ctx.db, ctx.workspaceId, id, key, done_); return done("", id); } catch (e) { return fail(e); }
}
export async function noteAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.addNote(ctx.db, ctx.workspaceId, ctx.userId, id, (s(f, "kind") || "note") as "note", s(f, "text")); return done("Saved.", id); } catch (e) { return fail(e); }
}
export async function structureAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.structureOutcome(ctx.db, ctx.workspaceId, ctx.userId, id, s(f, "text")); return done("Notes structured — check the proposed updates below.", id); } catch (e) { return fail(e); }
}
export async function applyAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await S.applyOutcome(ctx.db, ctx.workspaceId, ctx.userId, id, { requirement: f.get("requirement") === "1", tasks: f.get("tasks") === "1", interaction: f.get("interaction") === "1", followupDraft: f.get("followup") === "1", contacts: f.get("contacts") === "1", company: f.get("company") === "1", stakeholders: f.get("stakeholders") === "1", nextActionDate: s(f, "next_action_date") || null, assigneeUserId: s(f, "assignee") || null });
    return done(`Done: ${r.proposals} update(s) sent to Review, ${r.tasks} task(s)${r.interaction ? ", meeting saved to history" : ""}${r.draft ? ", follow-up draft ready in Outreach" : ""}.`, id);
  } catch (e) { return fail(e); }
}
export async function rescheduleAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.reschedule(ctx.db, ctx.workspaceId, id, istIso(s(f, "date"), s(f, "time"))); return done("Rescheduled here. Update your own calendar too.", id); } catch (e) { return fail(e); }
}
export async function cancelAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.cancelMeeting(ctx.db, ctx.workspaceId, id); return done("Cancelled here. Your own calendar was not changed.", id); } catch (e) { return fail(e); }
}
export async function noShowAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.recordNoShow(ctx.db, ctx.workspaceId, ctx.userId, id, { log: f.get("log") === "1" }); return done("Recorded as not held. Pick a new date when you have one.", id); } catch (e) { return fail(e); }
}
export async function discardOutcomeAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await S.discardOutcome(ctx.db, ctx.workspaceId, id); return done("Notes summary cleared.", id); } catch (e) { return fail(e); }
}
export async function clarifyAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const answers: Record<string, string> = {};
    for (const [k, v] of f.entries()) if (k.startsWith("q_") && typeof v === "string" && v.trim()) answers[k.slice(2)] = v.trim().slice(0, 300);
    await S.answerClarifications(ctx.db, ctx.workspaceId, id, answers); return done("Answers saved.", id);
  } catch (e) { return fail(e); }
}
export async function feedbackAction(id: string, assetId: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const input: M.FeedbackInput = { overall: s(f, "overall") ? Number(s(f, "overall")) : null, interest: s(f, "interest") || null, explicit_rejection: f.get("explicit_rejection") === "1" };
    for (const [k] of M.FEEDBACK_FIELDS) input[k] = s(f, k);
    await M.saveFeedback(ctx.db, ctx.workspaceId, ctx.userId, id, assetId, input); return done("Feedback saved.", id);
  } catch (e) { return fail(e); }
}
export async function uploadMaterialAction(id: string, _p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    if (!s(f, "storage_path")) return { error: "Choose a file and wait for the upload to finish." };
    await M.addUploadedMaterial(ctx.db, ctx.workspaceId, ctx.userId, id, { title: s(f, "title"), path: s(f, "storage_path"), mime: s(f, "mime"), internalOnly: f.get("shareable") !== "1" });
    return done("File attached.", id);
  } catch (e) { return fail(e); }
}
export async function whatsappAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await M.whatsappFollowup(ctx.db, ctx.workspaceId, ctx.userId, id); return done("WhatsApp follow-up draft ready in Outreach — nothing was sent.", id); } catch (e) { return fail(e); }
}
export async function emailFollowupAction(id: string): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const x = await S.gather(ctx.db, ctx.workspaceId, id);
    const target = x.attendees.find((a) => a.personId && !a.doNotContact);
    if (!target) return { error: "No attendee is a saved contact who can be contacted." };
    const { createOutreach } = await import("@/modules/outreach/service");
    await createOutreach(ctx.db, ctx.workspaceId, ctx.userId, { personId: target.personId!, channels: ["meeting_followup"], scenario: "meeting_followup", opportunityId: x.prep.opportunity_id });
    return done("Email follow-up draft ready in Outreach — nothing was sent.", id);
  } catch (e) { return fail(e); }
}
export async function agendaAction(id: string): Promise<ActionState> {
  try { const ctx = await requireContext("editor"); await M.nextAgenda(ctx.db, ctx.workspaceId, ctx.userId, id); return done("Next-meeting agenda saved to the notes.", id); } catch (e) { return fail(e); }
}
