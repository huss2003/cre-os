"use server";
import { refresh } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { actionError } from "./http";
import type { ActionState } from "./ui/client";
import { dismissConflict, markVerified, proposeConflictFix } from "./steward";

const UUID = /^[0-9a-f-]{36}$/i;
const id = (form: FormData, key = "id") => {
  const v = String(form.get(key) ?? "");
  if (!UUID.test(v)) throw new Error("invalid id");
  return v;
};

/** Conflict report: "Propose fix" (change proposal with the source evidence) or "Keep record value". */
export async function conflictAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const cid = id(form);
    if (form.get("op") === "dismiss") {
      await dismissConflict(ctx.db, ctx.workspaceId, ctx.userId, cid, String(form.get("note") ?? "").trim() || null);
      refresh();
      return { ok: true, message: "Kept the record value; the conflict is closed (history kept)." };
    }
    await proposeConflictFix(ctx.db, ctx.workspaceId, cid);
    refresh();
    return { ok: true, message: "Fix proposed — approve it in Approvals → Record changes." };
  } catch (e) { return { error: actionError(e) }; }
}

/** Freshness: a person confirmed the record's key facts. */
export async function markVerifiedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    await markVerified(ctx.db, ctx.workspaceId, ctx.userId, String(form.get("type") ?? ""), id(form), String(form.get("note") ?? "").trim() || null);
    refresh();
    return { ok: true, message: "Marked verified; the review task was closed." };
  } catch (e) { return { error: actionError(e) }; }
}
