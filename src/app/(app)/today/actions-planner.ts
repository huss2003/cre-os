"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { completeTask } from "@/modules/brief/tasks-service";

/** Tick a task done from the planner (real completion with a short evidence note; optimistic version check). */
export async function completePlannerTask(form: FormData) {
  const date = String(form.get("date") ?? "");
  const back = (q: Record<string, string>) => redirect(`/today?${new URLSearchParams({ ...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}), ...q })}`);
  let msg: Record<string, string>;
  try {
    const ctx = await requireContext("editor");
    const note = String(form.get("evidence") ?? "").trim();
    await completeTask(ctx.db, ctx.workspaceId, String(form.get("id")), { expectedVersion: Number(form.get("version")), evidence: note.length >= 3 ? note : "Marked done from the daily planner" });
    msg = { ok: "Task completed" };
  } catch (e) {
    msg = { error: e instanceof Error ? e.message.slice(0, 200) : "Could not complete the task" };
  }
  revalidatePath("/today");
  back(msg);
}
