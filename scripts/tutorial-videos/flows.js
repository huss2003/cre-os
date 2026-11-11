// The tutorial videos: one task each, real clicks on real screens. Captions must describe only what is on screen.
const path = require("path");
const { execFileSync } = require("child_process");
const { BASE, sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
/** Run the Zentrix lease automation (prepare = reset + start, resume = what the scheduled sweep does). */
const leaseChain = (mode) => execFileSync("npx", ["tsx", "--require", "./scripts/assistant-evals.preload.cjs", "--env-file=.env.local",
  "scripts/tutorial-videos/workflow-demo.ts", mode], { cwd: ROOT, stdio: "pipe", timeout: 120000 });

const ZENTRIX = "Zentrix Analytics";
const nav = (p) => p.getByRole("navigation", { name: "Main" });
const navLink = (p, name) => nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
const main = (p) => p.locator("main");

/** One-off setup before recording (not filmed): make sure scores exist so Today / Scores / Ask AI have something to show. */
async function prepare(browser, statePath) {
  leaseChain("cleanup");
  const ctx = await browser.newContext({ storageState: statePath, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/scoring`, { waitUntil: "networkidle", timeout: 90000 });
  const scored = await p.getByText("Companies scored").locator("..").innerText().catch(() => "");
  if (/\b0\b/.test(scored)) {
    await p.getByRole("button", { name: /Score everything now/ }).click();
    await p.waitForLoadState("networkidle").catch(() => {});
    await sleep(8000);
  }
  await ctx.close();
}

const FLOWS = [
  {
    slug: "tour", featured: true, title: "How CRE OS fits together (1-minute tour)",
    learn: "Where things live: Today, Review, your records, Ask AI and the More menu.", tryRoute: "/today",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("How CRE OS fits together", "A one-minute tour of the main screens and what each one is for.",
        ["Today — what needs you", "Review — changes wait for your OK", "Records — companies, people, buildings", "Ask AI — questions in plain words"]);
      await t.step("Today is your start page: the most useful things to do today.", () => t.point(main(p).getByRole("heading", { name: "Today" })));
      await t.step("Recommended next actions: lease dates and overdue tasks, most urgent first.", () => t.point(main(p).getByText("Recommended next actions")));
      await t.step("Further down: meetings, new signals and follow-ups that are due.", async () => { await t.scroll(700); });
      await t.step("Review holds every change waiting for your OK — nothing changes your records without it.", () => t.moveAndClick(navLink(p, "Review")));
      await t.step("Companies is the list of every account you track.", () => t.moveAndClick(navLink(p, "Companies")));
      await t.step("Search for one — here, Zentrix Analytics.", async () => {
        const box = main(p).getByRole("searchbox").or(main(p).getByPlaceholder(/search|name/i)).first();
        await t.type(box, "Zentrix"); await p.keyboard.press("Enter");
      });
      await t.step("Open the company page.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX })));
      await t.step("Each tab is one part of the story: people, signals, scores, next actions…", () => t.point(main(p).getByRole("link", { name: /^People/ })));
      await t.step("People shows who works there and how well you know them.", () => t.moveAndClick(main(p).getByRole("link", { name: /^People/ })));
      await t.step("Ask AI answers questions about your data and shows its sources.", () => t.moveAndClick(navLink(p, "Ask AI")));
      await t.step("More holds the less-used screens: scores, lease radar, automations, tutorials.", () => t.moveAndClick(nav(p).getByRole("button", { name: /More/ })));
      await t.outro("a tour of Today, Review, Companies, a company page and Ask AI.", "capture a meeting note and approve it.");
    },
  },

  {
    slug: "capture", title: "Capture a meeting note and approve it",
    learn: "Type what happened; CRE OS asks about anything unclear, then adds it to your records when you press Reviewed.", tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Capture a meeting note → approve it", "Write down what happened after a call or meeting. CRE OS turns it into records — only after you check it.");
      await t.step("Open Capture after any call, meeting or site visit.", () => t.moveAndClick(navLink(p, "Capture")));
      await t.step("Choose Type to write or paste a note.", () => t.moveAndClick(main(p).getByRole("radio", { name: /Type/ })));
      await t.step("Write what happened, in plain words.", () => t.type(main(p).getByPlaceholder("English, Hindi or Hinglish is fine"),
        "Met Ananya Rao at Zentrix Analytics. They need about 25,000 sq ft in Kharadi by March. Send 3 options on Friday.", 28));
      await t.step("Save it. Nothing in your records changes yet.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save capture" })));
      await p.waitForURL(/\/capture\/[0-9a-f-]+/, { timeout: 30000 });
      await t.step("When something is unclear, CRE OS asks. Which March? Pick 2027.", () => t.moveAndClick(main(p).getByText("March 2027", { exact: true })));
      await t.step("Which Friday? Pick the nearest one, then save the answers.", async () => {
        const fri = main(p).locator("input[name='answer:1']").first();
        await t.moveAndClick(fri.locator("xpath=..")); await t.moveAndClick(main(p).getByRole("button", { name: "Save answers" }));
      });
      await t.step("Check what will be added: a meeting log, requirement details and a task.", () => t.point(main(p).getByText("What will be added when you press Reviewed")));
      await t.step("Looks right? Press Reviewed — now it is added to your records.", () => t.moveAndClick(main(p).getByRole("button", { name: /Reviewed/ })));
      await t.step("Each change is listed with where it came from, and can be undone.", async () => { await t.point(main(p).getByText(/Facts for approval/i)); await t.scroll(300); });
      await t.step("Open the company to see the updated requirement.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX })));
      await t.step("The Requirements tab now shows the 25,000 sq ft need in Kharadi.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Requirements/ })));
      await t.outro("captured a meeting note, answered two questions and approved it.", "find accounts with a lease event.");
    },
  },
  {
    slug: "find-accounts", title: "Find accounts with a lease event",
    learn: "Describe the companies you want in plain words and see the lease, contact and signal behind each match.", tryRoute: "/search?mode=accounts",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Find accounts with a lease event", "Describe the companies you are looking for in plain words.");
      await t.step("Open Search from the sidebar.", () => t.moveAndClick(p.getByRole("link", { name: /^Search/ }).or(p.getByPlaceholder(/^Search/))));
      await t.step("Switch to Find accounts.", async () => { if (!/\/search/.test(p.url())) await t.goto("/search"); await t.moveAndClick(main(p).getByRole("link", { name: "Find accounts" })); });
      await t.step("Describe what you want, in plain English.", () => t.type(main(p).getByPlaceholder(/companies occupying/), "companies in Kharadi with a lease event next year"));
      await t.step("Press Find.", () => t.moveAndClick(main(p).getByRole("button", { name: "Find", exact: true })));
      await t.step("Your words became filters you can remove: Kharadi, lease event next year.", () => t.point(main(p).getByText(/^Understood:/)));
      await t.step("Coverage: how many companies matched out of all you can see.", () => t.point(main(p).getByText(/match(es)? of \d+ companies/)));
      await t.step("Each match shows why: the lease, its dates, the contact you know and any signal.", () => t.point(main(p).getByText(/^Lease events:/)));
      await t.step("Open the company to act on it.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX })));
      await t.outro("found companies in Kharadi with a lease event next year.", "understand one company page.");
    },
  },
  {
    slug: "company", title: "Understand one company",
    learn: "Read a company page: overview, people and relationship level, signals, scores (and why), next actions.", tryRoute: "/companies",
    async run(t) {
      const p = t.page;
      await t.goto("/companies");
      await t.title("Understand one company", "Everything about one account on one page, split into tabs.");
      await t.step("Open the company from Companies.", async () => {
        await t.type(main(p).getByRole("searchbox").or(main(p).getByPlaceholder(/search|name/i)).first(), "Zentrix"); await p.keyboard.press("Enter");
        await t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX }));
      });
      await t.step("Overview: the basic facts. Unknown stays 'unknown' — nothing is guessed.", () => t.point(main(p).getByText("Identity")));
      await t.step("People: who works there, grouped by role, with how well you know them.", () => t.moveAndClick(main(p).getByRole("link", { name: /^People/ })));
      await t.step("Each person shows their influence and relationship level — fill these in as you learn.", () => t.point(main(p).getByText("Ananya Rao")));
      await t.step("Signals: news that may mean they need space — marked unconfirmed until checked.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Signals/ })));
      await t.step("Scores: how worth targeting the company is, and why.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Scores/ })));
      await t.step("Every score lists its reasons and what is still missing.", () => t.point(main(p).getByText(/^Why:/)));
      await t.step("Next actions: what to do next, with dates from the lease.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Next actions/ })));
      await t.outro("read Overview, People, Signals, Scores and Next actions for one company.", "write outreach and send it yourself.");
    },
  },
  {
    slug: "outreach", title: "Write outreach and send it yourself",
    learn: "Pick a person and a situation, get a draft, approve it, then send it from your own mail app.", tryRoute: "/outreach/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Write outreach and send it yourself", "CRE OS writes the draft. You check it and send it — it never sends anything on its own.");
      await t.step("Open Outreach: who to contact today, and why.", () => t.moveAndClick(navLink(p, "Outreach")));
      await t.step("Press New outreach.", () => t.moveAndClick(main(p).getByRole("link", { name: "New outreach" })));
      await t.step("Choose the person — Ananya Rao at Zentrix Analytics.", async () => {
        const sel = main(p).locator("select").first(); await t.point(sel);
        await sel.selectOption({ label: "Ananya Rao — Head of Real Estate at Zentrix Analytics" });
        await t.moveAndClick(main(p).getByRole("button", { name: "Continue" }));
      });
      await t.step("'What we know' lists the facts the draft may use.", () => t.point(main(p).getByText("What we know")));
      await t.step("Pick the situation — here, Expansion.", async () => { const sel = main(p).locator("select").first(); await t.point(sel); await sel.selectOption({ label: "Expansion" }); });
      await t.step("Press Prepare drafts.", () => t.moveAndClick(main(p).getByRole("button", { name: "Prepare drafts" })));
      await p.waitForURL(/\/outreach\/[0-9a-f-]{36}/, { timeout: 30000 });
      await t.step("The draft appears. Edit it freely — 'Why now' shows the reason behind it.", () => t.point(main(p).getByText(/Why now/)));
      await t.step("Happy with it? Approve this exact text.", () => t.moveAndClick(main(p).getByRole("button", { name: /Approve this exact text/ })));
      await t.step("Send it yourself: confirm the recipient and the text.", async () => {
        await t.moveAndClick(main(p).getByText(/^Recipient is correct/)); await t.moveAndClick(main(p).getByText("The text is exactly what I want to send"));
      });
      await t.step("'Check & open' opens your own mail app with this text. You press Send there — CRE OS never sends.", () => t.point(main(p).getByRole("button", { name: /Check & open/ })));
      await t.step("After sending, press 'I sent it' so follow-ups are tracked.", () => t.point(main(p).getByRole("button", { name: "I sent it" })));
      await t.outro("prepared, approved and got ready to send an outreach email.", "prepare for a meeting.");
    },
  },
  {
    slug: "meeting", title: "Prepare for a meeting",
    learn: "Create a meeting with a company and get a preparation brief: purpose, people, history and questions.", tryRoute: "/meetings/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Prepare for a meeting", "Add the meeting; CRE OS builds a brief from your records.");
      await t.step("Open Meetings.", () => t.moveAndClick(navLink(p, "Meetings")));
      await t.step("Press New meeting.", () => t.moveAndClick(main(p).getByRole("link", { name: "New meeting" })));
      await t.step("Give it a title.", () => t.type(p.locator("input[name=title]"), "Zentrix Analytics — requirement discussion"));
      await t.step("Pick the type, the company and who is attending.", async () => {
        for (const [sel, label] of [["select[name=type]", "Requirement discussion"], ["select[name=org_id]", ZENTRIX], ["select[name=person_id]", "Ananya Rao — Zentrix Analytics"]]) {
          await t.point(p.locator(sel)); await p.locator(sel).selectOption({ label }); await sleep(500);
        }
      });
      await t.step("'Prepare the brief now' is ticked. Create the meeting.", () => t.moveAndClick(p.getByRole("button", { name: "Create meeting" })));
      await p.waitForURL(/\/meetings\/[0-9a-f-]{36}/, { timeout: 60000 });
      await t.step("The brief is ready. Readiness shows what is still missing.", () => t.point(p.getByText("Readiness")));
      await t.step("Meeting purpose: why you're meeting and what triggered it.", () => t.point(p.getByRole("heading", { name: /Meeting purpose/ })));
      await t.step("Use Contents to jump between sections — company, attendees, questions to ask…", () => t.point(p.getByText("Contents", { exact: true })));
      await t.step("For example, the company section.", async () => { await t.moveAndClick(p.locator("a[href=\"#company\"]")); });
      await t.outro("created a meeting and opened its preparation brief.", "compare buildings and download a deck.");
    },
  },
  {
    slug: "compare", title: "Compare buildings and download a deck",
    learn: "Score shortlisted buildings against a client's requirement, read the ranking, download a deck.", tryRoute: "/toolkit/compare/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Compare buildings and download a deck", "Rank buildings against what the client needs — with the reasons shown.");
      await t.step("Open Deal toolkit.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Compare buildings.", () => t.moveAndClick(main(p).getByRole("link", { name: /Compare buildings/ })));
      if (!/compare\/new/.test(p.url())) await t.step("Start a new comparison.", () => t.moveAndClick(main(p).getByRole("link", { name: /New comparison|New/ })));
      await t.step("Name it.", () => t.type(main(p).getByPlaceholder("e.g. Kharadi 25k sf options"), "Zentrix — Kharadi options"));
      await t.step("Pick the client requirement. Its size and location become the must-have rules.", async () => {
        const sel = main(p).locator("select").first(); await t.point(sel); await sel.selectOption({ label: "Zentrix Analytics — 25,000 sf in Kharadi" });
      });
      await t.step("Tick the buildings to compare: two in Kharadi, one in Hinjewadi.", async () => {
        for (const n of ["Kharadi Tech Park (demo)", "Kharadi Riverside Towers (demo)", "Hinjewadi Phase 2 Business Centre (demo)"]) await t.moveAndClick(main(p).getByLabel(n));
      });
      await t.step("Press Compare buildings.", () => t.moveAndClick(main(p).getByRole("button", { name: /Compare buildings/ })));
      await p.waitForURL(/\/toolkit\/compare\/[0-9a-f-]{36}/, { timeout: 60000 });
      await t.step("The recommendation, with the reasons in plain words.", () => t.point(main(p).getByText("RECOMMENDATION", { exact: false })));
      await t.step("Hinjewadi is 'not eligible': it fails the must-have rule 'in Kharadi'.", () => t.point(main(p).getByText(/is not eligible: fails/)));
      await t.step("Missing inputs are listed, never treated as zero.", async () => { await t.point(main(p).getByText(/inputs missing/)); });
      await t.step("Download deck makes a PowerPoint you can edit and send.", async () => { await t.scroll(-2000); await t.moveAndClick(main(p).getByText(/Download deck/)); });
      await t.outro("compared three buildings against a requirement and downloaded the deck.", "ask the AI a question.");
    },
  },
  {
    slug: "ask-ai", title: "Ask AI anything",
    learn: "Ask a question in plain words; see the steps it took, the answer, its coverage and open records from it.", tryRoute: "/assistant",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Ask AI anything", "Ask about your accounts in plain words. Every answer shows how it was found.");
      await t.step("Open Ask AI.", () => t.moveAndClick(navLink(p, "Ask AI")));
      await t.step("Type your question.", () => t.type(main(p).getByPlaceholder(/Ask about your accounts/), "Which five accounts should I focus on this week?"));
      await t.step("Press Ask.", () => t.moveAndClick(main(p).getByRole("button", { name: "Ask", exact: true })));
      const trail = main(p).getByRole("button", { name: /Worked through/ }).first();
      await trail.or(main(p).getByText(/^Coverage:/).first()).first().waitFor({ timeout: 90000 });
      await sleep(800);
      if (await trail.isVisible()) await t.step("It shows the steps it took. Click to see them.", () => t.moveAndClick(trail));
      await t.step("Coverage says what it checked — and that it only knows what is in CRE OS.", () => t.point(main(p).getByText(/^Coverage:/)));
      await t.step("The answer: accounts ranked by score, each with its reasons and a next step.", () => t.point(main(p).getByText(/^Identifiable need/)));
      await t.step("Click a company to open it.", () => t.moveAndClick(main(p).getByRole("link", { name: "Quokka Grid Infotech" })));
      await t.outro("asked a question, checked the steps and coverage, and opened a company.", "see an automation turn a lease date into a requirement.");
    },
  },
  {
    slug: "automation", title: "Renewal or relocation (automatic)",
    learn: "Watch the lease automation propose a requirement, wait for your OK, then shortlist, compare and add a task.", tryRoute: "/workflows",
    async run(t) {
      const p = t.page;
      leaseChain("prepare");
      await t.goto("/workflows");
      await t.title("Renewal or relocation — automatically", "When a lease date comes close, an automation prepares the work. You approve the important part.");
      await t.step("Automations run by themselves every few minutes.", () => t.point(main(p).getByRole("heading", { name: "Workflows" })));
      await t.step("This one watches leases: when a notice date or expiry comes close, it starts.", () => t.point(main(p).getByText("Lease → renewal / relocation")));
      await t.step("Zentrix's notice deadline is near, so it proposed a requirement — and is waiting for you.", async () => {
        await t.point(main(p).getByText("Waiting for approval"));
      });
      await t.step("Open the approval.", () => t.moveAndClick(main(p).getByRole("link", { name: "Approval" })));
      await t.step("A new requirement, prefilled from the lease. Unknowns are left blank.", async () => {
        await p.waitForURL(/approvals/); await sleep(1500); await t.point(main(p).getByText("Renewal or relocation — Zentrix Analytics"));
      });
      await t.step("Approve it.", () => t.moveAndClick(main(p).getByRole("button", { name: "Approve & apply" })));
      await t.step("On its next check, the automation carries on by itself.", async () => { leaseChain("resume"); });
      await t.step("Back in Automations: every step is listed with what it did.", async () => { await t.goto("/workflows"); await t.point(main(p).getByText(/Discuss renewal vs relocation|Task assigned/)); });
      await t.step("It matched alternatives, compared renewal vs moving, and added a task for you.", () => t.point(main(p).getByRole("link", { name: "Task" })));
      await t.step("Open the task.", () => t.moveAndClick(main(p).getByRole("link", { name: "Task" })));
      await t.outro("approved an automatic renewal-or-relocation requirement and opened the task it created.", "watch the 1-minute tour again, or try it yourself.");
    },
  },
];

/** After recording: leave no automation leftovers that would change the other videos next time. */
const finish = () => leaseChain("cleanup");

module.exports = { FLOWS, prepare, finish };
