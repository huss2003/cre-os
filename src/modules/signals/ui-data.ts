/**
 * UI-side helpers for the Signal Engine pages (pure + thin). Owned by the signals UI.
 *  - parseFilter / filterHref: URL search params <-> contract ListFilter (docs/signal-engine/CONTRACT.md §1)
 *  - runSignalForm: validates a FormData submission (role, http/https links) and calls actOnSignal; used by actions.ts
 *  - lookupOpportunities: picker search for "Link to existing opportunity" (no shared lookup kind exists for deals)
 */
import type { Db } from "@/lib/supabase/server";
import { containsLike } from "@/lib/util/like";
import { humanize } from "./text";

export const VIEW_KEYS = ["all", "high", "expansion", "restructuring", "lease", "commercial", "leadership", "infrastructure", "unverified", "closed"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];
const CATS = ["expansion", "restructuring", "lease", "commercial", "leadership", "infrastructure", "macro"] as const;
const CONF = ["high", "medium", "low", "insufficient"] as const;
const BANDS = ["high", "medium", "low"] as const;
const STATUSES = ["new", "reviewing", "approved", "rejected", "dismissed", "snoozed", "known", "converted"] as const;
const SORTS = ["priority", "detected", "event"] as const;

export interface UiFilter {
  view: ViewKey; q?: string; orgId?: string; industry?: string; microMarket?: string; category?: string; subType?: string;
  eventFrom?: string; eventTo?: string; from?: string; to?: string; freshDays?: number; confidence?: string; urgency?: string;
  status?: string; source?: string; assigned?: string; sort?: string;
}
/** Keys that count as "filters" (view and q are separate controls). */
export const FILTER_KEYS = ["orgId", "industry", "microMarket", "category", "subType", "eventFrom", "eventTo", "from", "to", "freshDays", "confidence", "urgency", "status", "source", "assigned", "sort"] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const text = (v: unknown, max = 120) => { const s = one(v); return typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined; };
const pick = <T extends string>(v: unknown, allowed: readonly T[]) => { const s = text(v); return s && (allowed as readonly string[]).includes(s) ? (s as T) : undefined; };
const date = (v: unknown) => { const s = text(v); return s && DATE.test(s) ? s : undefined; };

/** Untrusted URL params -> a clean filter. Unknown values are dropped, never passed to the query. */
export function parseFilter(sp: Record<string, string | string[] | undefined>): UiFilter {
  const f: UiFilter = { view: pick(sp.view, VIEW_KEYS) ?? "all" };
  const set = <K extends keyof UiFilter>(k: K, v: UiFilter[K] | undefined) => { if (v !== undefined) f[k] = v; };
  set("q", text(sp.q, 200));
  const org = text(sp.orgId); set("orgId", org && UUID.test(org) ? org : undefined);
  set("industry", text(sp.industry)); set("microMarket", text(sp.microMarket)); set("source", text(sp.source));
  set("category", pick(sp.category, CATS)); set("subType", text(sp.subType, 60));
  set("eventFrom", date(sp.eventFrom)); set("eventTo", date(sp.eventTo)); set("from", date(sp.from)); set("to", date(sp.to));
  const fd = Number(one(sp.freshDays)); set("freshDays", Number.isInteger(fd) && fd > 0 && fd <= 3650 ? fd : undefined);
  set("confidence", pick(sp.confidence, CONF)); set("urgency", pick(sp.urgency, BANDS)); set("status", pick(sp.status, STATUSES));
  const a = text(sp.assigned); set("assigned", a === "me" || a === "unassigned" || (a && UUID.test(a)) ? a : undefined);
  set("sort", pick(sp.sort, SORTS));
  return f;
}

/** Filter -> contract ListFilter (adds userId for "assigned to me"). */
export function toListFilter(f: UiFilter, userId: string) {
  const { view, ...rest } = f;
  return { ...rest, view, userId, category: f.category as never, confidence: f.confidence as never, urgency: f.urgency as never, sort: f.sort as never };
}

