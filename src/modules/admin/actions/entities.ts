"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext, hasRole } from "@/lib/auth/context";
import { createEntity, saveEntity, setArchived, shareRecord, unshareRecord, EDITABLE, type EntityTable } from "../entities";
import { ENTITY_ROUTE } from "../ui/entity-fields";
import { errorMessage } from "../http";
import type { ActionState } from "../ui/client";

const TABLES: EntityTable[] = ["organisation", "person", "asset"];
function table(t: string): EntityTable {
  if (!(TABLES as string[]).includes(t)) throw new Error("unknown entity type");
  return t as EntityTable;
}
function formInput(t: EntityTable, form: FormData) {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE[t]) if (form.has(k)) out[k] = form.get(k);
  return out;
}

export async function createEntityAction(t: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const tbl = table(t);
    const ctx = await requireContext("editor");
    const row = await createEntity(ctx.db, ctx.workspaceId, ctx.userId, tbl, formInput(tbl, form));
    id = row.id as string;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  redirect(`${ENTITY_ROUTE[table(t)]}/${id}`);
}

export async function saveEntityAction(t: string, id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const tbl = table(t);
    const ctx = await requireContext("editor");
    const res = await saveEntity(ctx.db, ctx.workspaceId, tbl, id, Number(form.get("row_version")), formInput(tbl, form));
    revalidatePath(`${ENTITY_ROUTE[tbl]}/${id}`);
    const parts = [];
    if (res.applied.length) parts.push(`Saved: ${res.applied.join(", ")}.`);
    if (res.proposed.length) parts.push(`Sent for approval: ${res.proposed.join(", ")} (see Approvals).`);
    return { ok: true, message: parts.join(" ") || "No changes." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export async function archiveEntityAction(t: string, id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const tbl = table(t);
    const restore = form.get("restore") === "1";
    const ctx = await requireContext(restore ? "admin" : "editor");
    const res = await setArchived(ctx.db, ctx.workspaceId, tbl, id, Number(form.get("row_version")), !restore, String(form.get("reason") ?? "") || undefined);
    revalidatePath(`${ENTITY_ROUTE[tbl]}/${id}`);
    return { ok: true, message: restore ? "Restored." : res.proposalId ? "Archive requested — approve it in Approvals. Nothing is deleted." : "Already archived." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

export async function shareAction(t: string, id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const tbl = table(t);
    const ctx = await requireContext("admin");
    if (!hasRole(ctx, "admin")) return { error: "only owners and admins can share records" };
    const userId = String(form.get("user_id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return { error: "pick a colleague" };
    if (form.get("op") === "unshare") await unshareRecord(ctx.db, ctx.workspaceId, tbl, id, userId);
    else await shareRecord(ctx.db, ctx.workspaceId, tbl, id, userId);
    revalidatePath(`${ENTITY_ROUTE[tbl]}/${id}`);
    return { ok: true, message: form.get("op") === "unshare" ? "Access removed." : "Shared. The colleague can now open this record." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}
