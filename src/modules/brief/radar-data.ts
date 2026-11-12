import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createTask } from "@/lib/services/tasks";
import { stableHash } from "@/lib/util/crypto";
import { daysBetween } from "./dates";
import { fetchAll, notify } from "./db";
import { rowsByKeys } from "./keys";
import { analyseLease, planMilestones, RADAR_ENGINE_VERSION, upcomingEventFacts, type EscalationTerm, type LeaseEventInput, type LeaseInput, type RadarItem } from "./lease-radar";
import type { BriefSettings } from "./settings";
import { visible, type MemberAccess } from "./visibility";

/** Max new enrichment/verification tasks raised per daily run (avoids flooding /tasks on first import). */
export const ENRICHMENT_TASKS_PER_RUN = 25;
/** Max new reverse-plan milestone tasks per run, and how far ahead milestones become tasks. */
export const PLAN_TASKS_PER_RUN = 25;
export const PLAN_TASK_HORIZON_DAYS = 90;
/** Alert window for notice / break / escalation / option events. */
export const EVENT_ALERT_DAYS = 30;

function chunk<T>(a: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export async function namesById(db: Db, table: "organisation" | "asset", workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const col = table === "organisation" ? "display_name" : "name";
  for (const part of chunk([...new Set(ids.filter(Boolean))])) {
    const { data } = await db.from(table).select(`id, ${col}`).eq("workspace_id", workspaceId).in("id", part);
    for (const r of (data ?? []) as Record<string, string>[]) map.set(r.id, r[col]);
  }
  return map;
}

/**
 * Stated escalation terms from extracted lease-document clauses (Legal Desk `clause_extract`, clause_type 'escalation').
 * A document belongs to a lease when it shares the lease's source object, or names the same tenant org AND building.
 * Only stated integer frequencies are used (years × 12); anything else is left for review — never guessed.
 */
export async function loadEscalationTerms(db: Db, workspaceId: string, leases: { id: string; tenant_org_id: string | null; asset_id: string | null; source_object_id?: string | null }[], access?: MemberAccess | null): Promise<Map<string, EscalationTerm[]>> {
  const out = new Map<string, EscalationTerm[]>();
  let clauses: any[] = [];
  try {
    clauses = await fetchAll((f, t) => db.from("clause_extract").select("id, document_id, clause_text, extracted_values, needs_review, classification, owner_user_id, archived_at")
      .eq("workspace_id", workspaceId).eq("clause_type", "escalation").is("archived_at", null).order("id").range(f, t), { cap: 5000 });
  } catch { return out; } // Legal Desk tables absent/unreadable: no terms (escalations then come from lease_event only)
  if (access) clauses = visible(access, clauses, "clause_extract");
  if (!clauses.length) return out;
  const docIds = [...new Set(clauses.map((c) => c.document_id))];
  const docs = new Map<string, any>();
  for (const part of chunk(docIds)) {
    const { data } = await db.from("legal_document").select("id, org_id, asset_id, source_object_id, classification, owner_user_id, archived_at").eq("workspace_id", workspaceId).in("id", part).is("archived_at", null);
    for (const d of access ? visible(access, data as any[], "legal_document") : (data ?? [])) docs.set(d.id, d);
  }
  for (const l of leases) {
    const mine: EscalationTerm[] = [];
    for (const c of clauses) {
      const d = docs.get(c.document_id);
      if (!d) continue;
      const linked = (l.source_object_id && d.source_object_id === l.source_object_id) || (!!l.tenant_org_id && !!l.asset_id && d.org_id === l.tenant_org_id && d.asset_id === l.asset_id);
      if (!linked) continue;
      const v = (c.extracted_values ?? {}) as { percent?: unknown; every?: unknown; every_unit?: unknown };
      const every = typeof v.every === "number" && Number.isInteger(v.every) && v.every > 0 ? (v.every_unit === "years" ? v.every * 12 : v.every) : null;
      mine.push({ clauseId: c.id, documentId: c.document_id, percent: typeof v.percent === "number" ? v.percent : null, everyMonths: every, needsReview: !!c.needs_review, excerpt: c.clause_text });
    }
    if (mine.length) out.set(l.id, mine);
  }
  return out;
}

export interface RadarLoad { items: RadarItem[]; leaseOwners: Map<string, { owner: string | null; classification: string }> }

/**
 * Load leases + events and run the radar. Works with the user client (RLS) or the admin client (pass `access`
 * so rows are filtered exactly as RLS would for that member).
 */
export async function loadRadar(db: Db, workspaceId: string, today: string, settings: BriefSettings, access?: MemberAccess | null): Promise<RadarLoad> {
  let leases = await fetchAll((f, t) => db.from("lease")
    .select("id, tenant_org_id, tenant_name_raw, landlord_org_id, asset_id, area_sf, start_date, start_precision, tenure_months_raw, lockin_months_raw, contractual_expiry, status, source_object_id, classification, owner_user_id, archived_at")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("id").range(f, t));
  if (access) leases = visible(access, leases, "lease");
  if (leases.length === 0) return { items: [], leaseOwners: new Map() };
  const leaseIds = new Set(leases.map((l) => l.id));
  const events = (await fetchAll((f, t) => db.from("lease_event")
    .select("id, lease_id, event_type, event_date, date_basis, notice_days, notice_day_rule, confirmed, needs_review, review_reason, formula_raw, archived_at")
    // radar-calculated rows are outputs, never inputs (otherwise a calculation would "confirm" itself)
    .eq("workspace_id", workspaceId).is("archived_at", null).is("calc_key", null).order("id").range(f, t))).filter((e) => leaseIds.has(e.lease_id));
  const terms = await loadEscalationTerms(db, workspaceId, leases, access);

  const orgNames = await namesById(db, "organisation", workspaceId, leases.flatMap((l) => [l.tenant_org_id, l.landlord_org_id]));
  const assetNames = await namesById(db, "asset", workspaceId, leases.map((l) => l.asset_id));

  const evIn: LeaseEventInput[] = events.map((e) => ({
    id: e.id, leaseId: e.lease_id, eventType: e.event_type, eventDate: e.event_date, dateBasis: e.date_basis,
    noticeDays: e.notice_days, noticeDayRule: e.notice_day_rule, confirmed: e.confirmed, needsReview: e.needs_review, reviewReason: e.review_reason, formulaRaw: e.formula_raw,
  }));
  const byLease = new Map<string, LeaseEventInput[]>();
  for (const e of evIn) byLease.set(e.leaseId, [...(byLease.get(e.leaseId) ?? []), e]);

  const leaseOwners = new Map<string, { owner: string | null; classification: string }>();
  const items = leases.map((l) => {
    leaseOwners.set(l.id, { owner: l.owner_user_id, classification: l.classification });
    const input: LeaseInput = {
      id: l.id, tenantOrgId: l.tenant_org_id, tenantName: (l.tenant_org_id && orgNames.get(l.tenant_org_id)) || l.tenant_name_raw,
      landlordOrgId: l.landlord_org_id, landlordName: l.landlord_org_id ? orgNames.get(l.landlord_org_id) ?? null : null,
      assetId: l.asset_id, assetName: l.asset_id ? assetNames.get(l.asset_id) ?? null : null,
      areaSf: l.area_sf == null ? null : Number(l.area_sf), startDate: l.start_date, startPrecision: l.start_precision,
      tenureMonthsRaw: l.tenure_months_raw == null ? null : Number(l.tenure_months_raw),
      lockinMonthsRaw: l.lockin_months_raw == null ? null : Number(l.lockin_months_raw),
      contractualExpiry: l.contractual_expiry, status: l.status, escalationTerms: terms.get(l.id) ?? [],
    };
    return analyseLease(input, byLease.get(l.id) ?? [], today, { settings: settings.reversePlan });
  });
  return { items, leaseOwners };
}

/**
 * Turn radar findings into idempotent tasks. Keys are stable so re-runs never duplicate:
 *  - enrichment (missing/fractional dates) and expired-status verification (capped per run);
 *  - review tasks for ambiguous clauses / events flagged needs_review;
 *  - notice-deadline planning (≤ 90 days);
 *  - reverse-plan milestone tasks (options, decision, procurement, fit-out start, notice) due on the milestone date,
 *    within PLAN_TASK_HORIZON_DAYS; a re-run with changed lease dates moves the open task's due date instead of adding one.
 */
export async function raiseRadarTasks(db: Db, workspaceId: string, load: RadarLoad, today: string, fallbackOwner: string | null): Promise<{ created: number; deferred: number; moved: number }> {
  type T = { key: string; title: string; description: string; priority: number; dueAt: string | null; leaseId: string; area: number; group: "notice" | "plan" | "review" | "enrich" };
  const todo: T[] = [];
  const at = (d: string) => `${d}T04:30:00.000Z`; // 10:00 IST
  for (const it of load.items) {
    const who = `${it.tenantName ?? "tenant"}${it.assetName ? ` (${it.assetName})` : ""}`;
    for (const e of it.enrichment) {
      todo.push({
        key: `brief.radar:${it.leaseId}:${e.key}`, title: e.reason,
        description: `${it.issues.join(" ") || "Lease date enrichment (Leases)."} Do not invent a date — record the source when found.`,
        priority: e.key === "expired_status" ? 60 : 40, dueAt: null, leaseId: it.leaseId, area: it.areaSf ?? 0, group: "enrich",
      });
    }
    for (const f of it.reviewFlags) {
      todo.push({
        key: `brief.radar:${it.leaseId}:review:${f.key}`, title: `Review lease clause — ${who}: ${f.eventType.replace(/_/g, " ")}`,
        description: `${f.reason}${f.date ? ` (date on record ${f.date})` : ""}. Check the executed agreement; confirm or correct the event via an approved change. Radar dates for this lease stay unverified until reviewed.`,
        priority: 70, dueAt: null, leaseId: it.leaseId, area: it.areaSf ?? 0, group: "review",
      });
    }
    if (it.noticeDeadline && it.daysToNotice != null && it.daysToNotice >= 0 && it.daysToNotice <= 90) {
      todo.push({
        key: `brief.radar:${it.leaseId}:notice:${it.noticeDeadline.date}`,
        title: `Notice deadline ${it.noticeDeadline.date} — ${who}`,
        description: `${it.noticeDeadline.basisLabel}${it.noticeDeadline.verified ? "" : " — not contractual; verify the clause"}. Reverse plan: last decision ${it.plan?.lastDecision ?? "—"}.`,
        priority: 90, dueAt: at(it.noticeDeadline.date), leaseId: it.leaseId, area: it.areaSf ?? 0, group: "notice",
      });
    }
    if (it.plan?.viable) {
      for (const m of planMilestones(it)) {
        if (m.key === "notice_deadline") continue; // covered by the notice task above
        const d = daysBetween(today, m.date);
        if (d < 0 || d > PLAN_TASK_HORIZON_DAYS) continue;
        todo.push({
          key: `brief.radar:${it.leaseId}:plan:${m.key}`, title: `${m.label} by ${m.date} — ${who}`,
          description: `Reverse plan from occupation ${it.plan.occupation} (${it.plan.occupationBasis}; expiry basis: ${it.expiry?.basisLabel ?? "unknown"}). Last decision ${it.plan.lastDecision}. Calculated milestone — adjust if the client's timeline differs.`,
          priority: m.key === "decision_by" ? 80 : 65, dueAt: at(m.date), leaseId: it.leaseId, area: it.areaSf ?? 0, group: "plan",
        });
      }
    }
  }
  if (todo.length === 0) return { created: 0, deferred: 0, moved: 0 };
  const existing = new Map<string, { id: string; due_at: string | null; status: string; title: string }>();
  // length-bounded chunks + thrown errors (200 long keys => HTTP 414 that used to be ignored; see keys.ts)
  for (const r of await rowsByKeys<{ id: string; idempotency_key: string; due_at: string | null; status: string; title: string }>(
    db, "task", workspaceId, "idempotency_key", todo.map((t) => t.key), "id, idempotency_key, due_at, status, title")) existing.set(r.idempotency_key, r);
  // reproducible re-run: an open plan task whose milestone moved gets its due date/title updated (no duplicate)
  let moved = 0;
  for (const t of todo.filter((x) => x.group === "plan" && existing.has(x.key))) {
    const cur = existing.get(t.key)!;
    if ((cur.status === "open" || cur.status === "snoozed" || cur.status === "stale") && (cur.due_at == null || Date.parse(cur.due_at) !== Date.parse(t.dueAt!) || cur.title !== t.title)) {
      await db.from("task").update({ due_at: t.dueAt, title: t.title, description: t.description }).eq("workspace_id", workspaceId).eq("id", cur.id);
      moved++;
    }
  }
  const fresh = todo.filter((t) => !existing.has(t.key)).sort((a, b) => b.priority - a.priority || b.area - a.area);
  const notice = fresh.filter((t) => t.group === "notice");
  const plan = fresh.filter((t) => t.group === "plan").sort((a, b) => (a.dueAt! < b.dueAt! ? -1 : 1)).slice(0, PLAN_TASKS_PER_RUN);
  const rest = fresh.filter((t) => t.group === "review" || t.group === "enrich").slice(0, ENRICHMENT_TASKS_PER_RUN);
  let created = 0;
  for (const t of [...notice, ...plan, ...rest]) {
    const lo = load.leaseOwners.get(t.leaseId);
    await createTask(db, workspaceId, {
      title: t.title, description: t.description, priority: t.priority, dueAt: t.dueAt, source: "workflow",
      linkedEntityType: "lease", linkedEntityId: t.leaseId, idempotencyKey: t.key,
      ownerUserId: lo?.owner ?? fallbackOwner, assignedUserId: lo?.owner ?? fallbackOwner, classification: lo?.classification ?? "corporate_confidential",
    });
    created++;
  }
  return { created, deferred: fresh.length - notice.length - plan.length - rest.length, moved };
}

/**
 * Persist radar-calculated dates as lease_event rows (admin client, job side; explicit workspace filter).
 * calc_key = radar:<lease>:<type>[:<step>], date_basis 'calculated_by_radar', confirmed=false, formula + inputs + source
 * clause kept. Re-running with the same inputs changes nothing; changed inputs update the same row; a calculation that
 * no longer applies is archived (never deleted). Imported/verified events are never touched.
 */
export async function persistCalculatedEvents(admin: Db, workspaceId: string, load: RadarLoad): Promise<{ inserted: number; updated: number; archived: number; unchanged: number }> {
  const want = new Map(load.items.flatMap((it) => it.calculated).map((c) => [c.calcKey, c]));
  const have = await fetchAll((f, t) => admin.from("lease_event").select("id, calc_key, lease_id, event_type, event_date, formula_raw, calc_inputs, source_clause_id, archived_at")
    .eq("workspace_id", workspaceId).not("calc_key", "is", null).order("id").range(f, t));
  const byKey = new Map(have.map((h) => [h.calc_key as string, h]));
  const now = new Date().toISOString();
  let inserted = 0, updated = 0, archived = 0, unchanged = 0;
  const inserts: Record<string, unknown>[] = [];
  for (const c of want.values()) {
    const h = byKey.get(c.calcKey);
    const lo = load.leaseOwners.get(c.leaseId);
    const row = {
      lease_id: c.leaseId, event_type: c.eventType, event_date: c.date, date_basis: "calculated_by_radar", formula_raw: c.formula,
      calc_inputs: c.inputs, source_clause_id: c.sourceClauseId, confirmed: false, needs_review: false, engine_version: RADAR_ENGINE_VERSION,
    };
    if (!h) {
      inserts.push({ ...row, workspace_id: workspaceId, calc_key: c.calcKey, classification: lo?.classification ?? "corporate_confidential", owner_user_id: lo?.owner ?? null });
    } else if (h.archived_at || h.event_date !== c.date || h.formula_raw !== c.formula || stableHash(h.calc_inputs ?? {}) !== stableHash(c.inputs) || (h.source_clause_id ?? null) !== c.sourceClauseId) {
      const { error } = await admin.from("lease_event").update({ ...row, archived_at: null }).eq("workspace_id", workspaceId).eq("id", h.id);
      if (error) throw error;
      updated++;
    } else unchanged++;
  }
  // the unique index (workspace_id, calc_key) is partial, so insert; a concurrent run's row (23505) is simply skipped
  for (const part of chunk(inserts, 500)) {
    const { error } = await admin.from("lease_event").insert(part);
    if (!error) { inserted += part.length; continue; }
    if ((error as { code?: string }).code !== "23505") throw error;
    for (const row of part) {
      const { error: e1 } = await admin.from("lease_event").insert(row);
      if (!e1) inserted++;
      else if ((e1 as { code?: string }).code !== "23505") throw e1;
    }
  }
  // `load` must be the full workspace radar (admin client, no member filter): anything not recalculated is obsolete
  const stale = have.filter((h) => !h.archived_at && !want.has(h.calc_key)).map((h) => h.id);
  for (const part of chunk(stale)) {
    const { error } = await admin.from("lease_event").update({ archived_at: now }).eq("workspace_id", workspaceId).in("id", part);
    if (error) throw error;
    archived += part.length;
  }
  return { inserted, updated, archived, unchanged };
}

/** Private in-app alerts (deduped) for notice / break / escalation / option events within EVENT_ALERT_DAYS. */
export async function raiseRadarAlerts(admin: Db, workspaceId: string, load: RadarLoad, today: string, fallbackOwner: string | null): Promise<number> {
  let n = 0;
  for (const it of load.items) {
    if (it.status !== "active") continue;
    const user = load.leaseOwners.get(it.leaseId)?.owner ?? fallbackOwner;
    if (!user) continue;
    const events: { kind: string; date: string; days: number; basis: string; detail?: string }[] = [];
    if (it.noticeDeadline && it.daysToNotice != null && it.daysToNotice >= 0 && it.daysToNotice <= EVENT_ALERT_DAYS) events.push({ kind: "notice", date: it.noticeDeadline.date, days: it.daysToNotice, basis: it.noticeDeadline.basisLabel });
    for (const b of it.breaks) { const d = daysBetween(today, b.date); if (d >= 0 && d <= EVENT_ALERT_DAYS) events.push({ kind: "break", date: b.date, days: d, basis: b.basisLabel }); }
    for (const u of upcomingEventFacts(it, today, EVENT_ALERT_DAYS)) events.push({ kind: u.kind, date: u.fact.date, days: u.days, basis: u.fact.basisLabel, detail: u.fact.detail });
    for (const e of events) {
      await notify(admin, workspaceId, user, "lease_event_alert", `radar:${it.leaseId}:${e.kind}:${e.date}`, {
        title: `${e.kind === "escalation" ? "Rent escalation" : e.kind === "option" ? "Lease option" : e.kind === "break" ? "Break option" : "Notice deadline"} ${e.date} — ${it.tenantName ?? "tenant"}${it.assetName ? ` (${it.assetName})` : ""}`,
        lease_id: it.leaseId, event_kind: e.kind, date: e.date, days: e.days, basis: e.basis, detail: e.detail ?? null, href: `/leases?lease=${it.leaseId}`,
      });
      n++;
    }
  }
  return n;
}
