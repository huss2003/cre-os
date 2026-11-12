/**
 * Signal card (spec §9): header fields + the 12 expandable sections, built from the stored signal, its evidence, the
 * Module 1 context snapshot and live records (all through the caller's RLS client). Read-only. Private relationship notes
 * and interaction bodies are never included — only dates/ids (§16).
 */
import type { Db } from "@/lib/supabase/server";
import { CATEGORY_LABEL, type Category, type Confidence, type Verification } from "./engine";
import { SUB_TYPES } from "./taxonomy";
import { orgContext, syncCompletedTasks, type SignalAction } from "./service";

type Row = Record<string, any>;
export { filterOptions, type FilterOptions } from "./service";

const STATUS_LABEL: Record<string, string> = { new: "New", reviewing: "Reviewing", approved: "Approved", dismissed: "Dismissed", snoozed: "Snoozed", rejected: "Rejected", known: "Already known", converted: "Converted to action" };
const LEASE_LABEL: Record<string, string> = { expiry: "Lease expiry", lockin_end: "Lock-in end", notice_deadline: "Notice deadline", break: "Break option", escalation: "Rent escalation", option: "Renewal option" };
const CRE_TITLE = /real estate|facilit|admin|workplace|procure|cfo|finance|site|country head|managing director|ceo|coo|gcc/i;

export interface EvidenceItem { id: string; role: "support" | "counter" | "context"; sourceName: string | null; url: string | null; excerpt: string | null; publishedOn: string | null; tier: string | null; factStatus: string | null; label: Verification | null; independenceKey: string | null; sourceItemId: string | null; note: string | null }

export function actionsFor(status: string, taskDone = false): SignalAction[] {
  const always: SignalAction[] = ["assign_me", "create_task", "add_evidence", "add_counter", "correct_company", "override_priority", "clear_override", "link_opportunity", "propose_opportunity", "reevaluate"];
  if (["dismissed", "rejected", "known", "snoozed"].includes(status)) return ["reopen", ...always];
  if (status === "converted" || status === "approved") return [...(taskDone ? [] : ["record_outcome" as const]), "snooze", "dismiss", ...always];
  return ["approve", "reject", "dismiss", "snooze", "investigate", "known", ...always];
}

