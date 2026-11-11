// Tutorial videos — group "automation": Module 9 Orchestrator (Automation pages, daily plan, meeting briefs, failed jobs,
// outdated proposals, budgets & notifications, Ask AI → workflow). Captions describe only what is on screen (mock AI).
// Demo data: setup-automation.ts (run in prepare; demo workspace only, synthetic).
const path = require("path");
const { execFileSync } = require("child_process");
const { sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const WS = "de000000-0000-4000-8000-000000000001";
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", q], { stdio: "pipe" }).toString().trim();
const setup = () => execFileSync("npx", ["tsx", "--require", "./scripts/assistant-evals.preload.cjs", "--env-file=.env.local",
  "scripts/tutorial-videos/setup-automation.ts"], { cwd: ROOT, stdio: "pipe", timeout: 300000 });

const CAT = "Ask AI & automation";
const nav = (p) => p.getByRole("navigation", { name: "Main" }).first();
const main = (p) => p.locator("main");
const viewTab = (p, name) => main(p).getByRole("navigation", { name: "Automation views" }).getByRole("link", { name, exact: true });

/** Click a sidebar link, opening the folded "More" group first when needed. */
async function side(t, name) {
  const p = t.page;
  const link = nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
  if (!(await link.first().isVisible().catch(() => false))) {
    await t.moveAndClick(nav(p).getByRole("button", { name: /More/ }));
    await sleep(400);
  }
  await t.moveAndClick(link);
}
/** Point at something if it is on screen; otherwise scroll on (optional sections never fail a video). */
async function soft(t, loc) {
  try { await loc.first().waitFor({ state: "visible", timeout: 4000 }); await t.point(loc); } catch { await t.scroll(300); }
}
/** A card on the page by its heading text. */
const card = (p, title) => main(p).locator("section, div.rounded-2xl, div.rounded-xl").filter({ has: p.getByText(title, { exact: true }) }).first();
const acceptDialogs = (p) => p.on("dialog", (d) => d.accept().catch(() => {}));
/** Always record in the synthetic demo workspace (the owner may belong to other workspaces too). */
async function start(t) {
  await t.page.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
  await t.goto("/today");
}
const viewTabs = (p) => main(p).getByRole("navigation", { name: "Automation views" });
const statusBox = (p) => p.locator("[data-testid=automation-status]").first();
const stat = (p, label) => main(p).locator("[data-testid=automation-counts] > *").filter({ has: p.getByText(label, { exact: true }) }).first();

function prepare() {
  setup();
  // Not filmed: recordings may run during quiet hours (22:00–07:00), when informational notices are held until working hours.
  // Release the tutorial's own notices now so the Notifications videos have something to show.
  sql(`update mudar.notification_state set deliver_after = now() - interval '1 minute' where workspace_id='${WS}' and status='pending' and deliver_after > now()
       and (title like 'Brief ready: Zentrix%' or title like 'Requirement changed: Zentrix%')`);
}
/** Safety net: never leave the demo workspace's automation paused. */
function finish() { try { sql(`update mudar.automation_control set paused=false, resumed_at=now(), updated_at=now() where workspace_id='${WS}' and paused`); } catch { /* table may not exist */ } }

const FLOWS = [
  // ------------------------------------------------------------------ 1. overview
  {
    slug: "automation-overview-v2", category: CAT, title: "Automation: what runs by itself",
    learn: "More → Automation shows whether automation is active (with one-click pause), counts of workflows by status, system alerts, capacity warnings, what needs you, what is running, what can be started, schedules, every workflow and its trigger, recent results, connections and usage per resource.",
    tryRoute: "/automation",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Automation: what runs by itself", "Background jobs that keep your records, briefs and plans up to date — and where to check on them.");
      await t.step("Open More in the sidebar, then Automation.", () => side(t, "Automation"));
      await t.step("At the top: 'Automation active' — background checks, research, scoring and updates are running. Pause automation stops them all.", () => t.point(statusBox(p)));
      await t.step("Seven tabs: Overview, Daily plan, History, Background jobs, Weekly review, Budgets & usage and Notifications.", () => t.point(viewTabs(p)));
      await t.step("A warning appears when many background jobs are waiting — results that depend on them may be out of date.", () => soft(t, main(p).getByText(/background jobs waiting/)));
      await t.step("The counters: total workflows run, active now, scheduled, completed, failed, delayed, and items that need you.", () => t.point(main(p).locator("[data-testid=automation-counts]")));
      await t.step("Total, Completed, Failed and Delayed are links — each opens the History tab filtered to those runs.", () => t.point(stat(p, "Failed")));
      await t.step("System alerts: the most serious first — failed workflows, decisions waiting for you, stale outputs and changed information.", () => t.point(main(p).getByText("System alerts").first()));
      await t.step("Each alert has a label (Failed, Needs you, Stale, Changed…) and links to where you fix it.", () => soft(t, card(p, "System alerts").locator("li").first()));
      await t.step("Capacity warnings: today's clashes — overlapping meetings, too many meetings, overdue promises.", () => soft(t, main(p).getByText("Capacity warnings")));
      await t.step("Needs attention: failed, paused and waiting jobs, plus records that became out of date. Start here every day.", () => t.point(main(p).getByText("Needs attention", { exact: true }).last()));
      await t.step("Each row shows the job, its status chip (Failed, Paused…), how far it got and the error in plain words.", () => soft(t, main(p).locator("li").filter({ hasText: /did not answer in time/ })));
      await t.step("Running now lists jobs in progress. Empty means nothing is working in the background right now.", () => t.point(main(p).getByText("Running now").first()));
      await t.step("Start a job: run a workflow yourself — here, prepare tomorrow's meetings and list open commitments.", () => t.point(main(p).getByText("Start a job").first()));
      await t.step("Scheduled: the daily plan at 08:00 and the weekly review on Friday, with their next run.", () => soft(t, main(p).getByText("Scheduled", { exact: true })));
      await t.step("All workflows: each one, whether it is On or Paused, what starts it and how many steps it has.", () => t.point(main(p).getByText("All workflows").first()));
      await t.step("For example: 'Reassess after requirement change' runs by itself whenever a client's requirement changes.", () => t.point(main(p).getByRole("link", { name: /Reassess after requirement change/ }).first()));
      await t.step("Recently finished: the last jobs and how they ended (Done, Partly done, Failed, Cancelled).", () => t.point(main(p).getByText("Recently finished").first()));
      await t.step("Connections: when mail or calendar last worked. A broken connection is shown here — never hidden.", () => soft(t, main(p).getByText("Connections", { exact: true })));
      await t.step("Usage and limits, per resource: research, contact enrichment, transcription and AI — used, limit and remaining.", () => soft(t, main(p).locator("[data-testid=usage-categories]")));
      await t.step("Open a workflow to see exactly what it does.", async () => { await t.scroll(-4000); await t.moveAndClick(main(p).getByRole("link", { name: /Reassess after requirement change/ }).first()); });
      await t.step("What it does, what starts it, when it last ran and when it runs next.", () => t.point(main(p).getByText("What it does").first()));
      await t.step("Steps in order. 'After: …' means a step waits for an earlier one; steps without it run in parallel.", () => t.point(main(p).getByText("Steps", { exact: true }).first()));
      await t.step("Controls: Pause workflow stops new runs of this one workflow. Priority decides which job goes first (admins only).", () => soft(t, main(p).getByText("Controls", { exact: true })));
      await t.step("Recent runs, the records the last run touched and the change history are further down. Export log downloads a run's history.", async () => { await t.scroll(700); await soft(t, main(p).getByText("Recent runs")); });
      await t.outro("found what runs by itself, the counters, system alerts, what needs you and what each workflow does.", "pause and resume all automation.");
    },
  },
  // ------------------------------------------------------------------ 2. daily plan (Today planner)
  {
    slug: "daily-plan-v2", category: CAT, title: "Your daily plan on Today (and the weekly review)",
    learn: "Today is your daily planner: the day's schedule, priority tasks you can tick off, overdue commitments, meetings needing prep, recommended next actions, capacity, approvals, signals, lease alerts, deals and priority accounts. It is built at 08:00 (Automation → Daily plan → Build now makes it earlier). Weekly review comes on Friday.",
    tryRoute: "/today",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Your daily plan", "Today is your planner: what is on, what is late and what to do next.");
      await t.step("Open Today at the top of the sidebar.", () => t.moveAndClick(nav(p).getByRole("link", { name: /^Today/ })));
      await t.step("The date, and a one-line summary: meetings, follow-ups due, new signals, lease alerts and approvals.", () => t.point(main(p).locator("h1").first()));
      await t.step("‹ and › move to yesterday or tomorrow; 'Today' brings you back.", () => t.point(main(p).getByRole("navigation", { name: "Change day" })));
      await t.step("Getting started: a checklist for new workspaces. It disappears once everything is done.", () => soft(t, main(p).getByText("Getting started").first()));
      await t.step("Today's schedule: every meeting with its time, place and whether its brief is ready.", () => t.point(main(p).getByText(/^Today's schedule/).first()));
      await t.step("Priority tasks and follow-ups: due today or overdue. Tick the box to mark one done.", () => t.point(main(p).getByText(/^Priority tasks/).first()));
      await t.step("Mark the first task done.", async () => { const b = main(p).getByRole("button", { name: /^Mark ".*" done$/ }).first(); await t.moveAndClick(b); await sleep(1500); });
      await t.step("Overdue commitments: promises made to clients that are past their date.", () => soft(t, main(p).getByText(/^Overdue commitments/).first()));
      await t.step("Meetings needing prep: what is still missing before each meeting.", () => soft(t, main(p).getByText(/^Meetings needing prep/).first()));
      await t.step("Recommended next actions, numbered in order. Each says why — overdue promise, missing prep, a deal gone quiet.", () => soft(t, main(p).getByText(/^Recommended next actions/).first()));
      await t.step("Right-hand side: Capacity — minutes in meetings, free time and your working day.", () => soft(t, main(p).getByText("Capacity", { exact: true }).first()));
      await t.step("Pending approvals, new signals, lease alerts, deals needing attention and priority accounts follow.", async () => { await soft(t, main(p).getByText(/^Pending approvals/).first()); await t.scroll(500); });
      await t.step("Each section links to the full list — e.g. All signals, Leases, Deals.", () => soft(t, main(p).getByRole("link", { name: "All signals" })));
      await t.step("The plan is built by itself at 08:00. To see it in Automation, open More → Automation → Daily plan.", async () => { await t.scroll(-3000); await side(t, "Automation"); await t.moveAndClick(viewTab(p, "Daily plan")); });
      await t.step("Build now rebuilds today's plan from the latest data; Open planner goes back to Today.", async () => { await t.point(main(p).getByRole("button", { name: "Build now" })); });
      await t.step("Press Build now. The rebuild is queued and the plan appears here within a few minutes.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Build now" })); await sleep(4000); });
      await t.step("Capacity warnings flag clashes: overlapping meetings, too many meetings, overdue promises, an overbooked day.", () => soft(t, main(p).getByText(/Too many meetings|overlap/).first()));
      await t.step("Suggestions are only suggestions: you decide what to move. Nothing is rescheduled for you.", async () => { await t.scroll(600); await soft(t, main(p).getByText(/Suggestions \(you decide\)/)); });
      await t.step("Now the Weekly review tab.", async () => { await t.scroll(-3000); await t.moveAndClick(viewTab(p, "Weekly review")); });
      await t.step("Built every Friday at 18:00: new opportunities, priority account changes, signals and meetings of the week.", () => soft(t, main(p).getByText(/^Weekly review/).first()));
      await t.step("Further down: overdue commitments, changed requirements and active deals — a checklist for next week.", async () => { await t.scroll(700); await soft(t, main(p).getByText(/Overdue commitments/)); });
      await t.outro("read Today's planner, ticked off a task and rebuilt the plan.", "see the meeting brief that is prepared an hour before.");
    },
  },
  // ------------------------------------------------------------------ 3. meeting briefs
  {
    slug: "meeting-briefs-auto-v2", category: CAT, title: "Meeting briefs an hour before",
    learn: "About an hour before each client meeting CRE OS prepares the meeting brief by itself and notifies you, listing what is still missing. Rescheduling moves the job; cancelling stops it.",
    tryRoute: "/automation?view=notifications",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Meeting briefs an hour before", "You don't have to remember to prepare — the brief is ready and waiting.");
      await t.step("The bell at the top shows new notifications. Click it.", () => t.moveAndClick(p.locator("summary[aria-label^='Notifications']").first()));
      await t.step("'Brief ready' — the Zentrix meeting starts in about an hour, so its brief was prepared automatically.", () => t.point(p.getByText(/Brief ready: Zentrix/).first()));
      await t.step("The full list lives in More → Automation → Notifications.", async () => { await p.keyboard.press("Escape"); await t.goto("/automation"); await t.moveAndClick(viewTab(p, "Notifications")); });
      const note = main(p).locator("li").filter({ hasText: /Brief ready: Zentrix/ }).first();
      await t.step("It lists what is still missing for the meeting: decision-maker, verified contacts, budget, documents.", () => t.point(note));
      await t.step("Urgent notices come straight away; informational ones wait for your working hours and quiet hours.", () => soft(t, note.getByText(/Urgent|Info/i)));
      await t.step("Open the notification to go to the meeting.", () => t.moveAndClick(note.getByRole("link").first()));
      await t.step("The meeting page: the brief has been generated (version 1) with a readiness score.", () => soft(t, main(p).getByText(/Readiness|readiness/).first()));
      await t.step("Scroll through the brief: company, requirement, open questions to ask.", () => t.scroll(600));
      await t.step("Unknown facts stay unknown — the brief says what to find out, it never guesses.", () => t.scroll(600));
      await t.step("How it works: the job is due 60 minutes before the start. Move the meeting and the job moves with it.", async () => { await t.scroll(-3000); await t.point(main(p).locator("h1").first()); });
      await t.step("Cancel the meeting and the prep job and its reminders are cancelled too; the meeting record is kept.", () => t.point(main(p).locator("h1").first()));
      await t.step("Back in Notifications, press Done when you have read it.", async () => {
        await t.goto("/automation?view=notifications");
        await t.moveAndClick(main(p).locator("li").filter({ hasText: /Brief ready: Zentrix/ }).first().getByRole("button", { name: "Done" }));
      });
      await t.outro("found the auto-prepared meeting brief and its notification.", "fix a failed job.");
    },
  },
  // ------------------------------------------------------------------ 4. budgets & notifications
  {
    slug: "budgets-notifications-v2", category: CAT, title: "Budgets and notifications",
    learn: "Admins set daily or monthly limits for AI, research and other paid usage; at the limit non-critical jobs pause (nothing lost). Notifications can be marked done, snoozed or dismissed.",
    tryRoute: "/automation?view=budgets",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await start(t);
      await t.title("Budgets and notifications", "Keep paid usage under control and keep your notification list short.");
      await t.step("Open More → Automation, then Budgets & usage.", async () => { await side(t, "Automation"); await t.moveAndClick(viewTab(p, "Budgets & usage")); });
      await t.step("A budget is a daily or monthly limit. When it is reached, non-critical background work pauses — nothing is lost — and admins are alerted.", () => t.point(main(p).getByText("Budgets", { exact: true }).first()));
      await t.step("Choose the resource — here 'research' (company research look-ups).", () => t.moveAndClick(main(p).locator("select").nth(0)).then(() => main(p).locator("select").nth(0).selectOption({ label: "research" })));
      await t.step("Period: Monthly or Daily.", () => t.point(main(p).locator("select").nth(1)));
      await t.step("Unit: calls (other resources use USD, credits, seconds, pages or runs).", async () => { await t.point(main(p).locator("select").nth(2)); await main(p).locator("select").nth(2).selectOption({ label: "calls" }); });
      await t.step("Limit: 10 calls a month. Alert at 80% warns admins before the limit.", async () => {
        const inputs = main(p).locator("input[type=number]");
        await inputs.nth(0).fill(""); await t.type(inputs.nth(0), "10");
        if (await inputs.count() > 1) { await inputs.nth(1).fill(""); await t.type(inputs.nth(1), "80"); }
      });
      await t.step("Save budget.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Save budget" })); await sleep(1500); });
      await t.step("The budget line shows used / limit, the alert level and when it resets.", () => soft(t, main(p).getByText(/research/).first()));
      await t.step("A budget never switches to another provider to keep going — it just pauses.", () => soft(t, main(p).getByText(/never switches/)));
      await t.step("Usage this month: by resource, AI cost by module and by workflow.", async () => { await t.scroll(500); await soft(t, main(p).getByText(/Usage this month/)); });
      await t.step("Now the Notifications tab.", async () => { await t.scroll(-3000); await t.moveAndClick(viewTab(p, "Notifications")); });
      const first = main(p).locator("li").filter({ has: p.getByRole("button", { name: "Snooze 3h" }) }).first();
      await t.step("Each notification says what happened and links to the record. Here: a requirement change reassessed the Zentrix comparisons.", () => t.point(first));
      await t.step("Done: you dealt with it. Snooze 3h: bring it back later. Dismiss: remove it (it stays in the history).", () => t.point(first.getByRole("button", { name: "Snooze 3h" })));
      await t.step("Snooze this one for three hours.", async () => { await t.moveAndClick(first.getByRole("button", { name: "Snooze 3h" })); await sleep(1500); });
      await t.step("Similar notices are grouped, urgent ones come straight away, others wait for working hours and quiet hours.", () => soft(t, main(p).getByText(/Notifications \(/)));
      await t.step("The bell at the top of every page shows the same list.", () => t.moveAndClick(p.locator("summary[aria-label^='Notifications']").first()));
      await t.outro("set a research budget and snoozed a notification.", "ask AI to run a workflow for you.");
    },
  },
  // ------------------------------------------------------------------ 5. ask AI
  {
    slug: "ask-ai-workflow-v2", category: CAT, title: "Ask AI to run a workflow",
    learn: "Ask AI in plain words — e.g. \"prepare tomorrow's meetings and list pending client commitments\" — and it starts the matching workflow, then shows the result and a link to the run.",
    tryRoute: "/assistant",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Ask AI to run a workflow", "Say what you need; the assistant starts the right automation and reports back.");
      await t.step("Open Ask AI from the sidebar.", () => t.moveAndClick(nav(p).getByRole("link", { name: /^Ask AI/ })));
      await t.step("Start a new conversation.", () => soft(t, main(p).getByRole("button", { name: "New", exact: true })).then(async () => { const b = main(p).getByRole("button", { name: "New", exact: true }).first(); if (await b.isVisible().catch(() => false)) await b.click(); }));
      await t.step("Type the request in plain words: prepare tomorrow's meetings and list pending client commitments.", async () => {
        await t.type(main(p).getByPlaceholder(/Ask about your accounts/), "Prepare tomorrow's meetings and list pending client commitments", 28);
        await t.moveAndClick(main(p).getByRole("button", { name: "Ask", exact: true }));
        await main(p).getByText(/Approve change|commitment|Prepare meetings/i).last().waitFor({ timeout: 120000 });
        await sleep(2500);
      });
      const approval = main(p).locator("section[aria-label^='Approval needed']").last();
      if (await approval.isVisible().catch(() => false)) {
        await t.step("Starting a workflow is an action, so the assistant asks first: the card shows the workflow and the day.", () => t.point(approval));
        await t.step("Approve to start it. Nothing is sent to anyone — it only prepares briefs and lists tasks.", async () => { await t.moveAndClick(approval.getByRole("button", { name: "Approve change" })); await sleep(6000); });
      }
      await t.step("The answer: tomorrow's meetings, briefs prepared, and open or overdue commitments.", async () => { await t.scroll(-500); await soft(t, main(p).getByText(/commitment/i).last()); });
      await t.step("Press 'Open the run' to see each step.", async () => {
        const runId = sql(`select id from mudar.workflow_run where workspace_id='${WS}' and definition_key='assist.prepare_meetings' and dedupe_key not like 'tut-auto:%' order by created_at desc limit 1`);
        const btn = main(p).getByRole("button", { name: /Open the run/ }).or(main(p).getByRole("link", { name: /Open the run/ })).last();
        if (await btn.isVisible().catch(() => false)) { await t.moveAndClick(btn); await sleep(2500); }
        if (!/\/automation\/runs\//.test(p.url()) && runId) await t.goto(`/automation/runs/${runId}`);
      });
      await t.step("The run page: progress, each step with what it found, and the records involved.", () => soft(t, main(p).getByText("Steps", { exact: true })));
      await t.step("The same request works from the Ask AI panel on any page. You can also ask 'what failed?' or 'pause that job'.", () => t.scroll(500));
      await t.outro("asked AI to prepare tomorrow's meetings and list open commitments.", "fix a failed job.");
    },
  },
  // ------------------------------------------------------------------ 6. failed job
  {
    slug: "failed-job-v2", category: CAT, title: "Fix a failed job (retry, pause, cancel)",
    learn: "When a background job fails, Automation → Needs attention shows it. The run page says what failed, what was affected and what to do; Retry re-runs only the failed steps. Pause, Resume and Cancel control a run.",
    tryRoute: "/automation",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await start(t);
      await t.title("Fix a failed job", "Retry only what failed. Pause, resume or cancel a run.");
      await t.step("Open More → Automation. The Failed counter shows 1.", async () => { await side(t, "Automation"); await t.point(main(p).getByText("Failed", { exact: true }).first()); });
      await t.step("In Needs attention, open the failed job.", () => t.moveAndClick(main(p).locator("li").filter({ hasText: /did not answer in time/ }).getByRole("link", { name: /Prepare meetings/ }).first()));
      await t.step("The run page: Failed, when it started and finished.", () => t.point(main(p).locator("h1").first()));
      await t.step("Progress: 2 steps done, 1 failed.", () => t.point(main(p).getByText(/% ·/).first()));
      await t.step("What went wrong: the failed step and its error in plain words — a timeout, after 3 attempts.", () => t.point(main(p).getByText("What went wrong").first()));
      await t.step("Records affected: the meetings this job was working on.", () => soft(t, main(p).getByText("Records affected")));
      await t.step("Steps that worked keep their results — they will not run again.", () => soft(t, main(p).getByText("Steps that worked")));
      await t.step("Will it retry by itself? No — retries are used up. What to do: check the error, then use Retry.", () => soft(t, main(p).getByText("What to do")));
      await t.step("Press Retry failed steps.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: /Retry/ }).first()); await sleep(3000); });
      await t.step("Only the failed step ran again. The job is now Done.", async () => { await t.goto(p.url().replace(/^https?:\/\/[^/]+/, "")); await t.point(main(p).locator("h1").first()); });
      await t.step("History shows every action: started, step finished, manual retry — with who did it.", async () => { await t.scroll(800); await soft(t, main(p).getByText("History").first()); });
      await t.step("Export log downloads this history.", () => soft(t, main(p).getByRole("link", { name: /Export log/ }).or(main(p).getByRole("button", { name: /Export log/ }))));
      const pausedRow = main(p).locator("li").filter({ hasText: /Prepare meetings/ }).filter({ has: p.getByText("Paused", { exact: true }) }).first();
      await t.step("Back to Automation: the second job here is Paused.", async () => { await t.goto("/automation"); await t.point(pausedRow); });
      await t.step("Open it.", () => t.moveAndClick(pausedRow.getByRole("link").first()));
      await t.step("A paused run waits. Resume continues where it stopped. Running jobs show Pause instead.", () => t.point(main(p).getByRole("button", { name: "Resume" })));
      await t.step("Cancel stops it for good (admins). Finished steps and their results are kept.", () => t.moveAndClick(main(p).getByRole("button", { name: "Cancel" })));
      await t.step("The job is now Cancelled — nothing else will run for it.", async () => { await sleep(1500); await t.goto(p.url().replace(/^https?:\/\/[^/]+/, "")); await t.point(main(p).locator("h1").first()); });
      await t.outro("retried a failed job and cancelled a paused one.", "see outdated proposals after a requirement change.");
    },
  },
  // ------------------------------------------------------------------ 7. outdated proposals
  {
    slug: "outdated-proposals-v2", category: CAT, title: "Outdated proposals after a new quote or requirement change",
    learn: "When a quote arrives or a requirement changes, CRE OS recalculates comparisons as new versions and flags proposals built on the old figures. Review → Outdated proposals lists them: Review opens a recalculated result, Refresh re-runs one you entered yourself, Dismiss closes the note; approved ones are never overwritten.",
    tryRoute: "/approvals/outdated",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await start(t);
      await t.title("Outdated proposals", "A new quote or a changed requirement? See what is now out of date — and refresh it.");
      await t.step("Zentrix's requirement changed: maximum area went from 28,000 to 30,000 sq ft. Open Review.", () => t.moveAndClick(nav(p).getByRole("link", { name: /^Review/ })));
      await t.step("In the row of queues, open Stale records, then the Outdated proposals tab.", async () => {
        await t.moveAndClick(main(p).getByRole("link", { name: "Stale records", exact: true }));
        await t.moveAndClick(main(p).getByRole("link", { name: "Outdated proposals" }));
      });
      await t.step("Top: approved or shared proposals that used the old figures. They are never changed automatically — you decide.", () => t.point(main(p).getByText(/Approved or shared/).first()));
      await t.step("Below: drafts and analyses that need a refresh.", () => t.point(main(p).getByText("Needs a refresh").first()));
      const item = (txt) => main(p).locator("li").filter({ hasText: txt }).filter({ has: p.getByRole("button", { name: "Dismiss" }) }).last();
      const recalc = () => main(p).locator("li").filter({ hasText: /Recalculated \(v\d+\)/ }).filter({ has: p.getByRole("button", { name: "Dismiss" }) }).first();
      await t.step("'Recalculated — review': the comparison already re-ran as a new version; the old versions are kept.", () => t.point(main(p).getByText(/Recalculated \(v\d+\)/).first()));
      await t.step("'what changed' shows the old and new values.", () => soft(t, main(p).getByText("what changed").first()));
      await t.step("Press Review to open the recalculated comparison and check the new result.", async () => { await t.moveAndClick(recalc().getByRole("link", { name: "Review", exact: true })); await sleep(2500); });
      await t.step("Back in Review: once you've checked it, Dismiss closes the note (it stays in the history).", async () => { await t.goto("/approvals/outdated"); await t.point(recalc().getByRole("button", { name: "Dismiss" })); });
      await t.step("Dismiss this one.", async () => { await t.moveAndClick(recalc().getByRole("button", { name: "Dismiss" })); await sleep(1500); });
      await t.step("Items you entered yourself show 'May be outdated' with a Refresh button instead.", () => soft(t, item(/may be outdated/i)));
      await t.step("The same warning appears on the record itself. Open the Zentrix requirement.", async () => {
        const id = sql(`select id from mudar.requirement where workspace_id='${WS}' and title like 'Zentrix Analytics — 25,000 sf%' and archived_at is null limit 1`);
        await t.goto(`/requirements/${id}`);
        await soft(t, main(p).getByText(/out of date|outdated|needs a refresh|may be/i));
      });
      await t.step("New rent quotations work the same way: comparisons recalculate, proposals using the old quote are flagged.", () => t.point(main(p).locator("h1").first()));
      await t.step("Each reassessment is a job in Automation → Recently finished, with its steps and the records it flagged.", async () => { await t.goto("/automation"); await soft(t, main(p).getByText("Recently finished")); });
      await t.outro("reviewed and dismissed outdated proposals after a requirement change.", "set budgets and manage notifications.");
    },
  },
  // ------------------------------------------------------------------ 8. pause / resume
  {
    slug: "automation-pause-resume", category: CAT, title: "Pause and resume all automation",
    learn: "Automation → Pause automation stops background checks, research, scoring and scheduled runs for the whole workspace (your own actions, captures and meeting reminders still run). Nothing is lost: Resume automation releases the waiting jobs.",
    tryRoute: "/automation",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await start(t);
      await t.title("Pause and resume all automation", "One switch for all background work — for example during a data clean-up or a holiday.");
      await t.step("Open More → Automation.", () => side(t, "Automation"));
      await t.step("The status bar says 'Automation active': checks, research, scoring and updates run in the background.", () => t.point(statusBox(p)));
      await t.step("It is shown on every Automation tab, so you always know the state.", () => t.point(statusBox(p).getByText("Automation active")));
      await t.step("Press Pause automation. You are asked to confirm — nothing is lost, it continues when you resume.", async () => { await t.moveAndClick(statusBox(p).getByRole("button", { name: "Pause automation" })); await sleep(2500); });
      await t.step("The badge now reads 'Automation paused', with the time it was paused.", () => t.point(statusBox(p).getByText("Automation paused")));
      await t.step("While paused, background checks, research, scoring and scheduled runs wait. Your own actions, captures and meeting reminders still run.", () => t.point(statusBox(p)));
      await t.step("System alerts also show that automation is paused, so nobody wonders why scores stopped updating.", () => soft(t, card(p, "System alerts").locator("li").filter({ hasText: /pause/i })));
      await t.step("Switch tabs — the paused bar stays at the top.", async () => { await t.moveAndClick(viewTab(p, "Background jobs")); await t.point(statusBox(p)); });
      await t.step("Jobs that would have run stay in the list as Waiting — they are not dropped.", () => soft(t, main(p).locator("[data-testid=background-jobs] > li").first()));
      await t.step("Press Resume automation.", async () => { await t.moveAndClick(statusBox(p).getByRole("button", { name: "Resume automation" })); await sleep(2500); });
      await t.step("Back to 'Automation active'. Held jobs are released and continue where they stopped.", () => t.point(statusBox(p).getByText("Automation active")));
      await t.step("To stop just one workflow instead, open it from All workflows and use Pause workflow.", async () => { await t.moveAndClick(viewTab(p, "Overview")); await t.scroll(1800); await soft(t, main(p).getByText("All workflows")); });
      await t.outro("paused and resumed all background automation.", "read the workflow history.");
    },
  },
  // ------------------------------------------------------------------ 9. workflow history
  {
    slug: "workflow-history", category: CAT, title: "Workflow history",
    learn: "Automation → History lists every workflow run: what started it, when it started and finished, retries, the steps that ran and the ones that failed with the error. Filter by Failed, Delayed, Completed or Paused; open a run for its full log.",
    tryRoute: "/automation?view=history",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Workflow history", "Every automation run: what triggered it, what it did and what failed.");
      await t.step("Open More → Automation.", () => side(t, "Automation"));
      await t.step("The counter 'Total workflows' links straight to the history.", () => t.point(stat(p, "Total workflows")));
      await t.step("Open the History tab.", () => t.moveAndClick(viewTab(p, "History")));
      const rows = main(p).locator("[data-testid=workflow-history] > li");
      await t.step("Workflow history, newest first. Each run has a name and a status chip.", () => t.point(rows.first()));
      await t.step("The second line: what started it (a person, an event, a schedule), start and finish time, and how many retries.", () => t.point(rows.first().locator("p").first()));
      await t.step("A completed run lists the steps it did — here, a requirement change re-ran comparisons, scores and notifications.", () => soft(t, rows.filter({ hasText: /Reassess after requirement change/ })));
      await t.step("A failed run says which step failed, in red, with the reason.", () => soft(t, rows.filter({ hasText: /Failed: / }).first()));
      await t.step("Filters: All, Failed, Delayed, Completed and Paused. Choose Failed.", () => t.moveAndClick(main(p).getByRole("link", { name: "Failed", exact: true })));
      await t.step("Only failed runs now. Open one to see every step and fix it.", () => t.point(rows.first()));
      await t.step("Open the run.", () => t.moveAndClick(rows.first().getByRole("link").first()));
      await t.step("The run page: what went wrong, which records were affected and Retry failed steps.", () => soft(t, main(p).getByText("What went wrong")));
      await t.step("Back in History, choose Paused to see runs waiting for you to resume or cancel them.", async () => { await t.goto("/automation?view=history"); await t.moveAndClick(main(p).getByRole("link", { name: "Paused", exact: true })); });
      await t.step("Completed shows everything that finished well. Delayed shows runs that are late.", () => t.point(main(p).getByRole("link", { name: "Completed", exact: true })));
      await t.outro("filtered the workflow history and opened a failed run.", "check background jobs.");
    },
  },
  // ------------------------------------------------------------------ 10. background jobs
  {
    slug: "background-jobs", category: CAT, title: "Background jobs: which module, status, retries",
    learn: "Automation → Background jobs (admins) lists each queued, running, completed or failed job: which module it belongs to, when it was due, when it finished, retries and the error. Below, 'Work handed to specialist modules' tracks events passed to other modules until they finish.",
    tryRoute: "/automation?view=jobs",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Background jobs", "The small jobs behind the scenes: scoring, research, briefs, matching. Which module, what state, how many retries.");
      await t.step("Open More → Automation, then the Background jobs tab.", async () => { await side(t, "Automation"); await t.moveAndClick(viewTab(p, "Background jobs")); });
      const jobs = main(p).locator("[data-testid=background-jobs] > li");
      await t.step("Every background job, with its state: Waiting, Running, Completed, Failed — will retry, or Failed.", () => t.point(jobs.first()));
      await t.step("'Delayed' means it is past its due time — usually the scheduler is busy or not running.", () => soft(t, jobs.first().getByText("Delayed")));
      await t.step("Module: which part of CRE OS the job belongs to — Scoring, Research, Daily brief, Deal Toolkit…", () => t.point(jobs.first().getByText(/^Module:/)));
      await t.step("When it was due, when it finished (and how long it took), and retries used out of the attempts allowed.", () => t.point(jobs.first().getByText(/Retries:/)));
      await t.step("Failed jobs show the reason in red.", () => soft(t, main(p).getByText(/^Reason:/).first()));
      await t.step("Filters: All, Waiting, Delayed, Failed, Completed. Choose Completed.", () => t.moveAndClick(main(p).getByRole("link", { name: "Completed", exact: true })));
      await t.step("Completed jobs with their finish time.", () => soft(t, jobs.first()));
      await t.step("Choose Failed to see what needs a look.", () => t.moveAndClick(main(p).getByRole("link", { name: "Failed", exact: true })));
      await t.step("Failed jobs: the module and the error. Jobs that can retry say 'will retry'.", () => soft(t, jobs.first()));
      await t.step("Work handed to specialist modules: events passed on (a signal, a meeting outcome, an employer change) and whether that module finished.", async () => { await t.scroll(1500); await soft(t, main(p).getByText("Work handed to specialist modules")); });
      await t.step("Only admins see job details; other users see a short note instead.", () => t.point(viewTabs(p)));
      await t.outro("read background jobs by module, status and retries.", "set budgets and notifications.");
    },
  },
];

module.exports = { FLOWS, prepare, finish };
