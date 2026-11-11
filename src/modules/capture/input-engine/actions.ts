"use server";
import { refresh } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { actionError } from "@/modules/changes/http";
import type { ActionState } from "@/modules/changes/ui/client";
import { associateObservation, confirmObservation, correctObservation, createRecordFromObservation, rejectObservation, requestClarification, savePermissions } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** One form per extracted item on the review screen: confirm / edit / reject / associate / create / request clarification (§13B). */
export async function observationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const id = s(form, "observation_id");
    if (!UUID.test(id)) return { error: "Unknown item." };
    const op = s(form, "op");
    let message = "Saved.";
    if (op === "confirm") { await confirmObservation(ctx.db, ctx.workspaceId, ctx.userId, id); message = "Confirmed."; }
    else if (op === "reject") {
      const r = await rejectObservation(ctx.db, ctx.workspaceId, ctx.userId, id, s(form, "note") || undefined);
      message = r.proposal_rejected === false ? "Rejected here. The record change still needs an approver's decision in Approvals." : "Rejected — nothing on the record changed.";
    } else if (op === "correct") {
      const raw = s(form, "value");
      const value = raw === "" ? undefined : /^-?\d+(\.\d+)?$/.test(raw.replace(/,/g, "")) ? Number(raw.replace(/,/g, "")) : raw;
      const opt = (k: string) => (s(form, k) ? s(form, k) : undefined);
      await correctObservation(ctx.db, ctx.workspaceId, ctx.userId, id, { ...(value !== undefined ? { value } : {}), ...(opt("unit") ? { unit: opt("unit") } : {}),
        ...(opt("pricing_basis") ? { pricing_basis: opt("pricing_basis") } : {}), ...(opt("area_basis") ? { area_basis: opt("area_basis") } : {}),
        ...(opt("cam_treatment") ? { cam_treatment: opt("cam_treatment") } : {}), note: opt("note") });
      message = "Corrected — the original reading is kept in the history.";
    } else if (op === "associate") {
      const [type, rid] = s(form, "target").split(":");
      if (!["requirement", "organisation", "person", "asset"].includes(type) || !UUID.test(rid ?? "")) return { error: "Pick a record." };
      await associateObservation(ctx.db, ctx.workspaceId, ctx.userId, id, { type: type as "requirement", id: rid });
      message = "Linked to the record (nothing merged).";
    } else if (op === "create") {
      const kind = s(form, "kind") === "person" ? "person" : "organisation";
      if (!s(form, "name")) return { error: "Type a name." };
      await createRecordFromObservation(ctx.db, ctx.workspaceId, ctx.userId, id, kind, s(form, "name"));
      message = `New ${kind === "person" ? "contact" : "company"} proposed — approve it in Approvals.`;
    } else if (op === "clarify") {
      if (s(form, "question").length < 3) return { error: "Type the question to ask." };
      await requestClarification(ctx.db, ctx.workspaceId, ctx.userId, id, s(form, "question"));
      message = "Clarification task created.";
    } else return { error: "Unknown action." };
    refresh();
    return { ok: true, message };
  } catch (e) { return { error: actionError(e) }; }
}

export async function permissionsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    await savePermissions(ctx.db, ctx.workspaceId, {
      auto_save_internal_observations: form.get("auto_save_internal_observations") === "on",
      auto_create_tasks: form.get("auto_create_tasks") === "on",
      auto_associate_high_confidence: form.get("auto_associate_high_confidence") === "on",
    });
    refresh();
    return { ok: true, message: "Saved." };
  } catch (e) { return { error: actionError(e) }; }
}
