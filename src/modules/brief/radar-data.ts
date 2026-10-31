import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createTask } from "@/lib/services/tasks";
import { fetchAll } from "./db";
import { analyseLease, type LeaseEventInput, type LeaseInput, type RadarItem } from "./lease-radar";
import type { BriefSettings } from "./settings";
import { visible, type MemberAccess } from "./visibility";

/** Max new enrichment/verification tasks raised per daily run (avoids flooding /tasks on first import). */
export const ENRICHMENT_TASKS_PER_RUN = 25;

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

export interface RadarLoad { items: RadarItem[]; leaseOwners: Map<string, { owner: string | null; classification: string }> }

/**
 * Load leases + events and run the radar. Works with the user client (RLS) or the admin client (pass `access`
 * so rows are filtered exactly as RLS would for that member).
 */
export async function loadRadar(db: Db, workspaceId: string, today: string, settings: BriefSettings, access?: MemberAccess | null): Promise<RadarLoad> {
  let leases = await fetchAll((f, t) => db.from("lease")
    .select("id, tenant_org_id, tenant_name_raw, landlord_org_id, asset_id, area_sf, start_date, start_precision, tenure_months_raw, lockin_months_raw, contractual_expiry, status, classification, owner_user_id, archived_at")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("id").range(f, t));
  if (access) leases = visible(access, leases, "lease");
  if (leases.length === 0) return { items: [], leaseOwners: new Map() };
  const leaseIds = new Set(leases.map((l) => l.id));
  const events = (await fetchAll((f, t) => db.from("lease_event")
    .select("id, lease_id, event_type, event_date, date_basis, notice_days, notice_day_rule, confirmed, needs_review, formula_raw, archived_at")
    .eq("workspace_id", workspaceId).is("archived_at", null).order("id").range(f, t))).filter((e) => leaseIds.has(e.lease_id));

  const orgNames = await namesById(db, "organisation", workspaceId, leases.flatMap((l) => [l.tenant_org_id, l.landlord_org_id]));
  const assetNames = await namesById(db, "asset", workspaceId, leases.map((l) => l.asset_id));

  const evIn: LeaseEventInput[] = events.map((e) => ({
    id: e.id, leaseId: e.lease_id, eventType: e.event_type, eventDate: e.event_date, dateBasis: e.date_basis,
    noticeDays: e.notice_days, noticeDayRule: e.notice_day_rule, confirmed: e.confirmed, needsReview: e.needs_review, formulaRaw: e.formula_raw,
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
      contractualExpiry: l.contractual_expiry, status: l.status,
    };
    return analyseLease(input, byLease.get(l.id) ?? [], today, { settings: settings.reversePlan });
  });
  return { items, leaseOwners };
}

/**
 * Turn radar findings into idempotent tasks: enrichment (missing/fractional dates), status verification (expired),
 * and notice-deadline planning. Keys are stable so the daily run never duplicates.
 */
export async function raiseRadarTasks(db: Db, workspaceId: string, load: RadarLoad, today: string, fallbackOwner: string | null): Promise<{ created: number; deferred: number }> {
  type T = { key: string; title: string; description: string; priority: number; dueAt: string | null; leaseId: string; area: number };
  const todo: T[] = [];
  for (const it of load.items) {
    for (const e of it.enrichment) {
      todo.push({
        key: `brief.radar:${it.leaseId}:${e.key}`, title: e.reason,
        description: `${it.issues.join(" ") || "Lease radar enrichment."} Do not invent a date — record the source when found.`,
        priority: e.key === "expired_status" ? 60 : 40, dueAt: null, leaseId: it.leaseId, area: it.areaSf ?? 0,
      });
    }
    if (it.noticeDeadline && it.daysToNotice != null && it.daysToNotice >= 0 && it.daysToNotice <= 90) {
      todo.push({
        key: `brief.radar:${it.leaseId}:notice:${it.noticeDeadline.date}`,
        title: `Notice deadline ${it.noticeDeadline.date} — ${it.tenantName ?? "tenant"}${it.assetName ? ` (${it.assetName})` : ""}`,
        description: `${it.noticeDeadline.basisLabel}${it.noticeDeadline.verified ? "" : " — not contractual; verify the clause"}. Reverse plan: last decision ${it.plan?.lastDecision ?? "—"}.`,
        priority: 90, dueAt: `${it.noticeDeadline.date}T04:30:00.000Z`, leaseId: it.leaseId, area: it.areaSf ?? 0,
      });
    }
  }
  if (todo.length === 0) return { created: 0, deferred: 0 };
  // existing keys -> skip without counting against the cap
  const existing = new Set<string>();
  for (const part of chunk(todo.map((t) => t.key))) {
    const { data } = await db.from("task").select("idempotency_key").eq("workspace_id", workspaceId).in("idempotency_key", part);
    for (const r of data ?? []) existing.add(r.idempotency_key);
  }
  const fresh = todo.filter((t) => !existing.has(t.key)).sort((a, b) => b.priority - a.priority || b.area - a.area);
  const notice = fresh.filter((t) => t.priority >= 90);
  const rest = fresh.filter((t) => t.priority < 90).slice(0, ENRICHMENT_TASKS_PER_RUN);
  let created = 0;
  for (const t of [...notice, ...rest]) {
    const lo = load.leaseOwners.get(t.leaseId);
    await createTask(db, workspaceId, {
      title: t.title, description: t.description, priority: t.priority, dueAt: t.dueAt, source: "workflow",
      linkedEntityType: "lease", linkedEntityId: t.leaseId, idempotencyKey: t.key,
      ownerUserId: lo?.owner ?? fallbackOwner, assignedUserId: lo?.owner ?? fallbackOwner, classification: lo?.classification ?? "corporate_confidential",
    });
    created++;
  }
  return { created, deferred: fresh.length - notice.length - rest.length };
}