/** Builds /signals?... keeping current filters, with overrides (undefined/"" removes a key). */
export function filterHref(f: Partial<UiFilter>, over: Partial<Record<keyof UiFilter, string | number | undefined>> = {}): string {
  const m = { ...f, ...over } as Record<string, unknown>;
  const u = new URLSearchParams();
  for (const k of ["view", "q", ...FILTER_KEYS]) {
    const v = m[k];
    if (v === undefined || v === null || v === "" || (k === "view" && v === "all")) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `/signals?${s}` : "/signals";
}

export const activeFilterCount = (f: UiFilter) => FILTER_KEYS.filter((k) => f[k] !== undefined && k !== "sort").length;

// ------------------------------------------------------------------ action form handling

export const FORM_KEYS = ["reason", "until", "title", "opportunity_id", "name", "text", "source", "url", "published_on", "org_id", "band", "review_on", "outcome"] as const;
export const ACTIONS = ["approve", "reject", "dismiss", "snooze", "investigate", "known", "assign_me", "create_task", "link_opportunity",
  "propose_opportunity", "add_evidence", "add_counter", "correct_company", "override_priority", "clear_override", "record_outcome", "reevaluate", "reopen"] as const;
export type UiAction = (typeof ACTIONS)[number];

export class FormProblem extends Error {}
export interface FormCtx { db: Db; workspaceId: string; userId: string; role: string }
type Act = (db: Db, ws: string, userId: string, id: string, action: never, data: Record<string, string | undefined>) => Promise<unknown>;

/** Only http(s) links are accepted as evidence; anything else (javascript:, data:, file:) is refused before the backend. */
export function httpOnly(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try { u = new URL(url); } catch { throw new FormProblem("Link must be a full web address starting with http:// or https://."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FormProblem("Only http:// or https:// links can be added as evidence.");
  return u.toString();
}

/** Validates the submitted form and runs the backend action. Viewers can never change a signal. */
export async function runSignalForm(ctx: FormCtx, id: string, form: FormData, act: Act) {
  if (!["editor", "admin", "owner"].includes(ctx.role)) throw new FormProblem("You have view-only access to signals.");
  const action = String(form.get("action") ?? "") as UiAction;
  if (!(ACTIONS as readonly string[]).includes(action)) throw new FormProblem("Unknown action.");
  if (!UUID.test(id)) throw new FormProblem("Signal not found.");
  const data: Record<string, string | undefined> = {};
  for (const k of FORM_KEYS) { const v = form.get(k); data[k] = typeof v === "string" && v.trim() ? v.trim() : undefined; }
  if (action === "add_evidence" || action === "add_counter") data.url = httpOnly(data.url);
  if (action === "snooze" && !data.until) throw new FormProblem("Pick a date to snooze until.");
  if ((action === "dismiss" || action === "reject") && !data.reason) throw new FormProblem("Give a short reason.");
  if (action === "override_priority" && !data.reason) throw new FormProblem("Give a reason for the override.");
  const r = await act(ctx.db, ctx.workspaceId, ctx.userId, id, action as never, data);
  return { action, result: r };
}

export const ACTION_MESSAGE: Partial<Record<UiAction, string>> = {
  approve: "Approved — follow-up task created.", create_task: "Task created.", propose_opportunity: "Opportunity proposal sent to Review.",
  snooze: "Snoozed.", dismiss: "Dismissed.", reject: "Rejected.", known: "Marked as already known.", investigate: "Marked as reviewing.",
  assign_me: "Assigned to you.", link_opportunity: "Linked to the opportunity.", add_evidence: "Evidence added — signal re-assessed.",
  add_counter: "Counter-evidence added — signal re-assessed.", correct_company: "Company corrected (recorded in history).",
  override_priority: "Priority overridden.", clear_override: "Override removed.", record_outcome: "Outcome recorded.",
  reevaluate: "Re-assessed against current evidence.", reopen: "Reopened.",
};

const BAND: Record<string, string> = { high: "Act now", medium: "This month", low: "Watch" };
/** Paste-box result when the text was attached to existing signal(s) as counter-evidence. */
export function counterMessage(us: { title: string; priorityBefore: number | null; priorityAfter: number | null; bandBefore: string | null; bandAfter: string | null }[]): string {
  const one = (u: (typeof us)[number]) => {
    const p = u.priorityBefore != null && u.priorityAfter != null && u.priorityBefore !== u.priorityAfter ? ` priority ${u.priorityBefore} → ${u.priorityAfter}/100` : " priority unchanged";
    const b = u.bandBefore && u.bandAfter && u.bandBefore !== u.bandAfter ? ` (${BAND[u.bandBefore] ?? u.bandBefore} → ${BAND[u.bandAfter] ?? u.bandAfter})` : "";
    return `“${u.title}” —${p}${b}`;
  };
  return `Added as counter-evidence to ${us.length === 1 ? "signal" : `${us.length} signals`}: ${us.map(one).join("; ")}. Nothing new was created.`;
}

// ------------------------------------------------------------------ opportunity picker

export async function lookupOpportunities(db: Db, ws: string, q: string, id?: string) {
  let query = db.from("opportunity").select("id, name, stage, org:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null);
  if (id) query = query.eq("id", id);
  else if (q.trim().length >= 2) query = query.ilike("name", containsLike(q.trim()));
  const { data, error } = await query.order("updated_at", { ascending: false }).limit(15);
  if (error) throw new Error(error.message);
  return (data ?? []).map((o: Record<string, any>) => ({ id: o.id as string, label: o.name as string, context: [o.org?.display_name, humanize(o.stage)].filter(Boolean).join(" · ") }));
}
