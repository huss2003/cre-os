import "server-only";
import type { Db } from "@/lib/supabase/server";
import { runComparison } from "@/modules/toolkit/comparison";
import { recalcOrg } from "@/modules/scoring/service";
import { registerWorkflow } from "../engine/registry";
import { PermanentError } from "../engine/plan";
import type { Ref, StepCtx, StepOutcome } from "../engine/types";
import { notifyUser as notify } from "../notify/service";
import { loadOrchSettings } from "../schedule/settings-db";
import { describeRequirementChanges } from "./labels";
import { stableHashLite } from "../schedule/hash";
import { markEntity, recordIntegrationFailure, recordIntegrationSuccess } from "./marks";

/**
 * Spec §7 reassessment workflows. They identify affected outputs, call the owning module's services (toolkit
 * runComparison → new deal_analysis_version; scoring recalcOrg), and FLAG everything else with reassessment_mark.
 * Approved analyses and approved/released documents are never overwritten — they get an outdated_warning.
 * Nothing is sent (S3): notifications are in-app rows in mudar.outbox.
 */
type Row = Record<string, any>;

export async function workspaceOwner(db: Db, ws: string): Promise<string | null> {
  const { data } = await db.from("membership").select("user_id, role").eq("workspace_id", ws).in("role", ["owner", "admin"]).order("role", { ascending: false }).limit(1).maybeSingle();
  return data?.user_id ?? null;
}
/**
 * Reassessment notices go through the central notification service (severity, quiet hours, dedupe, grouping).
 * With `groupKey`, repeat notices for the same subject fold into ONE open notice whose text is refreshed to the latest
 * change and whose count goes up (instead of piling up separate rows).
 */
export async function notifyUser(db: Db, ws: string, userId: string | null, n: { title: string; body: string; refs?: Ref[]; dedupeKey: string; link?: string | null; category?: string; groupKey?: string | null; record?: { type: string; id: string } | null; severity?: "urgent" | "info" }) {
  const uid = userId ?? (await workspaceOwner(db, ws));
  if (!uid) return null;
  const base = await loadOrchSettings(db, ws, uid);
  // A grouped subject keeps one notice open while it is pending, however far apart the changes are.
  const settings = n.groupKey ? { ...base, notifications: { ...base.notifications, groupWindowMinutes: 30 * 24 * 60 } } : base;
  const record = n.record ?? (n.refs?.[0] ? { type: n.refs[0].type, id: n.refs[0].id } : null);
  const res = await notify(db, ws, { userId: uid, category: n.category ?? "commercial_change", eventKey: n.dedupeKey, title: n.title, body: n.body, severity: n.severity ?? "info", record, href: n.link ?? null, groupKey: n.groupKey ?? null, payload: { refs: n.refs ?? [], source: "orchestrator" }, settings });
  if (res.grouped && n.groupKey) {
    const { data: parent } = await db.from("notification_state").select("outbox_id, group_count").eq("workspace_id", ws).eq("user_id", uid).eq("group_key", n.groupKey).is("group_parent", null).eq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (parent) {
      const count = parent.group_count as number;
      await db.from("notification_state").update({ title: n.title.slice(0, 300), body: `${n.body} (${count} changes since you last looked)`.slice(0, 2000), updated_at: new Date().toISOString() }).eq("workspace_id", ws).eq("outbox_id", parent.outbox_id);
    }
  }
  return res.suppressed ? null : uid;
}

// ------------------------------------------------------------------ shared: comparisons + proposals
interface Affected { analyses: Row[]; deliverables: Row[]; documents: Row[] }

