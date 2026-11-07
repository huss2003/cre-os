"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { proposeChange } from "@/lib/services/changes";
import { addLinked, LINKED, LinkedError } from "../linked";
import { errorMessage } from "../http";
import type { ActionState } from "../ui/client";

const PATHS: Record<string, string> = { person: "/people", organisation: "/companies", asset: "/buildings", requirement: "/requirements", lease: "/buildings", workspace: "/geography" };

export async function addLinkedAction(kind: string, hostId: string | null, backPath: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const res = await addLinked(ctx.db, ctx.workspaceId, ctx.userId, kind, hostId, form);
    revalidatePath(backPath || PATHS[LINKED[kind]?.host ?? "workspace"]);
    revalidatePath("/database");
    return { ok: true, message: ["Saved.", ...res.warnings].join(" ") };
  } catch (e) {
    return { error: e instanceof LinkedError ? e.message : errorMessage(e) };
  }
}

/** End a role: keeps the record (history), sets end date and marks it previous. */
export async function endEmploymentAction(id: string, backPath: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const end = String(form.get("end_date") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return { error: "Pick the date the role ended." };
    const { data: row } = await ctx.db.from("employment").select("start_date, row_version, classification").eq("id", id).eq("workspace_id", ctx.workspaceId).maybeSingle();
    if (!row) return { error: "Role not found." };
    if (row.start_date && end < row.start_date) return { error: "End date cannot be before the start date." };
    // End date / current flag are material (rule S4): route through Approvals, never a direct write.
    await proposeChange(ctx.db, ctx.workspaceId, {
      targetType: "employment", targetId: id, operation: "update", expectedVersion: Number(row.row_version),
      patch: [{ op: "replace", path: "/end_date", value: end }, { op: "replace", path: "/end_precision", value: "day" }, { op: "replace", path: "/is_current", value: false }],
      reason: String(form.get("reason") ?? "") || "Role ended (recorded from person page)", proposedByKind: "user", classification: row.classification,
    });
    revalidatePath(backPath); revalidatePath("/approvals");
    return { ok: true, message: "Sent to Approvals. Once approved the role is marked previous; the record and its history are kept." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

const ARCHIVABLE = new Set(["space", "contact_method", "asset_spec", "entity_alias", "organisation_relation", "lease_space", "lease_event", "requirement_location", "requirement_feature", "relationship_context", "relationship_edge", "observation", "availability", "geography", "lease"]);
/** Archive a linked row (never delete). */
export async function archiveLinkedAction(table: string, id: string, backPath: string, _prev: ActionState, _form: FormData): Promise<ActionState> {
  try {
    if (!ARCHIVABLE.has(table)) return { error: "This record cannot be archived here." };
    const ctx = await requireContext("editor");
    const { error } = await ctx.db.from(table).update({ archived_at: new Date().toISOString() }).eq("id", id).eq("workspace_id", ctx.workspaceId);
    if (error) throw error;
    revalidatePath(backPath); revalidatePath("/database");
    return { ok: true, message: "Archived. Nothing was deleted." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/** Propose one observation as the current (canonical) value for its field. Others stay as history. Needs a reason. */
export async function proposeCurrentObservationAction(id: string, backPath: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const reason = String(form.get("reason") ?? "").trim();
    if (reason.length < 5) return { error: "Say why this value is the right one (at least a few words)." };
    const { data: o } = await ctx.db.from("observation").select("row_version, classification, verification").eq("id", id).eq("workspace_id", ctx.workspaceId).maybeSingle();
    if (!o) return { error: "Observation not found." };
    if (o.verification === "currently_confirmed") return { error: "This value is already the current one." };
    await proposeChange(ctx.db, ctx.workspaceId, {
      targetType: "observation", targetId: id, operation: "update", expectedVersion: Number(o.row_version),
      patch: [{ op: "replace", path: "/verification", value: "currently_confirmed" }],
      reason, proposedByKind: "user", classification: o.classification,
    });
    revalidatePath(backPath); revalidatePath("/approvals");
    return { ok: true, message: "Sent to Approvals. The other values stay on record as history." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}
