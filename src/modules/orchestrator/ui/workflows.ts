import "server-only";
import { fromZonedTime } from "date-fns-tz";
import { generateBrief } from "@/modules/meetings/service";
import { runComparison } from "@/modules/toolkit/comparison";
import { recalcOrg } from "@/modules/scoring/service";
import { registerWorkflow } from "../engine/registry";
import { PermanentError, TemporaryError } from "../engine/plan";
import type { Ref } from "../engine/types";
import { resolveMark } from "../reassess/marks";
import { workspaceOwner } from "../reassess/workflows";

/**
 * User-started workflows used by the Automation UI and the assistant (Module 12). They only call existing module
 * services (meetings generateBrief, toolkit runComparison, scoring recalcOrg) — no business logic of their own,
 * nothing is sent (S3), approved outputs are never overwritten.
 */
type Row = Record<string, any>;

export const PREPARE_MEETINGS = "assist.prepare_meetings";
export const REFRESH_RECORD = "assist.refresh_record";

export function dayRange(date: string, tz: string) {
  return { start: fromZonedTime(`${date}T00:00:00`, tz).toISOString(), end: fromZonedTime(`${date}T23:59:59.999`, tz).toISOString() };
}

registerWorkflow({
  key: PREPARE_MEETINGS, name: "Prepare meetings and list open commitments", module: "meetings",
  description: "For one day (tomorrow by default): finds your meetings, prepares a brief for each meeting that has none yet, and lists commitments that are open or due by that day.",
  trigger: { type: "user" }, priority: 60, timeoutMs: 20 * 60_000, permissions: { role: "editor" }, inputs: ["date", "tz", "generateBriefs"],
  steps: [
    { key: "meetings", label: "Find the day's meetings", module: "meetings", run: async (c) => {
      const date = String(c.input.date ?? ""); const tz = String(c.input.tz ?? "Asia/Kolkata");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PermanentError("No valid date given (YYYY-MM-DD).");
      const r = dayRange(date, tz);
      const { data, error } = await c.db.from("meeting_visit").select("id, title, start_at, status, kind").eq("workspace_id", c.ws).is("archived_at", null)
        .neq("status", "cancelled").gte("start_at", r.start).lte("start_at", r.end).order("start_at").limit(50);
      if (error) throw new TemporaryError(error.message);
      const visits = (data ?? []) as Row[];
      const { data: preps } = visits.length ? await c.db.from("meeting_prep").select("id, meeting_visit_id, status, brief, readiness").eq("workspace_id", c.ws).in("meeting_visit_id", visits.map((v) => v.id)) : { data: [] as Row[] };
      const byVisit = new Map(((preps ?? []) as Row[]).map((p) => [p.meeting_visit_id, p]));
      const meetings = visits.map((v) => { const p = byVisit.get(v.id); return { id: v.id, title: v.title ?? "Untitled meeting", startAt: v.start_at, prepId: p?.id ?? null, hasBrief: !!p?.brief, readiness: p?.readiness ?? null }; });
      return { status: meetings.length ? "done" : "skipped", reason: meetings.length ? `${meetings.length} meeting(s) on ${date}.` : `No meetings on ${date}.`,
        refs: meetings.map((m) => (m.prepId ? { type: "meeting_prep", id: m.prepId, label: m.title } : { type: "meeting_visit", id: m.id, label: m.title })), output: { meetings, date } };
    } },
    { key: "prepare", label: "Prepare meeting briefs", module: "meetings", dependsOn: ["meetings"], timeoutMs: 5 * 60_000,
      condition: (c) => (c.input.generateBriefs === false ? "Brief preparation was not requested." : true),
      run: async (c) => {
        const meetings = (c.outputs.meetings?.meetings ?? []) as Row[];
        const todo = meetings.filter((m) => m.prepId && !m.hasBrief);
        const noPrep = meetings.filter((m) => !m.prepId);
        if (!todo.length) return { status: "skipped", reason: meetings.length ? `All meetings already have a brief${noPrep.length ? ` (${noPrep.length} have no preparation record — open them in Meetings)` : ""}.` : "No meetings to prepare." };
        const actor = c.actor ?? (await workspaceOwner(c.db, c.ws));
        if (!actor) throw new PermanentError("No user to attribute the briefs to.");
        const done: Ref[] = []; const failed: string[] = [];
        for (const m of todo) {
          try { await generateBrief(c.db, c.ws, actor, m.prepId); done.push({ type: "meeting_prep", id: m.prepId, label: m.title }); }
          catch (e) { failed.push(`${m.title}: ${e instanceof Error ? e.message : String(e)}`); }
        }
        if (!done.length) throw new TemporaryError(`Could not prepare any brief — ${failed.join("; ")}`);
        return { status: "done", reason: `${done.length} brief(s) prepared${failed.length ? `, ${failed.length} failed (${failed.join("; ")})` : ""}.`, refs: done, output: { prepared: done.map((d) => d.id), failed } };
      } },
    { key: "commitments", label: "List open commitments", module: "tasks", run: async (c) => {
      const date = String(c.input.date ?? ""); const tz = String(c.input.tz ?? "Asia/Kolkata");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PermanentError("No valid date given (YYYY-MM-DD).");
      const end = dayRange(date, tz).end;
      const { data, error } = await c.db.from("task").select("id, title, due_at, linked_entity_type, linked_entity_id").eq("workspace_id", c.ws).is("archived_at", null)
        .eq("status", "open").or(`due_at.lte.${end},due_at.is.null`).order("due_at", { ascending: true, nullsFirst: false }).limit(50);
      if (error) throw new TemporaryError(error.message);
      const items = ((data ?? []) as Row[]).map((t) => ({ id: t.id, title: t.title, due: t.due_at, overdue: !!t.due_at && Date.parse(t.due_at) < +c.now }));
      return { status: items.length ? "done" : "skipped", reason: items.length ? `${items.length} open commitment(s), ${items.filter((i) => i.overdue).length} overdue.` : "No open commitments.",
        refs: items.map((i) => ({ type: "task", id: i.id, label: i.title })), output: { items } };
    } },
  ],
});

