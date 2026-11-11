/**
 * Demo data for the "automation" tutorial videos (Module 9 Orchestrator). Local Supabase + demo workspace ONLY.
 * Runs the app's own services (no worker is running locally, so this plays the role of the scheduler):
 *   - a Zentrix meeting ~65 min from now → prep job scheduled → prep run (brief + "Brief ready" notification)
 *   - a change to the Zentrix requirement (area max 28,000 ⇄ 30,000 sf) → event → reassess.requirement → outdated marks
 *   - a "Prepare meetings" run whose commitments step is marked failed (synthetic failure, so Retry has something to fix)
 *   - a queued run that is paused (for Resume / Cancel)
 *   - this week's weekly review and a little recorded research usage (for Budgets & usage)
 * Re-runnable: previous tutorial runs (dedupe "tut-auto:%"), the earlier demo meeting, open marks and orchestrator
 * notifications in the demo workspace are removed first.
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-automation.ts
 */
import { DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER, did } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";
import "@/modules/orchestrator/reassess/workflows";
import { PREPARE_MEETINGS } from "@/modules/orchestrator/ui/workflows";
import { runWorkflow, startExecution } from "@/modules/orchestrator/engine/runner";
import { pauseExecution } from "@/modules/orchestrator/engine/controls";
import { dispatch } from "@/modules/orchestrator/jobs";
import { scheduleMeetingPreps, runMeetingPrep } from "@/modules/orchestrator/schedule/meetings";
import { runWeeklyReview } from "@/modules/orchestrator/schedule/weekly";
import { recordUsage } from "@/modules/orchestrator/budget/service";
import { createMeeting } from "@/modules/meetings/service";

type Row = Record<string, any>;
const ZENTRIX = did("tutorial:organisation", "zentrix");
const REQ = did("tutorial:requirement", "zentrix-25k");
const MEETING_TITLE = "Zentrix — requirement review (automation demo)";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createAdminClient();
  const must = async <T,>(p: PromiseLike<{ data: T; error: { message: string } | null }>) => { const r = await p; if (r.error) throw new Error(r.error.message); return r.data; };

  // ---- clean previous tutorial state (demo workspace only)
  const old = (await must(db.from("workflow_run").select("id").eq("workspace_id", WS).eq("kind", "orchestrated"))) as Row[];
  if (old.length) {
    const ids = old.map((r) => r.id);
    await must(db.from("workflow_audit_log").delete().eq("workspace_id", WS).in("run_id", ids));
    await must(db.from("workflow_step").delete().eq("workspace_id", WS).in("run_id", ids));
    await must(db.from("reassessment_mark").delete().eq("workspace_id", WS));
    await must(db.from("workflow_run").delete().eq("workspace_id", WS).in("id", ids));
  }
  await must(db.from("reassessment_mark").delete().eq("workspace_id", WS));
  const notes = (await must(db.from("notification_state").select("outbox_id").eq("workspace_id", WS))) as Row[];
  if (notes.length) {
    await must(db.from("notification_state").delete().eq("workspace_id", WS));
    await must(db.from("outbox").delete().eq("workspace_id", WS).in("id", notes.map((n) => n.outbox_id)));
  }
  // reassess workflows write their notice straight to outbox (no notification_state row)
  await must(db.from("outbox").delete().eq("workspace_id", WS).eq("kind", "notification").like("payload->>title", "Requirement changed: Zentrix%"));
  await must(db.from("orch_plan").delete().eq("workspace_id", WS));
  await must(db.from("resource_budget").delete().eq("workspace_id", WS));
  await must(db.from("resource_usage").delete().eq("workspace_id", WS));
  // mark old orchestrator events processed so only our new change is reassessed
  await db.from("event_outbox").update({ status: "processed" }).eq("workspace_id", WS).neq("status", "processed");
  const oldMv = (await must(db.from("meeting_visit").select("id").eq("workspace_id", WS).eq("title", MEETING_TITLE).is("archived_at", null))) as Row[];
  if (oldMv.length) {
    const now = new Date().toISOString();
    await must(db.from("meeting_prep").update({ archived_at: now }).eq("workspace_id", WS).in("meeting_visit_id", oldMv.map((m) => m.id)));
    await must(db.from("meeting_visit").update({ archived_at: now }).eq("workspace_id", WS).in("id", oldMv.map((m) => m.id)));
  }
  await must(db.from("job").update({ state: "cancelled", last_error: "cancelled: tutorial reset" }).eq("workspace_id", WS).eq("job_type", "orchestrator.meeting_prep").eq("state", "queued"));

  // ---- 1. meeting ~65 minutes from now → prep job → brief + notification
  const start = new Date(Math.ceil((Date.now() + 65 * 60_000) / 300_000) * 300_000);
  const m = await createMeeting(db as never, WS, OWNER, { title: MEETING_TITLE, start: start.toISOString(), orgId: ZENTRIX, requirementId: REQ, type: "requirement", purpose: "Review the updated area range and next steps." } as never);
  const sched = await scheduleMeetingPreps(db, WS, { prepId: m.id });
  const prep = await runMeetingPrep(db, WS, { prepId: m.id, startAt: start.toISOString() });
  console.log("meeting", m.id, sched, prep);

  // ---- 2. requirement change → event → reassessment
  const r = (await must(db.from("requirement").select("area_max_sf").eq("workspace_id", WS).eq("id", REQ).single())) as Row;
  const next = Number(r.area_max_sf) === 30000 ? 28000 : 30000;
  await must(db.from("requirement").update({ area_max_sf: next }).eq("workspace_id", WS).eq("id", REQ));
  for (let i = 0; i < 3; i++) console.log("dispatch", JSON.stringify(await dispatch(WS)));

  // ---- 3. a failed run (synthetic failure on the last step, so Retry can fix it)
  const tz = "Asia/Kolkata";
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + 864e5));
  const f = await runWorkflow(db, WS, PREPARE_MEETINGS, { input: { date: tomorrow, tz, generateBriefs: false }, actor: OWNER, trigger: "user", dedupeKey: "tut-auto:failed" });
  const err = "Task list did not answer in time (timeout after 3 attempts) — demo failure.";
  await must(db.from("workflow_step").update({ status: "dead", error: err, error_class: "temporary", attempts: 3, max_attempts: 3, reason: null, output: null, output_refs: [] }).eq("workspace_id", WS).eq("run_id", f.id).eq("step_key", "commitments"));
  await must(db.from("workflow_run").update({ status: "failed", error: `Step "List open commitments" failed: ${err}`, finished_at: new Date().toISOString(), progress: 67 }).eq("workspace_id", WS).eq("id", f.id));
  console.log("failed run", f.id);

  // ---- 4. a paused run
  const pz = await startExecution(db, WS, PREPARE_MEETINGS, { input: { date: tomorrow, tz, generateBriefs: false }, actor: OWNER, trigger: "user", dedupeKey: "tut-auto:paused" });
  await pauseExecution(db, WS, pz.id, OWNER);
  console.log("paused run", pz.id);

  // ---- 5. weekly review + some usage
  try { console.log("weekly", JSON.stringify(await runWeeklyReview(db, WS, OWNER, { notify: false })).slice(0, 200)); } catch (e) { console.log("weekly failed", (e as Error).message); }
  for (let i = 0; i < 4; i++) await recordUsage(db, WS, { resource: "research", module: "research", units: 1, unit: "calls", workflow: "research.company", userId: OWNER });
  console.log("done");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
