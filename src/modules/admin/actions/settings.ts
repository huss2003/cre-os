"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminApi } from "../guard";
import { errorMessage } from "../http";
import { saveGeneral, saveRules, saveRetention, RETENTION_DEFAULTS } from "../settings";
import { addMember, removeMember, updateMember, CLASSES } from "../members";
import { archiveConfig, createConfig, updateConfig, verifyTemplatePath, CONFIG, type ConfigKind } from "../config";
import { setAiPaused } from "../killswitch";
import { retryJob } from "../health";
import type { ActionState } from "../ui/client";

/* Server actions for /settings/** and /admin. Every action re-checks role + owner MFA (requireAdminApi). */

const ok = (message: string, path: string): ActionState => { revalidatePath(path); return { ok: true, message }; };
const fail = (e: unknown): ActionState => ({ error: errorMessage(e) });
const formObject = (form: FormData) => {
  const o: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    if (k.startsWith("$") || k === "storage_path" || v instanceof File) continue;
    if (k in o) o[k] = ([] as unknown[]).concat(o[k], v);
    else o[k] = v;
  }
  return o;
};

export async function saveGeneralAction(_p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("owner");
    await saveGeneral(ctx.db, ctx.workspaceId, { name: form.get("name"), timezone: form.get("timezone"), currency: form.get("currency") || undefined });
    return ok("Workspace details saved.", "/settings");
  } catch (e) { return fail(e); }
}

export async function saveRulesAction(_p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("admin");
    await saveRules(ctx.db, ctx.workspaceId, formObject(form));
    return ok("Operating rules saved. Scoring, briefs and targets use them from the next run.", "/settings");
  } catch (e) { return fail(e); }
}

// ------------------------------------------------------------------ members
export async function addMemberAction(_p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("owner");
    const res = await addMember(createAdminClient(), ctx.userId, ctx.workspaceId, {
      email: String(form.get("email") ?? ""),
      role: String(form.get("role") ?? "viewer") as never,
      displayName: (form.get("display_name") as string) || null,
      method: form.get("method") === "invite_link" ? "invite_link" : "temp_password",
      allowedClassifications: form.getAll("allowed_classifications").map(String).filter((c) => (CLASSES as readonly string[]).includes(c)) as never,
      seeAllAccounts: form.get("see_all_accounts") === "on",
    });
    revalidatePath("/settings/members");
    if (res.tempPassword) return { ok: true, message: "Account created and added.", secret: { label: "Temporary password (user must change it at first sign-in)", value: res.tempPassword } };
    if (res.inviteLink) return { ok: true, message: "Invite created and member added.", secret: { label: "Invite link", value: res.inviteLink } };
    return { ok: true, message: "Existing user added to this workspace." };
  } catch (e) { return fail(e); }
}

export async function updateMemberAction(userId: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("owner");
    await updateMember(ctx.db, ctx.workspaceId, ctx.userId, userId, {
      role: String(form.get("role")) as never,
      allowedClassifications: form.getAll("allowed_classifications").map(String) as never,
      seeAllAccounts: form.get("see_all_accounts") === "on",
      displayName: (form.get("display_name") as string) || null,
    });
    return ok("Member updated.", "/settings/members");
  } catch (e) { return fail(e); }
}

export async function removeMemberAction(userId: string): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("owner");
    await removeMember(ctx.db, ctx.workspaceId, ctx.userId, userId);
    return ok("Member removed and their record shares revoked.", "/settings/members");
  } catch (e) { return fail(e); }
}

// ------------------------------------------------------------------ partners / templates / licensed sources / data lanes
const CONFIG_PATH: Record<ConfigKind, string> = {
  partner: "/settings/partners", template_asset: "/settings/templates", licensed_source: "/settings/sources", data_lane: "/settings/lanes",
};
function kindOf(k: string): ConfigKind {
  if (!(k in CONFIG)) throw new Error("unknown settings kind");
  return k as ConfigKind;
}

export async function createConfigAction(k: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const kind = kindOf(k);
    const ctx = await requireAdminApi("admin");
    const extra: Record<string, unknown> = {};
    const path = String(form.get("storage_path") ?? "");
    if (kind === "template_asset" && path) extra.storage_path = await verifyTemplatePath(ctx.db, ctx.workspaceId, path, String(form.get("kind")));
    await createConfig(ctx.db, ctx.workspaceId, ctx.userId, kind, formObject(form), extra);
    return ok("Saved.", CONFIG_PATH[kind]);
  } catch (e) { return fail(e); }
}

export async function updateConfigAction(k: string, id: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const kind = kindOf(k);
    const ctx = await requireAdminApi("admin");
    const extra: Record<string, unknown> = {};
    const path = String(form.get("storage_path") ?? "");
    if (kind === "template_asset" && path) {
      extra.storage_path = await verifyTemplatePath(ctx.db, ctx.workspaceId, path, String(form.get("kind")));
      extra.version = Number(form.get("version") ?? 1) + 1;   // new file => new template version (documents record it)
      extra.approved = false;                                 // a new file must be re-approved
    }
    await updateConfig(ctx.db, ctx.workspaceId, kind, id, Number(form.get("row_version")), formObject(form), extra);
    return ok(extra.storage_path ? "New template version uploaded — approve it before use." : "Saved.", CONFIG_PATH[kind]);
  } catch (e) { return fail(e); }
}

export async function archiveConfigAction(k: string, id: string, _p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const kind = kindOf(k);
    const ctx = await requireAdminApi("admin");
    const restore = form.get("restore") === "1";
    await archiveConfig(ctx.db, ctx.workspaceId, kind, id, !restore);
    return ok(restore ? "Restored." : "Archived.", CONFIG_PATH[kind]);
  } catch (e) { return fail(e); }
}

// ------------------------------------------------------------------ retention
export async function saveRetentionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("admin");
    const items = RETENTION_DEFAULTS.map((d) => {
      const raw = String(form.get(`days_${d.category}`) ?? "").trim();
      return {
        category: d.category,
        retain_days: raw === "" ? null : Number(raw),
        legal_hold: form.get(`hold_${d.category}`) === "on",
        note: (form.get(`note_${d.category}`) as string) || null,
      };
    });
    await saveRetention(ctx.db, ctx.workspaceId, ctx.userId, items);
    return ok("Retention policy approved. The nightly purge job applies it (legal holds override).", "/settings/retention");
  } catch (e) { return fail(e); }
}

// ------------------------------------------------------------------ health: kill switch + job retry
export async function setPausedAction(_p: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("admin");
    const paused = form.get("paused") === "1";
    await setAiPaused(ctx.db, ctx.workspaceId, paused, (form.get("reason") as string) || null);
    return ok(paused ? "Paused: AI calls and external ingestion stop. Internal records, tasks, approvals and the fallback brief keep working." : "Resumed.", "/admin");
  } catch (e) { return fail(e); }
}

export async function retryJobAction(jobId: string): Promise<ActionState> {
  try {
    const ctx = await requireAdminApi("admin");
    await retryJob(ctx.db, jobId);
    return ok("Job re-queued.", "/admin");
  } catch (e) { return fail(e); }
}