export async function getSignalCard(db: Db, ws: string, id: string) {
  // A follow-up task completed in /tasks is written back to this signal's history first (best effort; editors only via RLS).
  try { await syncCompletedTasks(db, ws, [id]); } catch { /* read-only viewers: shown as-is */ }
  const { data: sig } = await db.from("signal").select("*, org:org_id(id, display_name, sector), person:person_id(full_name)").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!sig) return null;
  const [ev, hist, assess, items, task] = await Promise.all([
    db.from("signal_evidence").select("*").eq("workspace_id", ws).eq("signal_id", id).is("archived_at", null).order("published_on", { ascending: false, nullsFirst: false }).then((r) => r.data ?? []),
    db.from("signal_review").select("action, from_status, to_status, reason, data, actor_user_id, created_at").eq("workspace_id", ws).eq("signal_id", id).order("created_at", { ascending: false }).limit(100).then((r) => r.data ?? []),
    db.from("signal_assessment").select("rule_version, confidence, priority, priority_band, reasons, created_at").eq("workspace_id", ws).eq("signal_id", id).order("created_at", { ascending: false }).limit(50).then((r) => r.data ?? []),
    db.from("signal_source_item").select("id, adapter, status, title, url, published_on, error").eq("workspace_id", ws).contains("signal_ids", [id]).limit(50).then((r) => r.data ?? []),
    sig.task_id ? db.from("task").select("id, title, status, due_at, completion_evidence").eq("workspace_id", ws).eq("id", sig.task_id).maybeSingle().then((r) => r.data) : Promise.resolve(null),
  ]);
  const ctx = sig.org_id ? await orgContext(db, ws, sig.org_id) : null;
  const rels = sig.org_id ? ((await db.from("organisation_relation").select("from_org_id, to_org_id, relation_type, from:from_org_id(display_name), to:to_org_id(display_name)")
    .eq("workspace_id", ws).is("archived_at", null).or(`from_org_id.eq.${sig.org_id},to_org_id.eq.${sig.org_id}`).limit(20)).data ?? []) : [];
  const evidence: EvidenceItem[] = (ev as Row[]).map((e) => ({ id: e.id, role: e.role, sourceName: e.source_name, url: e.source_url, excerpt: e.excerpt, publishedOn: e.published_on, tier: e.evidence_tier, factStatus: e.fact_status, label: e.label, independenceKey: e.independence_key, sourceItemId: e.source_item_id, note: e.note }));
  const support = evidence.filter((e) => e.role === "support");
  const GROUP = /repeats are not independent|may all refer to one announcement/i;
  const counterRule = ((sig.context_json?.counter_evidence ?? []) as string[]).filter((c) => !GROUP.test(c));
  const groupingNotes = [...new Set([...((sig.context_json?.grouping_notes ?? []) as string[]), ...((sig.context_json?.counter_evidence ?? []) as string[]).filter((c) => GROUP.test(c))])];
  const counterUser = evidence.filter((e) => e.role === "counter").map((e) => e.excerpt ?? e.note ?? "");
  const today = new Date().toISOString().slice(0, 10);
  const ov = sig.priority_override as Row | null;
  const derived = sig.derived ?? {};
  const first = support[0]?.sourceName ?? "No evidence";
  return {
    id: sig.id,
    header: {
      company: sig.org?.display_name ?? sig.entity_name_raw ?? null, companyId: sig.org_id, person: sig.person?.full_name ?? null, signal: sig.title,
      category: sig.category as Category, categoryLabel: CATEGORY_LABEL[sig.category as Category], subType: sig.sub_type, subTypeLabel: SUB_TYPES[sig.sub_type ?? ""]?.label ?? null,
      location: sig.location_text, detected: sig.detected_at, eventDate: sig.event_date, eventDateBasis: sig.event_date_basis,
      evidenceSummary: support.length ? `${first}${support.length > 1 ? ` + ${support.length - 1} more` : ""} (${sig.independent_evidence_count} independent)` : "No supporting evidence",
      creRelevance: sig.cre_relevance, confidence: sig.confidence as Confidence, confidenceReasons: sig.confidence_reasons ?? [], verification: sig.verification as Verification,
      status: sig.status, statusLabel: STATUS_LABEL[sig.status] ?? sig.status, processingStatus: sig.processing_status, priority: sig.priority, urgency: sig.priority_band,
      priorityReasons: sig.priority_reasons ?? [], priorityOverride: ov, overrideReviewDue: !!(ov?.review_on && ov.review_on <= today),
      recommendedAction: sig.recommended_action, actionKind: sig.action_kind, assignedUserId: sig.assigned_user_id, snoozedUntil: sig.snoozed_until, ruleVersion: sig.rule_version,
    },
    sections: {
      whatHappened: sig.summary ?? sig.title, whyItMatters: sig.cre_relevance ?? "", contextualSummary: sig.contextual_summary,
      evidence: support,
      groupingNotes,
      locationNote: (sig.context_json?.location_note ?? null) as string | null,
      grouping: { firstDetected: sig.detected_at, mostRecentConfirmation: sig.last_confirmed_on ?? sig.latest_evidence_on, supportingSources: support.length, independentEvidenceCount: sig.independent_evidence_count, contradictoryCount: counterRule.filter((c) => !counterUser.includes(c)).length + counterUser.length },
      relatedCompany: ctx?.org ? { id: sig.org_id, name: ctx.org.display_name, sector: ctx.org.sector, relations: (rels as Row[]).map((r) => r.from_org_id === sig.org_id ? { id: r.to_org_id, name: r.to?.display_name, relation: r.relation_type } : { id: r.from_org_id, name: r.from?.display_name, relation: `${r.relation_type} (of)` }) } : null,
      officeLocations: ctx?.locations ?? [],
      occupancy: (ctx?.leases ?? []).map((l) => ({ leaseId: l.id, asset: l.asset?.name ?? null, areaSf: l.area_sf, expiry: l.contractual_expiry })),
      leaseEvents: (ctx?.leaseEvents ?? []).map((e) => ({ type: e.event_type, typeLabel: LEASE_LABEL[e.event_type] ?? e.event_type, date: e.event_date, basis: e.date_basis, confirmed: e.confirmed })),
      contacts: (ctx?.contacts ?? []).map((c) => ({ personId: c.person_id, name: c.name, title: c.title, creRole: CRE_TITLE.test(`${c.title ?? ""} ${c.function ?? ""}`) })),
      requirements: (ctx?.requirements ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status })),
      opportunities: (ctx?.opportunities ?? []).map((o) => ({ id: o.id, name: o.name, stage: o.stage, outcome: o.outcome })),
      counterEvidence: [...counterRule.filter((c) => !counterUser.includes(c)).map((text) => ({ text, source: "rule" as const })), ...counterUser.map((text) => ({ text, source: "user" as const }))],
      missingInfo: sig.missing_info ?? [],
      nextSteps: [{ text: sig.recommended_action ?? derived.nextAction?.text ?? "Review and verify.", actionKind: sig.action_kind ?? derived.nextAction?.actionKind ?? "research" }],
      labels: { facts: [], inferences: [], hypotheses: [], unknowns: [], ...(sig.labels ?? {}) },
      derived,
      entity: { resolved: !!(sig.org_id || sig.person_id), method: sig.entity_resolution?.method ?? null, candidates: sig.entity_candidates ?? [], rawName: sig.entity_name_raw ?? sig.entity_resolution?.raw_name ?? null },
    },
    task, history: hist, assessments: assess, sourceItems: items, actions: actionsFor(sig.status, (task as Row | null)?.status === "done"),
  };
}
export type SignalCard = NonNullable<Awaited<ReturnType<typeof getSignalCard>>>;
