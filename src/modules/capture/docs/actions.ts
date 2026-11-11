"use server";
import { refresh } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError } from "@/modules/changes/http";
import type { ActionState } from "@/modules/changes/ui/client";
import { DOC_TYPES, type DocType } from "./detect";
import { intakeFromStorage, updateAndReprocess, type DocLinks } from "./service";
import { requestMoreInfo, retryJob } from "./review";

const LINK_KEYS = ["organisation_id", "person_id", "asset_id", "requirement_id", "meeting_prep_id"] as const;
const str = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : null; };
function linksFrom(form: FormData): DocLinks { const l: DocLinks = {}; for (const k of LINK_KEYS) { const v = str(form, k); if (v) l[k] = v; } return l; }
const typeFrom = (form: FormData): DocType | null => { const t = str(form, "doc_type"); return t && (DOC_TYPES as readonly string[]).includes(t) ? (t as DocType) : null; };

export type IntakeState = (NonNullable<ActionState> & { id?: string; status?: string; type?: string; duplicate?: boolean }) | null;

/** Drop zone: the browser already put the file under <ws>/captures/uploads/…; hash, detect, route, propose. */
export async function intakeAction(_prev: IntakeState, form: FormData): Promise<IntakeState> {
  try {
    const ctx = await requireContext("editor");
    const path = str(form, "storage_path"); const name = str(form, "file_name");
    if (!path || !name) return { error: "Upload the file first." };
    const pk = str(form, "party_kind");
    const { doc, duplicate } = await intakeFromStorage(ctx, { path, name, mime: str(form, "mime") ?? "" }, {
      links: linksFrom(form), userType: typeFrom(form), caption: str(form, "caption"), typedText: str(form, "typed_text"),
      languageHint: str(form, "language_hint"), consentReference: str(form, "consent_reference"),
      partyKind: pk === "landlord" || pk === "managed_operator" || pk === "fitout_partner" ? pk : "other",
    }, { admin: createAdminClient() });
    refresh();
    return { ok: doc.status !== "failed", id: doc.id, status: doc.status, type: doc.detected_type, duplicate, error: doc.status === "failed" ? doc.error : undefined,
      message: duplicate ? "Already uploaded — showing the earlier result." : doc.error ?? undefined } as IntakeState;
  } catch (e) { return { error: actionError(e) }; }
}

/** Change type / links / typed text and process again (same idempotency keys, no duplicates). */
export async function reprocessDocAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    const id = str(form, "id"); if (!id) return { error: "missing document" };
    const d = await updateAndReprocess(ctx, id, { userType: form.has("doc_type") ? typeFrom(form) : undefined, links: linksFrom(form), typedText: str(form, "typed_text") }, { admin: createAdminClient() });
    refresh();
    return d.status === "failed" ? { error: d.error ?? "Processing failed." } : { ok: true, message: d.error ?? "Processed. Proposals (if any) are waiting in Review." };
  } catch (e) { return { error: actionError(e) }; }
}

export async function retryJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    await retryJob(ctx.db, ctx.workspaceId, ctx.role, String(form.get("job_id") ?? ""));
    refresh();
    return { ok: true, message: "Queued again." };
  } catch (e) { return { error: actionError(e) }; }
}

export async function requestInfoAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("editor");
    await requestMoreInfo(ctx.db, ctx.workspaceId, ctx.userId, String(form.get("proposal_id") ?? ""), String(form.get("note") ?? ""));
    refresh();
    return { ok: true, message: "Marked as needing info; a task was added." };
  } catch (e) { return { error: actionError(e) }; }
}
