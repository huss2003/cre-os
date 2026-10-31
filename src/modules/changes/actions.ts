"use server";
import { refresh } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import type { PatchOp } from "@/lib/services/changes";
import { actionError } from "./http";
import type { ActionState } from "./ui/client";
import {
  approveAndApply, approveChange, applyChange, batchReverse, clarifyChange, editChange, rejectChange, reverseChange,
} from "./service";

const UUID = /^[0-9a-f-]{36}$/i;
function id(form: FormData, key = "id") {
  const v = String(form.get(key) ?? "");
  if (!UUID.test(v)) throw new Error("invalid id");
  return v;
}

/** Approve / approve+apply / apply / reject / clarify from the approval card (button value = op). */
export async function decideAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const pid = id(form);
    const note = String(form.get("note") ?? "").trim() || undefined;
    const op = String(form.get("op") ?? "");
    let message: string;
    if (op === "approve_apply") { await approveAndApply(ctx.db, pid, { note }); message = "Approved and applied. You can undo it from History."; }
    else if (op === "approve") { await approveChange(ctx.db, pid, { note }); message = "Approved (bound to this exact content and record version)."; }
    else if (op === "apply") { await applyChange(ctx.db, pid); message = "Applied."; }
    else if (op === "reject") { await rejectChange(ctx.db, pid, { note }); message = "Rejected."; }
    else if (op === "clarify") { await clarifyChange(ctx.db, pid, { note: note ?? "Please clarify" }); message = "Marked as needing clarification."; }
    else return { error: "unknown action" };
    refresh();
    return { ok: true, message };
  } catch (e) { return { error: actionError(e) }; }
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return null;
  try { return JSON.parse(t); } catch { return t; }
}

/** Edit proposed values. Any approval is invalidated (hash-bound), the proposal returns to the queue. */
export async function editAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const pid = id(form);
    const paths = form.getAll("path").map(String);
    const patch: PatchOp[] = paths.map((path) => ({ op: "replace", path, value: parseValue(String(form.get(`value:${path}`) ?? "")) }));
    await editChange(ctx.db, pid, patch, { reason: String(form.get("reason") ?? "").trim() || undefined });
    refresh();
    return { ok: true, message: "Edited. Any earlier approval no longer applies — approve again." };
  } catch (e) { return { error: actionError(e) }; }
}

export async function undoAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const r = await reverseChange(ctx.db, id(form));
    refresh();
    return {
      ok: true,
      message: r.status === "reversed" ? "Undone." : r.status === "partial" ? "Partly undone — newer edits were kept." : "Nothing undone — every field was edited later.",
      details: r.conflicts.map((c) => `${c.path}: kept newer value ${JSON.stringify(c.current ?? null)} (${c.detail?.reason ?? c.kind})`),
    };
  } catch (e) { return { error: actionError(e) }; }
}

export async function batchUndoAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const ids = form.getAll("ids").map(String).filter((v) => UUID.test(v));
    if (!ids.length) return { error: "Select at least one change." };
    const r = await batchReverse(ctx.db, ctx.workspaceId, ids);
    refresh();
    return {
      ok: r.failed === 0, message: `${r.reversed} undone, ${r.partial} partly undone, ${r.failed} failed.`,
      details: r.results.flatMap((x) => x.error ? [`${x.id.slice(0, 8)}: ${x.error.message}`] : (x.result?.conflicts ?? []).map((c) => `${x.id.slice(0, 8)} ${c.path}: newer value kept`)),
    };
  } catch (e) { return { error: actionError(e) }; }
}
