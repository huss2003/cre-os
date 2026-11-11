"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/auth/context";
import { atLocal } from "@/lib/util/time";
import { completeTask, createManualTask, reopenTask, snoozeTask } from "@/modules/brief/tasks-service";

function back(ret: string, msg: { ok?: string; error?: string }): never {
  const safe = ret.startsWith("/tasks") ? ret : "/tasks";
  const u = new URL(safe, "http://x");
  u.searchParams.delete("ok");
  u.searchParams.delete("error");
  for (const [k, v] of Object.entries(msg)) if (v) u.searchParams.set(k, v);
  redirect(`${u.pathname}?${u.searchParams.toString()}`);
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "issues" in e) {
    const first = (e as { issues: { message: string }[] }).issues[0];
    return first?.message ?? "Invalid input";
  }
  return e instanceof Error ? e.message.slice(0, 200) : "Something went wrong";
}

async function run(form: FormData, fn: (ctx: Awaited<ReturnType<typeof requireContext>>) => Promise<string>) {
  const ret = String(form.get("return_to") ?? "/tasks");
  let msg: { ok?: string; error?: string };
  try {
    const ctx = await requireContext("editor");
    msg = { ok: await fn(ctx) };
  } catch (e) {
    msg = { error: errMsg(e) };
  }
  revalidatePath("/tasks");
  revalidatePath("/today");
  back(ret, msg);
}

export async function completeAction(form: FormData) {
  await run(form, async (ctx) => {
    await completeTask(ctx.db, ctx.workspaceId, String(form.get("id")), { expectedVersion: Number(form.get("version")), evidence: String(form.get("evidence") ?? "") });
    return "Task completed";
  });
}

export async function snoozeAction(form: FormData) {
  await run(form, async (ctx) => {
    const days = Math.min(30, Math.max(1, Number(form.get("days") ?? 1)));
    await snoozeTask(ctx.db, ctx.workspaceId, String(form.get("id")), { expectedVersion: Number(form.get("version")), until: new Date(Date.now() + days * 86_400_000).toISOString() });
    return `Snoozed for ${days} day(s)`;
  });
}

export async function reopenAction(form: FormData) {
  await run(form, async (ctx) => {
    await reopenTask(ctx.db, ctx.workspaceId, String(form.get("id")), { expectedVersion: Number(form.get("version")) });
    return "Task reopened";
  });
}

/** Manual task. The hidden form key (rendered once per page view) makes double-submits idempotent. */
export async function createAction(form: FormData) {
  await run(form, async (ctx) => {
    const due = String(form.get("due") ?? "");
    const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(due) ? atLocal(due, "18:00", ctx.timezone || "Asia/Kolkata").toISOString() : null;
    await createManualTask(ctx.db, ctx.workspaceId, ctx.userId, {
      title: String(form.get("title") ?? ""), dueAt, priority: Number(form.get("priority") ?? 50),
    }, String(form.get("form_key") ?? "") || null);
    return "Task created";
  });
}

/** One form for the whole task list: the pressed button carries "op:id"; row fields are suffixed with the task id. */
export async function taskAction(form: FormData) {
  const [op, id] = String(form.get("op") ?? "").split(":");
  const row = new FormData();
  row.set("return_to", String(form.get("return_to") ?? "/tasks"));
  row.set("id", id ?? "");
  row.set("version", String(form.get(`version:${id}`) ?? ""));
  row.set("evidence", String(form.get(`evidence:${id}`) ?? ""));
  row.set("days", String(form.get(`days:${id}`) ?? "1"));
  if (op === "complete") return completeAction(row);
  if (op === "snooze") return snoozeAction(row);
  if (op === "reopen") return reopenAction(row);
  back(String(form.get("return_to") ?? "/tasks"), { error: "Unknown task action" });
}
