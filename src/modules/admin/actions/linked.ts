"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
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
    const { data: row } = await ctx.db.from("employment").select("start_date").eq("id", id).eq("workspace_id", ctx.workspaceId).maybeSingle();
    if (!row) return { error: "Role not found." };
    if (row.start_date && end < row.start_date) return { error: "End date cannot be before the start date." };
    const { error } = await ctx.db.from("employment").update({ end_date: end, end_precision: "day", is_current: false }).eq("id", id).eq("workspace_id", ctx.workspaceId);
    if (error) throw error;
    revalidatePath(backPath);
    return { ok: true, message: "Role ended. History kept." };
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
