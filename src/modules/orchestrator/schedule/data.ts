import "server-only";
/**
 * Loaders shared by the daily plan, weekly review and capacity. Two calling modes, as in the brief module:
 * ctx.db (RLS) with access = null, or the admin client from jobs with the member's access so every row is filtered
 * exactly as RLS would for that user (S1/S2). Every query filters workspace_id. A failing source is reported as
 * `unavailable` with the reason — never as "nothing found" (S10).
 */
import type { LoadCtx } from "@/modules/brief/data";
import { visible } from "@/modules/brief/visibility";
import { parsePromises } from "@/modules/brief/caretaker";
import { addDays } from "@/modules/brief/dates";
import { atLocal } from "@/lib/util/time";

export type { LoadCtx };
const VIS = "classification, owner_user_id, archived_at";

export interface Section<T> { state: "ok" | "unavailable"; items: T[]; note: string | null }
export async function section<T>(f: () => Promise<T[]>): Promise<Section<T>> {
  try { return { state: "ok", items: await f(), note: null }; }
  catch (e) { return { state: "unavailable", items: [], note: `Could not load: ${e instanceof Error ? e.message : String((e as any)?.message ?? e)}`.slice(0, 200) }; }
}
function filt<T>(c: LoadCtx, rows: T[] | null | undefined, type: string): T[] {
  return c.access ? (visible(c.access, rows as any, type) as T[]) : (rows ?? []);
}
const must = <T>(r: { data: T | null; error: any }): T => { if (r.error) throw r.error; return (r.data ?? []) as T; };

export interface PrepStatus { meetingId: string; prepId: string; status: string; briefFresh: boolean; readiness: number | null; missing: string[]; critical: string[] }
export async function loadPrepStatus(c: LoadCtx, meetingIds: string[]): Promise<Map<string, PrepStatus>> {
  const out = new Map<string, PrepStatus>();
  if (!meetingIds.length) return out;
  const rows = must(await c.db.from("meeting_prep").select(`id, meeting_visit_id, status, brief, readiness, readiness_detail, meeting:meeting_visit_id(start_at), ${VIS}`)
    .eq("workspace_id", c.workspaceId).in("meeting_visit_id", meetingIds.slice(0, 200))) as any[];
  for (const p of filt(c, rows, "meeting_prep")) {
    const fresh = !!p.brief && Date.parse(p.brief?.overview?.start) === Date.parse(p.meeting?.start_at) && p.status !== "rescheduled";
    out.set(p.meeting_visit_id, { meetingId: p.meeting_visit_id, prepId: p.id, status: p.status, briefFresh: fresh, readiness: p.readiness, missing: p.readiness_detail?.missing ?? [], critical: p.readiness_detail?.critical ?? [] });
  }
  return out;
}

export interface SignalItem { id: string; title: string; orgId: string | null; confidence: string; verification: string; detectedAt: string; href: string }
export async function loadSignals(c: LoadCtx, sinceIso: string, untilIso?: string): Promise<SignalItem[]> {
  let q = c.db.from("signal").select(`id, title, org_id, confidence, verification, detected_at, priority, status, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).gte("detected_at", sinceIso).not("status", "in", "(rejected,dismissed)");
  if (untilIso) q = q.lt("detected_at", untilIso);
  const rows = must(await q.order("priority", { ascending: false, nullsFirst: false }).limit(50)) as any[];
  return filt(c, rows, "signal").filter((s: any) => s.confidence !== "insufficient").slice(0, 10).map((s: any) => ({
    id: s.id, title: s.title, orgId: s.org_id, confidence: s.confidence, verification: s.verification, detectedAt: s.detected_at, href: `/signals/${s.id}`,
  }));
}

export interface DealItem { id: string; name: string; stage: string; reason: string; nextAction: string | null; due: string | null; href: string }
const PROPOSAL_STAGES = ["proposal_negotiation", "loi", "documentation"];
export async function loadOpenDeals(c: LoadCtx): Promise<any[]> {
  const rows = must(await c.db.from("opportunity").select(`id, name, stage, outcome, next_action, next_action_due, stage_entered_at, updated_at, created_at, account_owner_user_id, org_id, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).or("outcome.is.null,outcome.eq.open").limit(1000)) as any[];
  return filt(c, rows, "opportunity");
}
/** Deals needing attention: next action overdue/today, no next action, or stalled (no update in 14 days). */
export function dealsNeedingAttention(deals: any[], today: string, nowIso: string): DealItem[] {
  const out: DealItem[] = [];
  for (const d of deals) {
    let reason: string | null = null;
    if (d.next_action_due && d.next_action_due <= today) reason = d.next_action_due < today ? `Next action overdue since ${d.next_action_due}` : "Next action due today";
    else if (!d.next_action) reason = "No next action recorded";
    else if (Date.parse(d.updated_at) < Date.parse(nowIso) - 14 * 864e5) reason = "No update in 14 days";
    if (reason) out.push({ id: d.id, name: d.name, stage: d.stage, reason, nextAction: d.next_action, due: d.next_action_due, href: `/deals/${d.id}` });
  }
  return out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999")).slice(0, 15);
}
export function urgentProposals(deals: any[], today: string): { id: string; title: string; due: string }[] {
  const lim = addDays(today, 2);
  return deals.filter((d) => PROPOSAL_STAGES.includes(d.stage) && d.next_action_due && d.next_action_due <= lim)
    .map((d) => ({ id: d.id, title: `${d.name}: ${d.next_action ?? "proposal"}`, due: d.next_action_due }));
}