async function findOutputs(db: Db, ws: string, f: { requirementIds: string[]; assetId?: string | null }): Promise<Affected> {
  const sel = "id, kind, title, status, current_version, requirement_id, asset_ids, inputs, owner_user_id";
  const qs = [] as PromiseLike<{ data: Row[] | null }>[];
  if (f.requirementIds.length) qs.push(db.from("deal_analysis").select(sel).eq("workspace_id", ws).in("requirement_id", f.requirementIds).is("archived_at", null).neq("kind", "deliverable").then((r) => r as never));
  if (f.assetId) qs.push(db.from("deal_analysis").select(sel).eq("workspace_id", ws).contains("asset_ids", [f.assetId]).is("archived_at", null).then((r) => r as never));
  const all = (await Promise.all(qs)).flatMap((r) => r.data ?? []);
  const analyses = [...new Map(all.filter((a) => a.kind !== "deliverable").map((a) => [a.id, a])).values()];
  const ids = analyses.map((a) => a.id);
  const reqs = [...new Set([...f.requirementIds, ...analyses.map((a) => a.requirement_id).filter(Boolean)])];
  const { data: dl } = reqs.length ? await db.from("deal_analysis").select(sel).eq("workspace_id", ws).eq("kind", "deliverable").in("requirement_id", reqs).is("archived_at", null) : { data: [] as Row[] };
  const deliverables = ((dl ?? []) as Row[]).filter((d) => ids.some((id) => JSON.stringify(d.inputs ?? {}).includes(id)) || reqs.includes(d.requirement_id));
  const linked = [...ids, ...deliverables.map((d) => d.id)];
  const { data: docs } = linked.length ? await db.from("document_version").select("id, status, purpose, linked_entity_id, owner_user_id").eq("workspace_id", ws).eq("linked_entity_type", "deal_analysis").in("linked_entity_id", linked).is("archived_at", null) : { data: [] as Row[] };
  return { analyses, deliverables, documents: (docs ?? []) as Row[] };
}

/** Hash of what a property comparison reads: the requirement, the current quotes on its buildings, model and manual rows. */
async function comparisonInputsHash(db: Db, ws: string, a: Row): Promise<string> {
  const inp = (a.inputs ?? {}) as Row;
  const { data: req } = a.requirement_id ? await db.from("requirement").select("*").eq("workspace_id", ws).eq("id", a.requirement_id).maybeSingle() : { data: null };
  const reqView = req ? Object.fromEntries(Object.entries(req as Row).filter(([k]) => !["row_version", "updated_at", "created_at"].includes(k))) : null;
  const assets = (a.asset_ids ?? []) as string[];
  const { data: spaces } = assets.length ? await db.from("space").select("id").eq("workspace_id", ws).in("asset_id", assets) : { data: [] as Row[] };
  const spaceIds = ((spaces ?? []) as Row[]).map((s) => s.id);
  const { data: quotes } = spaceIds.length ? await db.from("quote").select("id, version, superseded_by").eq("workspace_id", ws).in("space_id", spaceIds) : { data: [] as Row[] };
  const q = ((quotes ?? []) as Row[]).map((x) => `${x.id}:${x.version}:${x.superseded_by ?? ""}`).sort();
  return stableHashLite({ req: reqView, assets: [...assets].sort(), quotes: q, modelId: inp.modelId ?? null, manual: ((inp.properties ?? []) as Row[]).filter((p) => p.source === "manual") });
}

