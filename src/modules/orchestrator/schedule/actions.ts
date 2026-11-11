"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { enqueue } from "@/lib/jobs/queue";
import { localDate } from "@/lib/util/time";
import { errorMessage } from "@/modules/admin/http";
import type { ActionState } from "@/modules/admin/ui/client";
import { actOnNotification } from "../notify/service";
import { setBudget } from "../budget/service";
import { loadOrchSettings } from "./settings-db";

const PATH = "/automation";

export async function notificationAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const action = String(f.get("action")) as "dismiss" | "snooze" | "complete";
    if (!["dismiss", "snooze", "complete"].includes(action)) return { error: "Unknown action." };
    await actOnNotification(ctx.db, ctx.workspaceId, ctx.userId, String(f.get("id")), action, { until: action === "snooze" ? new Date(Date.now() + 3 * 3600e3).toISOString() : undefined });
    revalidatePath("/", "layout"); // bell in the app shell + /automation
    return { ok: true, message: action === "snooze" ? "Snoozed for 3 hours." : "Done." };
  } catch (e) { return { error: errorMessage(e) }; }
}

/** Queue today's plan now (same durable job as the 08:00 schedule, same dedupe key → never a second plan). */
export async function planNowAction(_p: ActionState, _f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const s = await loadOrchSettings(ctx.db, ctx.workspaceId, ctx.userId);
    const date = localDate(new Date(), s.timezone);
    await enqueue({ workspaceId: ctx.workspaceId, type: "orchestrator.daily_plan", payload: { userId: ctx.userId, date }, dedupeKey: `orchestrator.daily_plan:${ctx.workspaceId}:${ctx.userId}:${date}`, maxAttempts: 4 });
    revalidatePath(PATH);
    return { ok: true, message: "Queued — today's plan appears here within a few minutes (if it already exists it is kept)." };
  } catch (e) { return { error: errorMessage(e) }; }
}

export async function budgetAction(_p: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext("admin");
    await setBudget(ctx.db, ctx.workspaceId, ctx.userId, {
      resource: String(f.get("resource")), module: String(f.get("module") || "*"), provider: String(f.get("provider") || "*"), period: String(f.get("period")),
      limitUnits: Number(f.get("limit")), unit: String(f.get("unit")), alertPct: f.get("alert") ? Number(f.get("alert")) : 80, enabled: f.get("enabled") !== "0",
    });
    revalidatePath(PATH);
    return { ok: true, message: "Budget saved." };
  } catch (e) { return { error: errorMessage(e) }; }
}