export interface CommitmentItem { id: string; kind: "promise" | "task"; title: string; due: string; interactionId?: string; taskId?: string; orgIds: string[]; key: string; href: string }
/** Overdue open promises (interaction.promises) and overdue commitment tasks. Never marks anything done. */
export async function loadOverdueCommitments(c: LoadCtx, today: string, opts: { mineOnly?: boolean } = {}): Promise<CommitmentItem[]> {
  const since = addDays(today, -180);
  const ints = filt(c, must(await c.db.from("interaction").select(`id, occurred_at, channel, subject, promises, ${VIS}`)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).gte("occurred_at", `${since}T00:00:00Z`).not("promises", "is", null).limit(2000)) as any[], "interaction")
    .filter((i: any) => !opts.mineOnly || !i.owner_user_id || i.owner_user_id === c.userId);
  const out: CommitmentItem[] = [];
  const links = ints.length ? must(await c.db.from("interaction_link").select("interaction_id, entity_type, entity_id").eq("workspace_id", c.workspaceId)
    .in("interaction_id", ints.slice(0, 200).map((i: any) => i.id)).eq("entity_type", "organisation")) as any[] : [];
  for (const i of ints) {
    for (const p of parsePromises(i.promises)) {
      if (p.status !== "open" || !p.due || p.due >= today) continue;
      const orgIds = links.filter((l) => l.interaction_id === i.id).map((l) => l.entity_id);
      const verb = p.party === "them" ? `Chase ${p.who}` : p.party === "us" ? "Deliver" : "Follow up";
      out.push({ id: `${i.id}:${p.key}`, kind: "promise", title: `${verb}: ${p.what}`, due: p.due, interactionId: i.id, orgIds, key: `caretaker:promise:${i.id}:${p.key}`, href: orgIds[0] ? `/companies/${orgIds[0]}` : "/tasks" });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/** Local day bounds as ISO instants. */
export function dayBounds(date: string, tz: string) {
  return { from: atLocal(date, "00:00", tz).toISOString(), to: atLocal(addDays(date, 1), "00:00", tz).toISOString() };
}

export async function countRows(c: LoadCtx, table: string, build: (q: any) => any, type = table): Promise<any[]> {
  const rows = must(await build(c.db.from(table).select(`*`).eq("workspace_id", c.workspaceId)).limit(500)) as any[];
  return filt(c, rows, type);
}

/**
 * Module 16 blockers for the daily plan (W13 step 7): active transactions with blocking / overdue issues, pending
 * approvals and deposits due. Direct tx_* reads with explicit workspace filter (works with the job's admin client).
 */
export async function loadTransactionBlockers(c: LoadCtx, today: string): Promise<{ id: string; name: string; reason: string; href: string; due: string | null }[]> {
  const txs = must(await c.db.from("tx_transaction").select("id, code, name, owner_user_id").eq("workspace_id", c.workspaceId).eq("status", "active").is("archived_at", null).limit(200)) as any[];
  const mine = txs.filter((t) => !c.userId || t.owner_user_id === c.userId);
  if (!mine.length) return [];
  const ids = mine.map((t) => t.id);
  const [issues, appr, deps] = await Promise.all([
    c.db.from("tx_issue").select("transaction_id, title, status, due_date, blocking").eq("workspace_id", c.workspaceId).in("transaction_id", ids).is("archived_at", null).not("status", "in", "(resolved,closed)").limit(500),
    c.db.from("tx_approval").select("transaction_id, category, version_label, deadline").eq("workspace_id", c.workspaceId).in("transaction_id", ids).is("invalidated_at", null).in("status", ["pending", "under_review", "changes_requested"]).limit(200),
    c.db.from("tx_deposit").select("transaction_id, deposit_type, due_date, paid_on").eq("workspace_id", c.workspaceId).in("transaction_id", ids).is("archived_at", null).is("paid_on", null).not("due_date", "is", null).lte("due_date", today).limit(200),
  ]);
  const out: { id: string; name: string; reason: string; href: string; due: string | null }[] = [];
  for (const t of mine) {
    const r: string[] = []; let due: string | null = null;
    for (const i of (issues.data ?? []) as any[]) if (i.transaction_id === t.id && (i.blocking || (i.due_date && i.due_date < today))) { r.push(`${i.blocking ? "Blocker" : "Overdue issue"}: ${i.title}`); due ??= i.due_date ?? null; }
    for (const a of (appr.data ?? []) as any[]) if (a.transaction_id === t.id) { r.push(`Approval pending: ${String(a.category).replace(/_/g, " ")} — ${a.version_label}`); due ??= a.deadline ?? null; }
    for (const d of (deps.data ?? []) as any[]) if (d.transaction_id === t.id) { r.push(`Deposit due ${d.due_date} (${d.deposit_type})`); due ??= d.due_date; }
    if (r.length) out.push({ id: t.id, name: `${t.code} — ${t.name ?? "Transaction"}`, reason: r.join("; "), href: `/transactions/${t.id}`, due });
  }
  if (issues.error || appr.error) throw new Error((issues.error ?? appr.error)!.message);
  return out;
}