/** Recalculate draft/ready property comparisons through Module 8 (new immutable version; old versions kept). */
async function recalcComparisons(c: StepCtx, analyses: Row[], why: string): Promise<StepOutcome> {
  const actor = c.actor ?? (await workspaceOwner(c.db, c.ws));
  if (!actor) throw new PermanentError("No workspace owner to attribute the recalculation to.");
  const refs: Ref[] = []; const warned: string[] = []; const flagged: string[] = []; const unchanged: string[] = [];
  for (const a of analyses) {
    if (a.status === "approved") {
      await markEntity(c.db, c.ws, { entityType: "deal_analysis", entityId: a.id, mark: "outdated_warning", reason: `Approved analysis "${a.title}" uses outdated inputs (${why}). Not changed — re-run and re-approve if needed.`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: c.input.causeType, causeId: c.input.causeId, dedupeKey: `${c.idempotencyKey}:warn:${a.id}`, owner: a.owner_user_id });
      warned.push(a.id); refs.push({ type: "deal_analysis", id: a.id, label: `${a.title} (approved — warned)` });
      continue;
    }
    if (a.kind === "property_comparison") {
      const inp = (a.inputs ?? {}) as Row;
      const manual = ((inp.properties ?? []) as Row[]).filter((p) => p.source === "manual");
      // Idempotent on retry: a version already written by this execution step (note carries the key) is reused.
      const tagNote = `Recalculated by the orchestrator: ${why} [${c.idempotencyKey}]`;
      const { data: prior } = await c.db.from("deal_analysis_version").select("version").eq("workspace_id", c.ws).eq("analysis_id", a.id).eq("note", tagNote).maybeSingle();
      // Skip when nothing the comparison reads has changed since the last orchestrator recalculation (no piling versions).
      const inputsHash = await comparisonInputsHash(c.db, c.ws, a);
      if (!prior) {
        const { data: last } = await c.db.from("reassessment_mark").select("detail").eq("workspace_id", c.ws).eq("entity_type", "deal_analysis").eq("entity_id", a.id).eq("mark", "needs_refresh").not("detail->>inputs_hash", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (last?.detail?.inputs_hash === inputsHash && Number(last.detail.new_version) === Number(a.current_version)) {
          unchanged.push(a.id); refs.push({ type: "deal_analysis", id: a.id, label: `${a.title} (inputs unchanged — kept v${a.current_version})` });
          continue;
        }
      }
      const r = prior ? { version: prior.version as number } : await runComparison(c.db, c.ws, actor, { id: a.id, title: a.title, requirementId: a.requirement_id, assetIds: a.asset_ids ?? [], manual: manual as never, modelId: inp.modelId ?? null, termMonths: inp.requirement?.termMonths ?? null, note: tagNote });
      refs.push({ type: "deal_analysis", id: a.id, label: `${a.title} → v${r.version}` });
      await markEntity(c.db, c.ws, { entityType: "deal_analysis", entityId: a.id, mark: "needs_refresh", reason: `Recalculated (v${r.version}) after ${why} — review the new result.`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: c.input.causeType, causeId: c.input.causeId, dedupeKey: `${c.idempotencyKey}:recalc:${a.id}`, detail: { previous_version: a.current_version, new_version: r.version, inputs_hash: inputsHash, recalculated: true }, owner: a.owner_user_id });
    } else {
      // Other calculators need user-entered inputs: flag for refresh instead of guessing (S5/S6).
      await markEntity(c.db, c.ws, { entityType: "deal_analysis", entityId: a.id, mark: "needs_refresh", reason: `"${a.title}" may be outdated after ${why}; open it and re-run.`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: c.input.causeType, causeId: c.input.causeId, dedupeKey: `${c.idempotencyKey}:flag:${a.id}`, owner: a.owner_user_id });
      flagged.push(a.id); refs.push({ type: "deal_analysis", id: a.id, label: `${a.title} (needs refresh)` });
    }
  }
  const recalculated = refs.filter((r) => r.label?.includes("→")).map((r) => r.id);
  return { status: analyses.length ? "done" : "skipped", reason: analyses.length ? `${recalculated.length} recalculated, ${unchanged.length} unchanged (skipped), ${flagged.length} flagged for refresh, ${warned.length} approved left unchanged (warned).` : "No affected analyses.", refs, output: { recalculated, flagged, warned, unchanged } };
}

/** Proposal drafts → needs_refresh; approved/released (shared) documents → outdated_warning. Never edited. */
async function flagProposals(c: StepCtx, out: Affected, why: string): Promise<StepOutcome> {
  const refs: Ref[] = []; let warn = 0;
  for (const d of out.deliverables) {
    const approved = d.status === "approved";
    if (approved) warn++;
    await markEntity(c.db, c.ws, { entityType: "deal_analysis", entityId: d.id, mark: approved ? "outdated_warning" : "needs_refresh", reason: `Proposal "${d.title}" was built from inputs that changed (${why}).${approved ? " It is approved/shared — it was NOT changed; regenerate to update." : " Regenerate before sending."}`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: c.input.causeType, causeId: c.input.causeId, dedupeKey: `${c.idempotencyKey}:proposal:${d.id}`, owner: d.owner_user_id });
    refs.push({ type: "deal_analysis", id: d.id, label: d.title });
  }
  for (const doc of out.documents) {
    const shared = doc.status === "approved" || doc.status === "released";
    if (shared) warn++;
    await markEntity(c.db, c.ws, { entityType: "document_version", entityId: doc.id, mark: shared ? "outdated_warning" : "needs_refresh", reason: `${doc.purpose ?? "Document"} uses outdated figures (${why}).${shared ? " Already approved/shared — not overwritten." : ""}`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: c.input.causeType, causeId: c.input.causeId, dedupeKey: `${c.idempotencyKey}:doc:${doc.id}`, owner: doc.owner_user_id });
    refs.push({ type: "document_version", id: doc.id, label: doc.purpose ?? "document" });
  }
  return { status: refs.length ? "done" : "skipped", reason: refs.length ? `${refs.length} proposal output(s) flagged; ${warn} approved/shared warned, none overwritten.` : "No proposals use these inputs.", refs, output: { flagged: refs.length, warned: warn } };
}

// ------------------------------------------------------------------ Example 1: new rent quotation
registerWorkflow({
  key: "reassess.quote", name: "Reassess after new rent quotation", module: "orchestrator",
  description: "Finds comparisons and proposals that use the property's quotes, recalculates comparisons through the Deal Toolkit, flags proposals, keeps old quotes and versions.",
  trigger: { type: "event", events: ["commercial.quote_received"] }, priority: 80, timeoutMs: 30 * 60_000, inputs: ["quoteId", "eventId"],
  steps: [
    { key: "identify", label: "Identify affected property, requirements and outputs", module: "deals", run: async (c) => {
      const { data: q } = await c.db.from("quote").select("id, version, space_id, requirement_id, superseded_by, space:space_id(asset_id, asset:asset_id(name))").eq("workspace_id", c.ws).eq("id", c.input.quoteId).maybeSingle();
      if (!q) throw new PermanentError("Quote not found.");
      const assetId = (q.space as Row | null)?.asset_id ?? null;
      const reqIds = new Set<string>(q.requirement_id ? [q.requirement_id] : []);
      if (assetId) for (const s of ((await c.db.from("shortlist_option").select("requirement_id").eq("workspace_id", c.ws).eq("asset_id", assetId).is("archived_at", null)).data ?? []) as Row[]) reqIds.add(s.requirement_id);
      if (!assetId && !reqIds.size) return { status: "skipped", reason: "Quote is not linked to a property or requirement — nothing to reassess.", output: { assetId: null, requirementIds: [], analyses: [], deliverables: [], documents: [] } };
      const out = await findOutputs(c.db, c.ws, { requirementIds: [...reqIds], assetId });
      const { data: opps } = reqIds.size ? await c.db.from("opportunity").select("id, name").eq("workspace_id", c.ws).in("requirement_id", [...reqIds]).is("archived_at", null) : { data: [] as Row[] };
      const { data: prev } = q.space_id ? await c.db.from("quote").select("id, version").eq("workspace_id", c.ws).eq("space_id", q.space_id).neq("id", q.id) : { data: [] as Row[] };
      return { status: "done", reason: `${out.analyses.length} analyses, ${out.deliverables.length + out.documents.length} proposal outputs, ${(opps ?? []).length} opportunities affected; ${(prev ?? []).length} earlier quote(s) kept.`,
        refs: [{ type: "quote", id: q.id, label: `Quote v${q.version}` }, ...(assetId ? [{ type: "asset", id: assetId, label: (q.space as Row)?.asset?.name ?? "property" }] : []), ...[...reqIds].map((id) => ({ type: "requirement", id })), ...((opps ?? []) as Row[]).map((o) => ({ type: "opportunity", id: o.id, label: o.name }))],
        output: { assetId, requirementIds: [...reqIds], ...out, previousQuotes: prev ?? [] } };
    } },
    { key: "recalculate", label: "Recalculate comparisons (Deal Toolkit)", module: "toolkit", dependsOn: ["identify"], timeoutMs: 60_000,
      run: (c) => recalcComparisons(c, (c.outputs.identify?.analyses ?? []) as Row[], "a new rent quotation") },
    { key: "flag_proposals", label: "Flag proposals using the old quotation", module: "toolkit", dependsOn: ["identify"],
      run: (c) => flagProposals(c, c.outputs.identify as Affected, "a new rent quotation") },
    { key: "warn", label: "Warn about approved/shared outputs", module: "orchestrator", dependsOn: ["recalculate", "flag_proposals"], run: async (c) => {
      const warned = (c.outputs.recalculate?.warned?.length ?? 0) + (c.outputs.flag_proposals?.warned ?? 0);
      if (!warned) return { status: "skipped", reason: "No approved or shared output is affected." };
      const uid = await notifyUser(c.db, c.ws, c.actor, { title: "New quotation affects approved outputs", body: `${warned} approved or shared output(s) use the previous quotation. They were not changed — review and regenerate if needed.`, groupKey: `reassess:quote:${c.input.quoteId}`, dedupeKey: `${c.idempotencyKey}`, refs: [{ type: "quote", id: c.input.quoteId }] });
      return { status: "done", reason: `User notified about ${warned} approved/shared output(s).`, refs: uid ? [{ type: "user", id: uid }] : [] };
    } },
  ],
});

// ------------------------------------------------------------------ Example 2: requirement changed
registerWorkflow({
  key: "reassess.requirement", name: "Reassess after requirement change", module: "orchestrator",
  description: "After an authorised requirement update: re-runs comparisons, rescoring (incl. requirement readiness), flags outdated proposals, notifies the responsible user. History stays in the audit log.",
  trigger: { type: "event", events: ["commercial.requirement_changed"] }, priority: 80, timeoutMs: 30 * 60_000, inputs: ["requirementId", "changed", "eventId"],
  steps: [
    { key: "identify", label: "Identify affected comparisons and proposals", module: "deals", run: async (c) => {
      const { data: r } = await c.db.from("requirement").select("id, title, org_id, owner_user_id").eq("workspace_id", c.ws).eq("id", c.input.requirementId).maybeSingle();
      if (!r) throw new PermanentError("Requirement not found.");
      const out = await findOutputs(c.db, c.ws, { requirementIds: [r.id] });
      return { status: "done", reason: `${out.analyses.length} analyses and ${out.deliverables.length + out.documents.length} proposal outputs depend on this requirement.`, refs: [{ type: "requirement", id: r.id, label: r.title }], output: { requirement: r, ...out } };
    } },
    { key: "recalculate", label: "Re-run suitability / comparisons (Deal Toolkit)", module: "toolkit", dependsOn: ["identify"], timeoutMs: 60_000,
      run: (c) => recalcComparisons(c, (c.outputs.identify?.analyses ?? []) as Row[], "a requirement change") },
    { key: "rescore", label: "Reassess scores and requirement readiness (Scoring)", module: "scoring", dependsOn: ["identify"], run: async (c) => {
      const org = c.outputs.identify?.requirement?.org_id;
      if (!org) return { status: "skipped", reason: "Requirement has no company." };
      const res = await recalcOrg(c.db, c.ws, org, "orchestrator:requirement_changed");
      return { status: "done", reason: `${res.length} score(s) recalculated.`, refs: [{ type: "organisation", id: org }] };
    } },
    { key: "flag_proposals", label: "Identify outdated proposals", module: "toolkit", dependsOn: ["identify"],
      run: (c) => flagProposals(c, c.outputs.identify as Affected, "a requirement change") },
    { key: "notify", label: "Notify the responsible user", module: "orchestrator", dependsOn: ["recalculate", "rescore", "flag_proposals"], run: async (c) => {
      const r = c.outputs.identify.requirement as Row;
      const changed = describeRequirementChanges(c.input.changed);
      const uid = await notifyUser(c.db, c.ws, r.owner_user_id ?? c.actor, { groupKey: `reassess:requirement:${r.id}`, link: `/requirements/${r.id}`, title: `Requirement changed: ${r.title}`, body: `${changed}. ${c.outputs.recalculate?.recalculated?.length ?? 0} comparison(s) recalculated, ${c.outputs.flag_proposals?.flagged ?? 0} proposal output(s) flagged. Earlier values remain in the history.`, dedupeKey: c.idempotencyKey, refs: [{ type: "requirement", id: r.id }] });
      return { status: uid ? "done" : "skipped", reason: uid ? "Responsible user notified." : "No responsible user.", refs: uid ? [{ type: "user", id: uid }] : [] };
    } },
  ],
});

// ------------------------------------------------------------------ Example 3: meeting cancelled
registerWorkflow({
  key: "reassess.meeting_cancelled", name: "Meeting cancelled — clean up", module: "orchestrator",
  description: "Cancels preparation reminders and meeting-specific pending tasks/jobs; keeps the meeting history and every commitment.",
  trigger: { type: "event", events: ["meeting.cancelled"] }, priority: 70, timeoutMs: 15 * 60_000, inputs: ["meetingId", "eventId"],
  steps: [
    { key: "identify", label: "Find meeting preparation", module: "meetings", run: async (c) => {
      const { data: m } = await c.db.from("meeting_visit").select("id, title, status").eq("workspace_id", c.ws).eq("id", c.input.meetingId).maybeSingle();
      if (!m) throw new PermanentError("Meeting not found.");
      if (m.status !== "cancelled") return { status: "skipped", reason: `Meeting is ${m.status} again — nothing cancelled.`, output: { preps: [], meeting: m } };
      const { data: preps } = await c.db.from("meeting_prep").select("id, owner_user_id").eq("workspace_id", c.ws).eq("meeting_visit_id", m.id);
      return { status: "done", reason: `Meeting "${m.title ?? ""}" cancelled; ${(preps ?? []).length} preparation record(s) kept.`, refs: [{ type: "meeting_visit", id: m.id, label: m.title ?? "meeting" }], output: { meeting: m, preps: preps ?? [] } };
    } },
    { key: "cancel_reminders", label: "Cancel preparation reminders and meeting-specific tasks", module: "meetings", dependsOn: ["identify"], run: async (c) => {
      const preps = ((c.outputs.identify?.preps ?? []) as Row[]).map((p) => p.id);
      const ids = [...preps, c.input.meetingId];
      // Meeting-specific = reminders/prep tasks linked to the meeting or its prep. Commitment tasks (idempotency
      // "meeting:<prep>:<n>", created from outcomes) are commitments, not reminders — they stay.
      const { data: tasks } = await c.db.from("task").select("id, title, idempotency_key, linked_entity_type").eq("workspace_id", c.ws).in("status", ["open", "snoozed"]).in("linked_entity_id", ids);
      const toCancel = ((tasks ?? []) as Row[]).filter((t) => !/^meeting:[^:]+:\d+$/.test(t.idempotency_key ?? "") && (/^meeting-remind:/.test(t.idempotency_key ?? "") || /^prepare for/i.test(t.title) || t.linked_entity_type === "meeting_visit"));
      if (toCancel.length) await c.db.from("task").update({ status: "cancelled", completion_evidence: "Meeting cancelled (orchestrator)" }).eq("workspace_id", c.ws).in("id", toCancel.map((t) => t.id));
      // Pending background jobs for this meeting (brief generation etc.).
      let jobs = 0;
      for (const id of ids) {
        const { data } = await c.db.from("job").update({ state: "cancelled", last_error: "Meeting cancelled" }).eq("workspace_id", c.ws).eq("state", "queued").or(`payload->>prepId.eq.${id},payload->>prep_id.eq.${id},payload->>meetingId.eq.${id},payload->>meeting_id.eq.${id}`).select("id");
        jobs += (data ?? []).length;
      }
      return { status: "done", reason: `${toCancel.length} reminder/prep task(s) and ${jobs} queued job(s) cancelled; meeting record kept.`, refs: toCancel.map((t) => ({ type: "task", id: t.id, label: t.title })), output: { cancelledTasks: toCancel.map((t) => t.id), jobs } };
    } },
    { key: "commitments", label: "Check other commitments still active", module: "orchestrator", dependsOn: ["cancel_reminders"], run: async (c) => {
      const preps = ((c.outputs.identify?.preps ?? []) as Row[]);
      const { data: open } = preps.length ? await c.db.from("task").select("id, title").eq("workspace_id", c.ws).in("status", ["open", "snoozed"]).in("linked_entity_id", preps.map((p) => p.id)) : { data: [] as Row[] };
      if (!(open ?? []).length) return { status: "skipped", reason: "No other commitments linked to this meeting." };
      const uid = await notifyUser(c.db, c.ws, preps[0]?.owner_user_id ?? c.actor, { category: "commitment", title: "Meeting cancelled — commitments still open", body: `${(open ?? []).length} commitment(s) from this meeting remain active: ${(open ?? []).slice(0, 3).map((t: Row) => t.title).join("; ")}`, dedupeKey: c.idempotencyKey, refs: [{ type: "meeting_visit", id: c.input.meetingId }] });
      return { status: "done", reason: `${(open ?? []).length} commitment(s) kept active; user notified.`, refs: [...((open ?? []) as Row[]).map((t) => ({ type: "task", id: t.id, label: t.title })), ...(uid ? [{ type: "user", id: uid }] : [])] };
    } },
  ],
});

// ------------------------------------------------------------------ Example 4: contact changes employer
registerWorkflow({
  key: "reassess.employment", name: "Contact changed employer — review", module: "orchestrator",
  description: "Keeps employment history, flags stakeholder maps and opportunities at the previous employer for review, creates one review task. Never moves opportunities.",
  trigger: { type: "event", events: ["contact.employment_changed"] }, priority: 60, timeoutMs: 15 * 60_000, inputs: ["personId", "employmentId", "newOrgId", "eventId"],
  steps: [
    { key: "identify", label: "Find previous employment and associations", module: "contacts", run: async (c) => {
      const { data: emps } = await c.db.from("employment").select("id, org_id, is_current, title, org:org_id(display_name)").eq("workspace_id", c.ws).eq("person_id", c.input.personId);
      const prev = ((emps ?? []) as Row[]).filter((e) => e.id !== c.input.employmentId && e.org_id !== c.input.newOrgId);
      const prevOrgs = [...new Set(prev.map((e) => e.org_id))];
      const [{ data: sh }, { data: opps }, { data: person }] = await Promise.all([
        c.db.from("stakeholder").select("id, requirement_id, role").eq("workspace_id", c.ws).eq("person_id", c.input.personId).is("archived_at", null),
        prevOrgs.length ? c.db.from("opportunity").select("id, name, org_id").eq("workspace_id", c.ws).in("org_id", prevOrgs).eq("outcome", "open").is("archived_at", null) : Promise.resolve({ data: [] as Row[] }),
        c.db.from("person").select("full_name").eq("workspace_id", c.ws).eq("id", c.input.personId).maybeSingle(),
      ]);
      return { status: "done", reason: `${prev.length} earlier employment(s) kept; ${(sh ?? []).length} stakeholder entries and ${(opps ?? []).length} open opportunities to review.`, refs: [{ type: "person", id: c.input.personId, label: person?.full_name }], output: { name: person?.full_name ?? "Contact", prev, stakeholders: sh ?? [], opportunities: opps ?? [] } };
    } },
    { key: "flag", label: "Flag stakeholder maps and opportunity associations for review", module: "orchestrator", dependsOn: ["identify"], run: async (c) => {
      const x = c.outputs.identify as Row; const refs: Ref[] = [];
      for (const s of x.stakeholders as Row[]) {
        await markEntity(c.db, c.ws, { entityType: "stakeholder", entityId: s.id, mark: "review", reason: `${x.name} changed employer — check this stakeholder role is still valid.`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: "employment", causeId: c.input.employmentId, dedupeKey: `${c.idempotencyKey}:sh:${s.id}` });
        refs.push({ type: "stakeholder", id: s.id });
      }
      for (const o of x.opportunities as Row[]) {
        await markEntity(c.db, c.ws, { entityType: "opportunity", entityId: o.id, mark: "review", reason: `${x.name} left this company. The opportunity stays with the company (not moved) — review contacts.`, runId: c.runId, eventId: c.input.eventId ?? null, causeType: "employment", causeId: c.input.employmentId, dedupeKey: `${c.idempotencyKey}:opp:${o.id}` });
        refs.push({ type: "opportunity", id: o.id, label: o.name });
      }
      return { status: refs.length ? "done" : "skipped", reason: refs.length ? `${refs.length} association(s) flagged; nothing moved.` : "No stakeholder or opportunity associations.", refs };
    } },
    { key: "review_task", label: "Create relationship review task", module: "brief", dependsOn: ["identify"], run: async (c) => {
      const x = c.outputs.identify as Row;
      const owner = c.actor ?? (await workspaceOwner(c.db, c.ws));
      const key = `orch:employment:${c.input.employmentId}:review`;
      const { data: ex } = await c.db.from("task").select("id").eq("workspace_id", c.ws).eq("idempotency_key", key).maybeSingle();
      if (ex) return { status: "done", reason: "Review task already exists.", refs: [{ type: "task", id: ex.id }] };
      const { data, error } = await c.db.from("task").insert({ workspace_id: c.ws, title: `Review relationships: ${x.name} changed employer`, description: "Employment history is kept. Check stakeholder roles and opportunity contacts at the previous company. Opportunities were not moved.", assigned_user_id: owner, owner_user_id: owner, linked_entity_type: "person", linked_entity_id: c.input.personId, source: "workflow", idempotency_key: key, priority: 60 }).select("id").single();
      if (error) { if (error.code === "23505") return { status: "done", reason: "Review task already exists." }; throw new Error(error.message); }
      return { status: "done", reason: "Review task created.", refs: [{ type: "task", id: data.id }] };
    } },
  ],
});

// ------------------------------------------------------------------ Example 5: source outage
registerWorkflow({
  key: "reassess.integration_failed", name: "Source outage — mark stale data", module: "orchestrator",
  description: "Records the failure, shows the last successful update, marks dependent data potentially stale, schedules retry, alerts when important.",
  trigger: { type: "event", events: ["integration.failed"] }, priority: 75, timeoutMs: 10 * 60_000, inputs: ["source", "error", "subjectId"],
  steps: [
    { key: "record", label: "Record failure and retry policy", module: "integrations", run: async (c) => {
      const h = await recordIntegrationFailure(c.db, c.ws, c.input.source, c.input.error ?? "Source unavailable", { affects: c.input.subjectId ? [{ type: c.input.subjectType ?? "connector_account", id: c.input.subjectId }] : [] , now: c.now });
      return { status: "done", reason: `Failure ${h.consecutive_failures} recorded; last success ${h.last_success_at ?? "never"}; next retry ${h.next_retry_at}.`, output: h };
    } },
    { key: "mark_stale", label: "Mark affected information potentially stale", module: "orchestrator", dependsOn: ["record"], run: async (c) => {
      const h = c.outputs.record as Row;
      const affects = (h.affects ?? []) as { type: string; id: string }[];
      for (const a of affects) await markEntity(c.db, c.ws, { entityType: a.type, entityId: a.id, mark: "stale", reason: `${h.label ?? h.source_key} unavailable since ${h.last_failure_at}; last successful update ${h.last_success_at ?? "unknown"}.`, runId: c.runId, causeType: `integration:${h.source_key}`, dedupeKey: `stale:${h.source_key}:${a.type}:${a.id}:${h.last_success_at ?? "never"}` });
      return { status: affects.length ? "done" : "skipped", reason: affects.length ? `${affects.length} record(s) marked potentially stale.` : "No dependent records registered for this source.", refs: affects };
    } },
    { key: "alert", label: "Alert if decisions are affected", module: "orchestrator", dependsOn: ["record"], run: async (c) => {
      const h = c.outputs.record as Row;
      if ((h.consecutive_failures ?? 0) < 3 && !c.input.important) return { status: "skipped", reason: "Below alert threshold (3 consecutive failures) — retrying quietly." };
      const uid = await notifyUser(c.db, c.ws, null, { category: "source_health", groupKey: `reassess:outage:${h.source_key}`, title: `${h.label ?? h.source_key} is unavailable`, body: `Last successful update: ${h.last_success_at ?? "never"}. Data from this source may be stale. Reconnect in Settings → Connections if it does not recover.`, dedupeKey: `orch:outage:${h.source_key}:${String(h.last_failure_at).slice(0, 13)}`, link: "/settings/connections" });
      return { status: "done", reason: "User alerted.", refs: uid ? [{ type: "user", id: uid }] : [] };
    } },
  ],
});

registerWorkflow({
  key: "reassess.integration_recovered", name: "Source recovered", module: "orchestrator",
  description: "Marks the source healthy and resolves its stale-data marks.",
  trigger: { type: "event", events: ["integration.recovered"] }, priority: 40, inputs: ["source"],
  steps: [{ key: "record", label: "Record recovery", module: "integrations", run: async (c) => {
    const h = await recordIntegrationSuccess(c.db, c.ws, c.input.source, c.now);
    return { status: "done", reason: `Healthy since ${h.last_success_at}.` };
  } }],
});
