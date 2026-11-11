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

function prepare() { setup(); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. overview
  {
    slug: "automation-overview", category: CAT, title: "Automation: what runs by itself",
    learn: "More → Automation shows every background job: what needs you, what is running, what can be started, every workflow and its trigger, recent results, connections and usage limits.",
    tryRoute: "/automation",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Automation: what runs by itself", "Background jobs that keep your records, briefs and plans up to date — and where to check on them.");
      await t.step("Open More in the sidebar, then Automation.", () => side(t, "Automation"));
      await t.step("Five tabs: Overview, Daily plan, Weekly review, Budgets & usage and Notifications.", () => t.point(main(p).getByRole("navigation", { name: "Automation views" })));
      await t.step("The counters: workflows switched on, jobs running now, failed jobs, jobs waiting for an approval and changes waiting in Review.", () => t.point(main(p).getByText("Workflows on").first()));
      await t.step("Capacity warnings: today's clashes — overlapping meetings, too many meetings, overdue promises.", () => soft(t, main(p).getByText("Capacity warnings")));
      await t.step("Needs attention: failed, paused and waiting jobs, plus records that became out of date. Start here every day.", () => t.point(main(p).getByText("Needs attention").first()));
      await t.step("Each row shows the job, its status chip (Failed, Paused…), how far it got and the error in plain words.", () => t.point(main(p).getByText("Failed", { exact: true }).first()));
      await t.step("Running now lists jobs in progress. Empty means nothing is working in the background right now.", () => t.point(main(p).getByText("Running now").first()));
      await t.step("Start a job: run a workflow yourself — here, prepare tomorrow's meetings and list open commitments.", () => t.point(main(p).getByText("Start a job").first()));
      await t.step("Scheduled shows recurring jobs and when they will run next.", () => soft(t, main(p).getByText("Scheduled", { exact: true })));
      await t.step("All workflows: each one, whether it is On or Paused, what starts it and how many steps it has.", async () => { await t.point(main(p).getByText("All workflows").first()); });
      await t.step("For example: 'Reassess after requirement change' runs by itself whenever a client's requirement changes.", () => t.point(main(p).getByRole("link", { name: /Reassess after requirement change/ }).first()));
      await t.step("Recently finished: the last jobs and how they ended (Done, Partly done, Failed, Cancelled).", () => t.point(main(p).getByText("Recently finished").first()));
      await t.step("Connections: when mail or calendar last worked. A broken connection is shown here — never hidden.", () => soft(t, main(p).getByText("Connections", { exact: true })));
      await t.step("Usage and limits: AI and research spending against any limits an admin has set.", () => soft(t, main(p).getByText("Usage and limits")));
      await t.step("Open a workflow to see exactly what it does.", () => t.moveAndClick(main(p).getByRole("link", { name: /Reassess after requirement change/ }).first()));
      await t.step("What it does, what starts it, when it last ran and when it runs next.", () => t.point(main(p).getByText("What it does").first()));
      await t.step("Steps in order. 'After: …' means a step waits for an earlier one; steps without it run in parallel.", () => t.point(main(p).getByText("Steps", { exact: true }).first()));
      await t.step("Controls: Pause workflow stops new runs until you switch it on again. Priority decides which job goes first (admins only).", () => soft(t, main(p).getByText("Controls", { exact: true })));
      await t.step("Recent runs, the records the last run touched and the change history are further down. Export log downloads a run's history.", async () => { await t.scroll(700); await soft(t, main(p).getByText("Recent runs")); });
      await t.step("The second tab in this area, Chains, holds the older record chains (signal → action, lease → renewal…).", async () => { await t.scroll(-2000); await soft(t, p.getByRole("link", { name: "Chains", exact: true })); });
      await t.outro("found what runs by itself, what needs you and what each workflow does.", "read your 08:00 daily plan.");
    },
  },
  // ------------------------------------------------------------------ 2. daily plan
  {
    slug: "daily-plan", category: CAT, title: "Your 08:00 daily plan (and the weekly review)",
    learn: "Every workday at 08:00 CRE OS builds your plan for the day from meetings, tasks and the brief: what to do first, capacity clashes and suggestions you decide on. Weekly review comes on Friday.",
    tryRoute: "/automation?view=daily",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Your 08:00 daily plan", "Built automatically each working morning. You can also build it now.");
      await t.step("Open More → Automation.", () => side(t, "Automation"));
      await t.step("Open the Daily plan tab.", () => t.moveAndClick(viewTab(p, "Daily plan")));
      await t.step("Your plan for today. It is built by itself at 08:00 your time (India time by default).", () => t.point(main(p).getByText(/^Plan for /).first()));
      await t.step("Want it earlier, or after a busy morning? Press Build now. It is rebuilt from the latest data.", async () => {
        await t.moveAndClick(main(p).getByRole("button", { name: "Build now" }));
        await sleep(4000);
      });
      await t.step("The plan is built from your meetings, tasks, calendar records and the daily brief — nothing is invented.", () => soft(t, main(p).getByText(/Recommended|What to do first|Do first/i)));
      await t.step("Scroll through the sections: meetings to prepare, commitments due, deals needing attention, signals.", () => t.scroll(450));
      await t.step("Capacity: minutes in meetings, free time and task work against your working hours.", () => soft(t, main(p).getByText(/min in meetings/)));
      await t.step("Warnings flag clashes: overlapping meetings, more meetings than your limit, overdue commitments.", () => soft(t, main(p).getByText(/too many meetings|overlap/).first()));
      await t.step("Travel time says 'unknown' — CRE OS has no routing service, so it never guesses.", () => soft(t, main(p).getByText(/Travel time unknown/).first()));
      await t.step("Suggestions are only suggestions: you decide what to move. Nothing is rescheduled for you.", async () => { await t.scroll(400); await soft(t, main(p).getByText(/Suggestions \(you decide\)/)); });
      await t.step("Now the Weekly review tab.", async () => { await t.scroll(-3000); await t.moveAndClick(viewTab(p, "Weekly review")); });
      await t.step("Built every Friday at 18:00: new opportunities, priority account changes, signals and meetings of the week.", () => t.point(main(p).getByText(/^Weekly review/).first()));
      await t.step("Further down: overdue commitments, changed requirements and active deals — a checklist for next week.", async () => { await t.scroll(700); await soft(t, main(p).getByText(/Overdue commitments/)); });
      await t.outro("built today's plan, read its capacity warnings and opened the weekly review.", "see the meeting brief that is prepared an hour before.");
    },
  },
  // ------------------------------------------------------------------ 3. meeting briefs
  {
    slug: "meeting-briefs-auto", category: CAT, title: "Meeting briefs an hour before",
    learn: "About an hour before each client meeting CRE OS prepares the meeting brief by itself and notifies you, listing what is still missing. Rescheduling moves the job; cancelling stops it.",
    tryRoute: "/automation?view=notifications",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Meeting briefs an hour before", "You don't have to remember to prepare — the brief is ready and waiting.");
      await t.step("The bell at the top shows new notifications. Click it.", () => t.moveAndClick(p.locator("summary[aria-label^='Notifications']").first()));
      await t.step("'Brief ready' — the Zentrix meeting starts in about an hour, so its brief was prepared automatically.", () => t.point(p.getByText(/Brief ready: Zentrix/).first()));
      await t.step("The full list lives in More → Automation → Notifications.", async () => { await p.keyboard.press("Escape"); await t.goto("/automation"); await t.moveAndClick(viewTab(p, "Notifications")); });
      const note = main(p).locator("li").filter({ hasText: /Brief ready: Zentrix/ }).first();
      await t.step("It lists what is still missing for the meeting: decision-maker, verified contacts, budget, documents.", () => t.point(note));
      await t.step("'Urgent' because the meeting is close. Informational notices wait for your working hours.", () => soft(t, note.getByText("Urgent")));
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
    slug: "budgets-notifications", category: CAT, title: "Budgets and notifications",
    learn: "Admins set daily or monthly limits for AI, research and other paid usage; at the limit non-critical jobs pause (nothing lost). Notifications can be marked done, snoozed or dismissed.",
    tryRoute: "/automation?view=budgets",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await t.goto("/today");
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
    slug: "ask-ai-workflow", category: CAT, title: "Ask AI to run a workflow",
    learn: "Ask AI in plain words — e.g. \"prepare tomorrow's meetings and list pending client commitments\" — and it starts the matching workflow, then shows the result and a link to the run.",
    tryRoute: "/assistant",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
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
    slug: "failed-job", category: CAT, title: "Fix a failed job (retry, pause, cancel)",
    learn: "When a background job fails, Automation → Needs attention shows it. The run page says what failed, what was affected and what to do; Retry re-runs only the failed steps. Pause, Resume and Cancel control a run.",
    tryRoute: "/automation",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await t.goto("/today");
      await t.title("Fix a failed job", "Retry only what failed. Pause, resume or cancel a run.");
      await t.step("Open More → Automation. The Failed counter shows 1.", async () => { await side(t, "Automation"); await t.point(main(p).getByText("Failed", { exact: true }).first()); });
      await t.step("In Needs attention, open the failed job.", () => t.moveAndClick(main(p).getByRole("link", { name: /Prepare meetings/ }).first()));
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
      await t.step("Back to Automation: the second job here is Paused.", async () => { await t.goto("/automation"); await t.point(main(p).getByText("Paused", { exact: true }).first()); });
      await t.step("Open it.", () => t.moveAndClick(main(p).locator("li").filter({ hasText: "Paused" }).getByRole("link").first()));
      await t.step("A paused run waits. Resume continues where it stopped. Running jobs show Pause instead.", () => t.point(main(p).getByRole("button", { name: "Resume" })));
      await t.step("Cancel stops it for good (admins). Finished steps and their results are kept.", () => t.moveAndClick(main(p).getByRole("button", { name: "Cancel" })));
      await t.step("The job is now Cancelled — nothing else will run for it.", async () => { await sleep(1500); await t.goto(p.url().replace(/^https?:\/\/[^/]+/, "")); await t.point(main(p).locator("h1").first()); });
      await t.outro("retried a failed job and cancelled a paused one.", "see outdated proposals after a requirement change.");
    },
  },
  // ------------------------------------------------------------------ 7. outdated proposals
  {
    slug: "outdated-proposals", category: CAT, title: "Outdated proposals after a new quote or requirement change",
    learn: "When a quote arrives or a requirement changes, CRE OS recalculates comparisons as new versions and flags proposals built on the old figures. Review → Outdated proposals lists them: Review opens a recalculated result, Refresh re-runs one you entered yourself, Dismiss closes the note; approved ones are never overwritten.",
    tryRoute: "/approvals/outdated",
    async run(t) {
      const p = t.page;
      acceptDialogs(p);
      await t.goto("/today");
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
];

module.exports = { FLOWS, prepare };
