/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { addDays } from "date-fns";
import { atLocal, edate, fmt, localDate } from "@/lib/util/time";
import { cronFromSimple, nextCronRun } from "../commands/cron";
import { isStale } from "../memory/service";
import type { Block } from "../types";

/**
 * Automatic morning brief — deterministic assembly (no LLM for facts, S5/S6). Each source is read separately and
 * time-boxed; a failed/slow source is listed as "not checked" (S10), never shown as "nothing today".
 * Works with the user's RLS client ("Run now") or the service-role client in the job: every query filters
 * workspace_id explicitly, and personal items (tasks, memories, meetings, approvals) also filter the user (S2).
 * Nothing is sent anywhere (S3): the brief is a pinned assistant conversation + a card on /home.
 */
export interface BriefCtx { db: any; workspaceId: string; userId: string; timezone?: string }

export const SOURCE_TIMEOUT_MS = 8_000;
export const LEASE_WINDOWS = [12, 6, 3] as const;

export interface MorningBrief {
  date: string;                      // local yyyy-mm-dd
  title: string;
  blocks: Block[];
  failed: string[];
  counts: Record<string, number>;
}

export async function timeboxed<T>(label: string, p: () => Promise<T>, failed: string[], ms = SOURCE_TIMEOUT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), ms); }),
    ]);
  } catch {
    failed.push(label);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

const one = (v: any) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const must = <T>(r: { data: T | null; error: any }): T => { if (r.error) throw new Error(r.error.message ?? "query failed"); return (r.data ?? ([] as unknown as T)); };

/** Leases whose 12/6/3-month window opened in (since, today]. Pure; dates by edate (no LLM). */
export function leasesEnteringWindows(leases: { id: string; contractual_expiry: string | null }[], since: string, today: string) {
  const out: { id: string; months: number; expiry: string; windowOpened: string }[] = [];
  for (const l of leases) {
    if (!l.contractual_expiry || l.contractual_expiry < today) continue;
    for (const m of LEASE_WINDOWS) {
      const opened = edate(l.contractual_expiry, -m);
      if (opened > since && opened <= today) { out.push({ id: l.id, months: m, expiry: l.contractual_expiry, windowOpened: opened }); break; }
    }
  }
  return out;
}

/** Previous working day (Mon → Fri) so Monday's brief covers the weekend. */
export function sinceDate(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const back = d.getUTCDay() === 1 ? 3 : d.getUTCDay() === 0 ? 2 : 1;
  return addDays(d, -back).toISOString().slice(0, 10);
}

export async function assembleMorningBrief(c: BriefCtx, now = new Date(), opts: { topN?: number } = {}): Promise<MorningBrief> {
  const tz = c.timezone || "Asia/Kolkata";
  const today = localDate(now, tz);
  const since = sinceDate(today);
  const start = atLocal(today, "00:00", tz);
  const end = new Date(start.getTime() + 86_400_000);
  const sinceStart = atLocal(since, "00:00", tz);
  const ws = c.workspaceId, me = c.userId, db = c.db;
  const failed: string[] = [];
  const topN = opts.topN ?? 10;

  const [meetings, tasks, outreach, topAccounts, leases, proposals, approvals, memories] = await Promise.all([
    timeboxed("Meetings", async () => must(await db.from("meeting_prep").select("id, status, readiness, meeting:meeting_visit_id!inner(title, start_at, owner_user_id), org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).eq("meeting.owner_user_id", me).gte("meeting.start_at", start.toISOString()).lt("meeting.start_at", end.toISOString()).limit(30)) as any[], failed),
    timeboxed("Tasks & commitments", async () => must(await db.from("task").select("id, title, due_at, status, linked_entity_type, linked_entity_id")
      .eq("workspace_id", ws).is("archived_at", null).in("status", ["open", "stale"]).not("due_at", "is", null).lt("due_at", end.toISOString())
      .or(`assigned_user_id.eq.${me},and(assigned_user_id.is.null,owner_user_id.eq.${me})`).order("due_at").limit(30)) as any[], failed),
    timeboxed("Follow-ups", async () => must(await db.from("outreach_item").select("id, planned_on, person:person_id(full_name), org:org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).eq("status", "planned").lte("planned_on", today)
      .or(`assigned_user_id.eq.${me},and(assigned_user_id.is.null,owner_user_id.eq.${me})`).order("planned_on").limit(20)) as any[], failed),
    timeboxed("Account scores", async () => must(await db.from("score_result").select("entity_id, score").eq("workspace_id", ws).eq("is_current", true)
      .eq("entity_type", "organisation").in("model_key", ["company", "lead"]).is("archived_at", null).order("score", { ascending: false }).limit(topN * 3)) as any[], failed),
    timeboxed("Leases", async () => must(await db.from("lease").select("id, contractual_expiry, tenant_name_raw, tenant:tenant_org_id(display_name)")
      .eq("workspace_id", ws).is("archived_at", null).gte("contractual_expiry", today).lte("contractual_expiry", edate(today, 13)).limit(500)) as any[], failed),
    timeboxed("Approvals", async () => must(await db.from("change_proposal").select("id").eq("workspace_id", ws).eq("state", "proposed").is("archived_at", null).limit(100)) as any[], failed),
    timeboxed("Assistant approvals", async () => must(await db.from("assistant_approval").select("id, title").eq("workspace_id", ws).eq("owner_user_id", me).eq("status", "pending").is("archived_at", null).limit(50)) as any[], failed),
    timeboxed("Memories", async () => must(await db.from("assistant_memory").select("id, content, review_at, last_verified_at, captured_at").eq("workspace_id", ws)
      .eq("owner_user_id", me).eq("status", "active").is("archived_at", null).limit(500)) as any[], failed),
  ]);

  // signals on top-N accounts (depends on scores)
  const orgIds: string[] = [];
  for (const s of topAccounts ?? []) if (!orgIds.includes(s.entity_id)) orgIds.push(s.entity_id);
  const top = orgIds.slice(0, topN);
  const signals = topAccounts === null ? null : top.length === 0 ? [] : await timeboxed("Signals", async () =>
    must(await db.from("signal").select("id, title, org_id, detected_at, verification, org:org_id(display_name)").eq("workspace_id", ws).in("org_id", top)
      .gte("detected_at", sinceStart.toISOString()).is("archived_at", null).order("detected_at", { ascending: false }).limit(20)) as any[], failed);

  const blocks: Block[] = [];
  const counts: Record<string, number> = {};
  const notChecked = (label: string) => `Not checked — ${label} could not be read this morning. Open it directly before relying on this brief.`;

  // Meetings
  if (meetings === null) blocks.push({ kind: "missing", items: [notChecked("meetings")] });
  else {
    const rows = meetings.map((r) => ({ ...r, meeting: one(r.meeting), org: one(r.org) })).sort((a, b) => String(a.meeting?.start_at).localeCompare(String(b.meeting?.start_at)));
    counts.meetings = rows.length;
    blocks.push({ kind: "tasks", title: `Meetings today (${rows.length})`, items: rows.length ? rows.map((r) => ({
      title: `${fmt(r.meeting?.start_at, "HH:mm", tz)} ${r.meeting?.title ?? "Meeting"}${r.org?.display_name ? ` · ${r.org.display_name}` : ""} — prep ${r.status === "ready" || (r.readiness ?? 0) >= 80 ? "ready" : `${r.readiness ?? 0}% (${String(r.status ?? "not started").replace(/_/g, " ")})`}`,
      done: r.status === "ready", href: `/meetings/${r.id}`,
    })) : [{ title: "No meetings today.", href: "/meetings" }] });
  }

  // Follow-ups & commitments
  if (tasks === null || outreach === null) blocks.push({ kind: "missing", items: [notChecked(tasks === null ? "tasks and commitments" : "outreach follow-ups")] });
  const fu = [
    ...(tasks ?? []).map((t) => ({ title: `${t.title}${t.due_at < start.toISOString() ? " (overdue)" : ""}`, due: localDate(new Date(t.due_at), tz), href: "/tasks" })),
    ...(outreach ?? []).map((o) => ({ title: `Follow up ${one(o.person)?.full_name ?? "contact"}${one(o.org)?.display_name ? ` · ${one(o.org).display_name}` : ""}${o.planned_on < today ? " (overdue)" : ""}`, due: o.planned_on as string, href: `/outreach/${o.id}` })),
  ];
  if (tasks !== null || outreach !== null) {
    counts.followups = fu.length;
    blocks.push({ kind: "tasks", title: `Follow-ups & commitments due (${fu.length})`, items: fu.length ? fu : [{ title: "Nothing due or overdue.", href: "/tasks" }] });
  }

  // Signals on top accounts
  if (signals === null) blocks.push({ kind: "missing", items: [notChecked(topAccounts === null ? "account scores (so signals on top accounts)" : "signals")] });
  else {
    counts.signals = signals.length;
    blocks.push({ kind: "table", title: `New signals since ${fmt(sinceStart, "EEE d MMM", tz)} on your top ${top.length} accounts`, columns: ["Company", "Signal", "Status"],
      rows: signals.map((s) => [one(s.org)?.display_name ?? "—", s.title, s.verification ?? "unverified"]),
      note: top.length === 0 ? "No scored accounts yet — score companies to get signal alerts here." : signals.length === 0 ? "No new signals on these accounts." : undefined,
      sources: signals.slice(0, 5).map((s) => ({ label: s.title, href: `/signals/${s.id}`, observedAt: s.detected_at, status: s.verification === "verified" ? "verified" : "reported" })) });
  }

  // Lease windows
  if (leases === null) blocks.push({ kind: "missing", items: [notChecked("leases")] });
  else {
    const hits = leasesEnteringWindows(leases, since, today);
    const byId = new Map(leases.map((l) => [l.id, l]));
    counts.leases = hits.length;
    blocks.push({ kind: "tasks", title: `Leases entering 12/6/3-month windows (${hits.length})`, items: hits.length ? hits.map((h) => {
      const l: any = byId.get(h.id);
      return { title: `${one(l?.tenant)?.display_name ?? l?.tenant_name_raw ?? "Tenant unknown"} — ${h.months} months to expiry (${h.expiry}, contractual)`, due: h.expiry, href: "/leases" };
    }) : [{ title: "No lease entered a 12, 6 or 3-month window since the last brief.", href: "/leases" }] });
  }

  // Approvals
  if (proposals === null && approvals === null) blocks.push({ kind: "missing", items: [notChecked("approvals")] });
  else {
    counts.approvals = (proposals?.length ?? 0) + (approvals?.length ?? 0);
    blocks.push({ kind: "tasks", title: `Approvals waiting (${counts.approvals}${(proposals?.length ?? 0) >= 100 ? "+" : ""})`, items: [
      ...(proposals !== null ? [{ title: `${proposals.length} record change${proposals.length === 1 ? "" : "s"} to review`, href: "/approvals" }] : []),
      ...(approvals ?? []).slice(0, 5).map((a) => ({ title: `Assistant: ${a.title}`, href: "/assistant" })),
    ] });
    if (proposals === null || approvals === null) blocks.push({ kind: "missing", items: [notChecked(proposals === null ? "record approvals" : "assistant approvals")] });
  }

  // Stale memories
  if (memories === null) blocks.push({ kind: "missing", items: [notChecked("assistant memories")] });
  else {
    const stale = memories.filter((m) => isStale(m, now));
    counts.stale_memories = stale.length;
    blocks.push({ kind: "tasks", title: `Memories to re-check (${stale.length})`, items: stale.length ? stale.slice(0, 5).map((m) => ({ title: String(m.content).slice(0, 120), href: `/assistant/memory?id=${m.id}` }))
      : [{ title: "All memories are current.", href: "/assistant/memory" }] });
  }

  const title = `Morning brief — ${fmt(now, "EEE d MMM yyyy", tz)}`;
  const intro = failed.length
    ? `Partial brief: ${failed.join(", ")} could not be checked. Everything else below is from your records.`
    : `${counts.meetings ?? 0} meetings, ${counts.followups ?? 0} follow-ups due, ${counts.signals ?? 0} new signals, ${counts.leases ?? 0} lease windows, ${counts.approvals ?? 0} approvals.`;
  blocks.unshift({ kind: "text", markdown: intro });
  return { date: today, title, blocks, failed, counts };
}

// ------------------------------------------------------------------ settings + delivery

export interface BriefSetting { id: string; enabled: boolean; time_local: string; timezone: string; top_n: number; next_run_at: string | null; row_version: number }

export function nextBriefRun(time: string, after: Date, tz = "Asia/Kolkata"): Date | null {
  return nextCronRun(cronFromSimple(time, "weekdays"), after, tz);
}

export async function getBriefSetting(c: BriefCtx): Promise<BriefSetting | null> {
  const { data } = await c.db.from("assistant_brief_setting").select("*").eq("workspace_id", c.workspaceId).eq("owner_user_id", c.userId).is("archived_at", null).maybeSingle();
  return (data as BriefSetting) ?? null;
}

/** Opt in/out + delivery time (weekdays, local time). Explicit user action only. */
export async function saveBriefSetting(c: BriefCtx, input: { enabled: boolean; time?: string; topN?: number }, now = new Date()): Promise<BriefSetting> {
  const time = (input.time ?? "08:00").trim();
  cronFromSimple(time, "weekdays"); // validates
  const tz = c.timezone || "Asia/Kolkata";
  const row = {
    enabled: input.enabled, time_local: time.padStart(5, "0"), timezone: tz, top_n: input.topN ?? 10,
    next_run_at: input.enabled ? nextBriefRun(time, now, tz)?.toISOString() ?? null : null,
    opted_in_at: input.enabled ? now.toISOString() : null,
  };
  const cur = await getBriefSetting(c);
  const q = cur
    ? c.db.from("assistant_brief_setting").update(row).eq("workspace_id", c.workspaceId).eq("id", cur.id).select("*").single()
    : c.db.from("assistant_brief_setting").insert({ ...row, workspace_id: c.workspaceId, owner_user_id: c.userId }).select("*").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as BriefSetting;
}

export async function latestBrief(c: BriefCtx) {
  const { data } = await c.db.from("assistant_morning_brief").select("id, brief_date, conversation_id, status, failed_sources, counts").eq("workspace_id", c.workspaceId)
    .eq("owner_user_id", c.userId).is("archived_at", null).order("brief_date", { ascending: false }).limit(1).maybeSingle();
  return data as { id: string; brief_date: string; conversation_id: string | null; status: string; failed_sources: string[]; counts: Record<string, number> } | null;
}

/**
 * Build and deliver today's brief as a pinned conversation. Idempotent per user per local day: a second call returns
 * the existing delivery. `appendMessage` is injected so tests / callers can reuse the engine's message writer.
 */
export async function deliverMorningBrief(c: BriefCtx, now = new Date(), opts: { topN?: number } = {}) {
  const tz = c.timezone || "Asia/Kolkata";
  const date = localDate(now, tz);
  const existing = await c.db.from("assistant_morning_brief").select("id, conversation_id, status").eq("workspace_id", c.workspaceId).eq("owner_user_id", c.userId).eq("brief_date", date).maybeSingle();
  if (existing.data) return { duplicate: true, briefId: existing.data.id as string, conversationId: existing.data.conversation_id as string | null, status: existing.data.status as string };

  const b = await assembleMorningBrief(c, now, opts);
  const status = b.failed.length ? "partial" : "complete";
  const conv = await c.db.from("assistant_conversation").insert({ workspace_id: c.workspaceId, owner_user_id: c.userId, title: b.title, pinned: true }).select("id").single();
  if (conv.error) throw new Error(conv.error.message);
  const conversationId = conv.data.id as string;
  const ins = await c.db.from("assistant_morning_brief").insert({ workspace_id: c.workspaceId, owner_user_id: c.userId, brief_date: date, conversation_id: conversationId, status, failed_sources: b.failed, counts: b.counts }).select("id").single();
  if (ins.error) {
    // lost a race with a concurrent run: drop our conversation and return the winner
    await c.db.from("assistant_conversation").update({ archived_at: new Date().toISOString() }).eq("workspace_id", c.workspaceId).eq("id", conversationId);
    if (/duplicate|unique/i.test(ins.error.message)) return deliverMorningBrief(c, now, opts);
    throw new Error(ins.error.message);
  }
  const msg = await c.db.from("assistant_message").insert({ workspace_id: c.workspaceId, owner_user_id: c.userId, conversation_id: conversationId, seq: 1, role: "assistant",
    content: b.title, blocks: b.blocks as object, status: status === "partial" ? "partial" : "complete", model: "deterministic" }).select("id").single();
  if (msg.error) throw new Error(msg.error.message);
  return { duplicate: false, briefId: ins.data.id as string, conversationId, status, failed: b.failed };
}
