import "server-only";
/**
 * Workflow F — overdue commitment (spec §17). Hourly per workspace:
 * 1. identify open promises past their date (interaction.promises; a promise is only closed by a person),
 * 2. skip completed ones, 3. resolve company / contact / opportunity, 4. assess importance (active opportunity ⇒ high),
 * 5. it appears in the owner's daily plan (overdue_commitments section), 6. suggest a follow-up (task title + why),
 * 7. never duplicate a task: the task key is the SAME key the brief caretaker uses (`brief.caretaker:promise:<i>:<hash>`),
 *    so whichever runs first creates it and the other finds it.
 */
import type { Db } from "@/lib/supabase/server";
import { createTask } from "@/lib/services/tasks";
import { localDate } from "@/lib/util/time";
import { loadOverdueCommitments } from "./data";
import { notifyUser } from "../notify/service";

export async function runOverdueCommitments(admin: Db, ws: string, opts: { now?: Date; tz?: string } = {}) {
  const now = opts.now ?? new Date();
  const { data: w } = await admin.from("workspace").select("timezone, status").eq("id", ws).single();
  if (w?.status !== "active") return { skipped: `workspace ${w?.status}` };
  const today = localDate(now, opts.tz ?? w.timezone ?? "Asia/Kolkata");
  const items = await loadOverdueCommitments({ db: admin, workspaceId: ws, userId: "", tz: w.timezone, access: null }, today);
  if (!items.length) return { overdue: 0, created: 0, existing: 0 };
  const intIds = [...new Set(items.map((i) => i.interactionId!).filter(Boolean))];
  const { data: ints } = await admin.from("interaction").select("id, owner_user_id").eq("workspace_id", ws).in("id", intIds.slice(0, 500));
  const ownerOf = new Map(((ints ?? []) as any[]).map((i) => [i.id, i.owner_user_id as string | null]));
  const orgIds = [...new Set(items.flatMap((i) => i.orgIds))];
  const { data: opps } = orgIds.length ? await admin.from("opportunity").select("id, org_id, name, outcome").eq("workspace_id", ws).in("org_id", orgIds.slice(0, 500)).is("archived_at", null) : { data: [] };
  const { data: fallback } = await admin.from("membership").select("user_id").eq("workspace_id", ws).eq("role", "owner").limit(1).maybeSingle();
  const keys = items.map((i) => `brief.${i.key}`);
  const { data: existingRows } = await admin.from("task").select("idempotency_key").eq("workspace_id", ws).in("idempotency_key", keys.slice(0, 200));
  const existing = new Set(((existingRows ?? []) as any[]).map((r) => r.idempotency_key));
  let created = 0, existed = 0;
  for (const it of items) {
    const owner = ownerOf.get(it.interactionId!) ?? fallback?.user_id ?? null;
    const opp = ((opps ?? []) as any[]).find((o) => it.orgIds.includes(o.org_id) && (o.outcome === null || o.outcome === "open"));
    const important = !!opp;
    const key = `brief.${it.key}`;
    if (existing.has(key)) { existed++; continue; }
    await createTask(admin, ws, {
      title: it.title, description: `Promise was due ${it.due} and is still open${opp ? ` — linked to active deal "${opp.name}"` : ""}. Suggested follow-up: you decide and you send (no automatic messages).`,
      dueAt: `${it.due}T05:30:00.000Z`, priority: important ? 90 : 80, source: "workflow", linkedEntityType: "interaction", linkedEntityId: it.interactionId,
      idempotencyKey: key, ownerUserId: owner, assignedUserId: owner,
    });
    created++;
    if (owner) await notifyUser(admin, ws, { userId: owner, category: "commitment", eventKey: `commitment_overdue:${it.key}`, title: it.title, body: `Due ${it.due}${opp ? ` · deal ${opp.name}` : ""}`, severity: important ? "urgent" : "info", record: { type: "interaction", id: it.interactionId! }, href: it.href, groupKey: `commitment:${today}`, sharedOutbox: { dedupeKey: it.key, kind: "promise_overdue" }, now });
  }
  return { overdue: items.length, created, existing: existed };
}