/** "Refresh" on a needs-refresh / outdated banner. Recalculates where a deterministic calculator exists; else explains. */
registerWorkflow({
  key: REFRESH_RECORD, name: "Refresh an out-of-date record", module: "orchestrator",
  description: "Brings one flagged analysis or requirement up to date using the owning module's calculator. Approved or shared outputs are never overwritten.",
  trigger: { type: "user" }, priority: 70, timeoutMs: 10 * 60_000, permissions: { role: "editor" }, inputs: ["markId", "entityType", "entityId"],
  steps: [
    { key: "refresh", label: "Recalculate", module: "toolkit", timeoutMs: 120_000, run: async (c) => {
      const { entityType, entityId } = c.input as { entityType: string; entityId: string };
      if (entityType === "deal_analysis") {
        const { data: a } = await c.db.from("deal_analysis").select("id, kind, title, status, requirement_id, asset_ids, inputs").eq("workspace_id", c.ws).eq("id", entityId).maybeSingle();
        if (!a) throw new PermanentError("Analysis not found (or not visible to you).");
        if (a.status === "approved") return { status: "done", reason: `"${a.title}" is approved, so it was not changed. Open it and save a new version if the new figures should be used.`, output: { refreshed: false } };
        if (a.kind !== "property_comparison") return { status: "done", reason: `"${a.title}" uses figures you entered — open it, check the inputs and run it again.`, output: { refreshed: false } };
        const actor = c.actor ?? (await workspaceOwner(c.db, c.ws));
        if (!actor) throw new PermanentError("No user to attribute the recalculation to.");
        const inp = (a.inputs ?? {}) as Row;
        const note = `Refreshed from Automation [${c.idempotencyKey}]`;
        const { data: prior } = await c.db.from("deal_analysis_version").select("version").eq("workspace_id", c.ws).eq("analysis_id", a.id).eq("note", note).maybeSingle();
        const r = prior ? { version: prior.version as number } : await runComparison(c.db, c.ws, actor, { id: a.id, title: a.title, requirementId: a.requirement_id, assetIds: a.asset_ids ?? [], manual: ((inp.properties ?? []) as Row[]).filter((p) => p.source === "manual") as never, modelId: inp.modelId ?? null, termMonths: inp.requirement?.termMonths ?? null, note });
        return { status: "done", reason: `Recalculated — new version v${r.version}; earlier versions are kept.`, refs: [{ type: "deal_analysis", id: a.id, label: `${a.title} v${r.version}` }], output: { refreshed: true } };
      }
      if (entityType === "requirement") {
        const { data: r } = await c.db.from("requirement").select("id, title, org_id").eq("workspace_id", c.ws).eq("id", entityId).maybeSingle();
        if (!r) throw new PermanentError("Requirement not found (or not visible to you).");
        if (!r.org_id) return { status: "done", reason: "The requirement has no company, so there is no score to recalculate. Check its comparisons from the requirement page.", output: { refreshed: false } };
        await recalcOrg(c.db, c.ws, r.org_id, "orchestrator.refresh");
        return { status: "done", reason: "Scores for this client recalculated.", refs: [{ type: "requirement", id: r.id, label: r.title }], output: { refreshed: true } };
      }
      return { status: "done", reason: "This kind of record cannot be refreshed automatically — open it and check it.", output: { refreshed: false } };
    } },
    { key: "resolve", label: "Clear the warning", module: "orchestrator", dependsOn: ["refresh"], run: async (c) => {
      if (!c.outputs.refresh?.refreshed) return { status: "skipped", reason: "Warning kept until you update the record yourself." };
      const markId = String(c.input.markId ?? "");
      if (markId) await resolveMark(c.db, c.ws, markId, "resolved");
      return { status: "done", reason: "Warning cleared." };
    } },
  ],
});
