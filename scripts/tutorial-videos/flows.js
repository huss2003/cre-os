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

const H = (p, re) => main(p).getByRole("heading", { name: re });
const L = (p, re) => main(p).getByRole("link", { name: re });
const B = (p, re) => main(p).getByRole("button", { name: re });
const TX = (p, re) => main(p).getByText(re);
/** A step that highlights (or clicks) something if it is on screen; if not, the caption still plays and the miss is logged. */
async function soft(t, caption, loc, opts = {}) {
  await t.step(caption, async () => {
    if (!loc) return;
    const l = loc.filter({ visible: true }).first();
    try { await l.waitFor({ state: "visible", timeout: opts.timeout || 4000 }); } catch { console.log(`    [miss] ${caption}`); return; }
    if (opts.click) await t.moveAndClick(l); else await t.point(l);
  });
}
const openMore = async (t) => {
  const p = t.page, btn = nav(p).getByRole("button", { name: /More/ });
  if ((await btn.getAttribute("aria-expanded").catch(() => "true")) !== "true") await t.moveAndClick(btn); else await t.point(btn);
};

const FLOWS = [
  {
    slug: "tour", featured: true, category: "Start here", title: "How CRE OS fits together (full tour)",
    learn: "Every sidebar area and the overall flow: information comes in → Review → records → you act.", tryRoute: "/today",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("How CRE OS fits together", "A tour of every area in the sidebar and how work flows between them.",
        ["1. Information comes in — Capture, signals, automations", "2. Review — you OK every change", "3. Records — companies, people, buildings, requirements, deals", "4. Act — Today, Outreach, Meetings, Toolkit, Ask AI"]);
      await soft(t, "The sidebar on the left is the map of the whole app, grouped into main, Records, Work and More.", nav(p));
      await soft(t, "Today is your start page: everything that needs you today, in one place.", navLink(p, "Today"), { click: true });
      await soft(t, "Recommended next actions: lease dates and overdue tasks, most urgent first.", H(p, /Recommended next actions/));
      await soft(t, "Meetings in the next three days, each with a link to its preparation brief.", H(p, /^Meetings — today/));
      await soft(t, "Priority accounts: the companies most worth your time, with 'See why' for the reasons.", H(p, /^Priority accounts/));
      await soft(t, "New signals, follow-ups that are due and approvals waiting for you.", H(p, /^New signals/));
      await soft(t, "Lease events: expiries, notice deadlines and lock-ins coming up in 12, 6 and 3 months.", H(p, /^Lease events/));
      await soft(t, "Day plan turns all of this into an ordered plan for today; Re-plan rebuilds it.", H(p, /^Day plan/));
      await soft(t, "Today also has tabs at the top: Overview, Tasks and Calendar.", p.getByRole("link", { name: "Tasks", exact: true }));
      await soft(t, "Ask AI answers questions about your own data and shows where each answer came from.", navLink(p, "Ask AI"), { click: true });
      await soft(t, "Ready-made questions get you started; or type your own in the box.", B(p, /Prepare me for my next meeting/));
      await soft(t, "Step 1 of the flow — information comes in. Capture is where you add notes, voice, photos and files.", navLink(p, "Capture"), { click: true });
      await soft(t, "Speak, Type or Photo: three ways to record what happened after a call or visit.", main(p).getByRole("radio", { name: /Type/ }).or(B(p, /^Type/)));
      await soft(t, "Recent captures lists what you saved and how many changes each one is proposing.", H(p, /^Recent captures/));
      await soft(t, "Step 2 — Review. Nothing changes your records until you approve it here.", navLink(p, "Review"), { click: true });
      await soft(t, "Changes from captures, imports and automations wait here, each with its evidence.", TX(p, /Why do we believe this\?|why do we believe this\?/i));
      await soft(t, "You can approve, edit, ask to clarify or reject each proposed change.", B(p, /Approve & apply/));
      await soft(t, "Step 3 — Records. Companies is every account you track.", navLink(p, "Companies"), { click: true });
      await soft(t, "Filter by name, or add a company by hand.", main(p).getByPlaceholder(/Filter company names/));
      await soft(t, "People: the contacts at those companies.", navLink(p, "People"), { click: true });
      await soft(t, "Buildings: campuses, towers and the space in them.", navLink(p, "Buildings"), { click: true });
      await soft(t, "Requirements: what each client is looking for — size, place, dates. Filter by status.", navLink(p, "Requirements"), { click: true });
      await soft(t, "Deals: every opportunity as a pipeline, from research to fee collected.", navLink(p, "Deals"), { click: true });
      await soft(t, "Each column is a stage; the Deals tabs also hold Financials, Documents and Fees.", main(p).getByRole("heading", { name: /research/i }));
      await soft(t, "Step 4 — Act. Outreach: who to contact today and drafts of what to say.", navLink(p, "Outreach"), { click: true });
      await soft(t, "Drafts only — you always send from your own mail or WhatsApp. CRE OS never sends.", L(p, /^New outreach/));
      await soft(t, "Meetings: prepare a brief before each meeting and log what happened after.", navLink(p, "Meetings"), { click: true });
      await soft(t, "Deal toolkit: compare buildings, cost a lease, stay-or-move and make client packs.", navLink(p, "Deal toolkit"), { click: true });
      await soft(t, "Signals: news and events that may mean a company needs space — checked before you trust them.", navLink(p, "Signals"), { click: true });
      await t.step("More holds the less-used screens. Open it.", () => openMore(t));
      await soft(t, "Scores rank who to focus on first; Find contacts finds and verifies decision-makers.", navLink(p, "Scores"));
      await soft(t, "Research looks into one company; Lease radar lists leases coming up for renewal.", navLink(p, "Lease radar"));
      await soft(t, "Market & reports: market data, network, legal, content and reports.", navLink(p, "Market & reports"));
      await soft(t, "Automations: chains that run on their own, like turning a lease date into a requirement.", navLink(p, "Automations"));
      await soft(t, "Imports bring in spreadsheets; Database and Places are for browsing and setup.", navLink(p, "Imports"));
      await soft(t, "Tutorials: these videos, any time.", navLink(p, "Tutorials"));
      await soft(t, "The whole loop: things come in → you Review → records update → Today tells you what to act on.", navLink(p, "Today"), { click: true });
      await t.outro("a tour of every sidebar area and the in → review → records → act loop.", "capture a meeting note and approve it.");
    },
  },

  {
    slug: "capture", category: "Records & data", title: "Capture a meeting note and approve it",
    learn: "Every part of Capture (speak, type, photo, files, links), the questions it asks, Reviewed, and where the result appears.", tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Capture a meeting note → approve it", "Write down what happened after a call or meeting. CRE OS turns it into records — only after you check it.");
      await t.step("Open Capture after any call, meeting or site visit.", () => t.moveAndClick(navLink(p, "Capture")));
      await soft(t, "New capture: three ways in. Speak — words appear as you talk.", main(p).getByRole("radio", { name: /Speak/ }).or(B(p, /^Speak/)));
      await soft(t, "Photo — snap a visiting card or a whiteboard; the text is read from it.", main(p).getByRole("radio", { name: /Photo/ }).or(B(p, /^Photo/)));
      await soft(t, "Language: English, Hindi / Hinglish or Marathi — pick what you'll speak or write.", main(p).getByLabel("Language").or(main(p).locator("select[name=language_hint]")));
      await soft(t, "More options lets you set when it actually happened, if it wasn't just now.", TX(p, /More options/));
      await soft(t, "Add files: upload documents such as a lease, LOI or floor plan.", B(p, /Choose files/));
      await soft(t, "Link to a record ties the file to a company, person, building or requirement.", TX(p, /Link to a record/));
      await soft(t, "Recent captures lists earlier notes, with their status and how many changes they propose.", H(p, /^Recent captures/));
      await t.step("Now choose Type to write or paste a note.", () => t.moveAndClick(main(p).getByRole("radio", { name: /Type/ }).or(B(p, /^Type/))));
      await t.step("Write what happened, in plain words.", () => t.type(main(p).getByPlaceholder("English, Hindi or Hinglish is fine"),
        "Met Ananya Rao at Zentrix Analytics. They need about 25,000 sq ft in Kharadi by March. Send 3 options on Friday.", 28));
      await t.step("Save it. Nothing in your records changes yet.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save capture" })));
      await p.waitForURL(/\/capture\/[0-9a-f-]+/, { timeout: 30000 });
      await soft(t, "CRE OS read the note. The receipt lists what it saved, matched and scheduled.", TX(p, /Note saved/));
      await soft(t, "'By March' is a target, not a contract date: the year stays unknown instead of being guessed.", TX(p, /by March/));
      await soft(t, "'Friday' became a task due this Friday — no question needed.", TX(p, /created, due/));
      await soft(t, "This box lists exactly what will be added: a meeting log, requirement details and a task.", TX(p, "What will be added when you press Reviewed"));
      await soft(t, "Each line shows the company or person it belongs to — check the names and numbers.", TX(p, /25,000/));
      await t.step("Looks right? Press Reviewed — now it goes to your records.", () => t.moveAndClick(main(p).getByRole("button", { name: /Reviewed/ })));
      await soft(t, "Facts for approval: important changes are listed with where they came from.", TX(p, /Facts for approval/i));
      await t.step("Each one can be checked and undone later from Review → History & undo.", () => t.scroll(300));
      await soft(t, "The capture's status now reads Reviewed.", TX(p, /^Reviewed/));
      await t.step("Open the company to see the result.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX })));
      await t.step("The Requirements tab shows the 25,000 sq ft need in Kharadi.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Requirements/ })));
      await soft(t, "Timeline holds the meeting log from your note.", L(p, /^Timeline/), { click: true });
      await soft(t, "And the follow-up task is waiting in Today → Tasks.", null);
      await t.step("Review in the sidebar is where any change still waiting for you shows up.", () => t.point(navLink(p, "Review")));
      await t.outro("captured a note, answered its questions, approved it and found the result on the company page.", "find accounts with a lease event.");
    },
  },

  {
    slug: "find-accounts", category: "Records & data", title: "Find accounts with a lease event",
    learn: "Describe the companies you want in plain words, edit the filters, read coverage and the evidence behind each match.", tryRoute: "/search?mode=accounts",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Find accounts with a lease event", "Describe the companies you are looking for in plain words — the filters are built for you.");
      await t.step("Open Search from the sidebar.", () => t.moveAndClick(p.getByRole("link", { name: /^Search/ }).or(p.getByPlaceholder(/^Search/))));
      await t.step("Search has two modes. 'Search everything' finds any record by name.", async () => { if (!/\/search/.test(p.url())) await t.goto("/search"); await t.point(L(p, "Search everything")); });
      await t.step("'Find accounts' finds companies that match a description. Switch to it.", () => t.moveAndClick(L(p, "Find accounts")));
      await t.step("Describe what you want, in plain English.", () => t.type(main(p).getByPlaceholder(/companies occupying/), "companies in Kharadi with a lease event next year"));
      await t.step("Press Find.", () => t.moveAndClick(B(p, /^Find$/)));
      await soft(t, "'Understood' shows how your words became filters: place Kharadi, lease event next year.", TX(p, /^Understood:/));
      await soft(t, "Edit filters opens every filter, so you can fine-tune by hand.", TX(p, /Edit filters/), { click: true });
      await soft(t, "Size: minimum and maximum square feet, on chargeable or carpet basis.", main(p).getByPlaceholder("Min SF"));
      await soft(t, "Places, building grade and sector.", main(p).getByPlaceholder(/Places/));
      await soft(t, "Lease event: expiry, notice or break, within a window of N months.", main(p).locator("select[name=ev]"));
      await soft(t, "Known contact, recent signals, score bands, and whether a requirement or deal already exists.", main(p).locator("select[name=bands]"));
      await soft(t, "Coverage: how many companies matched out of all you can see — so you know what was checked.", TX(p, /match(es)? of \d+ companies/));
      await soft(t, "Each match shows why it matched: the lease and its dates…", TX(p, /^Lease events:/));
      await soft(t, "…the contact you know there, and any signal about them.", TX(p, /Ananya Rao/));
      await t.step("Open the company to act on it.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX })));
      await soft(t, "From here, plan outreach, prepare a meeting, or compare buildings for them.", L(p, /^Next actions/));
      await t.outro("found companies in Kharadi with a lease event next year and checked why each matched.", "understand one company page.");
    },
  },

  {
    slug: "company", category: "Records & data", title: "Understand one company",
    learn: "Read a company page tab by tab: overview, occupancy, people, requirements, signals, scores, timeline, meetings, deals, documents, next actions.", tryRoute: "/companies",
    async run(t) {
      const p = t.page;
      await t.goto("/companies");
      await t.title("Understand one company", "Everything about one account on one page, split into tabs.");
      await soft(t, "Companies lists every account. Filter by name, add one, or show archived ones.", main(p).getByPlaceholder(/Filter company names/));
      await t.step("Find Zentrix Analytics and open it.", async () => {
        await t.type(main(p).getByPlaceholder(/Filter company names/), "Zentrix"); await p.keyboard.press("Enter");
        await t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX }));
      });
      await soft(t, "'Why do we believe this?' shows the source behind the facts on the page.", L(p, /Why do we believe this/));
      await soft(t, "Edit changes the basic details; 'As of' shows the page as it was on an earlier date.", L(p, /^Edit$/));
      await soft(t, "The tabs, each with a count: one part of the story per tab.", L(p, /^Overview/));
      await soft(t, "Overview — Identity: the basic facts. Unknown stays 'unknown' — nothing is guessed.", H(p, /^Identity/));
      await soft(t, "Next actions in short, with the dates that come from the lease.", H(p, /^Next actions/));
      await soft(t, "Locations: HQ, offices and sites. Add one, or pull office sites from leases.", H(p, /^Locations/));
      await soft(t, "Evidence trail lists every source; Shared with shows who else can see this company.", H(p, /^Evidence trail/));
      await soft(t, "Archive asks for a reason, and goes through Review like any other change.", H(p, /^Archive/));
      await soft(t, "Occupancy: where they sit today — buildings, leases, area, expiry dates.", L(p, /^Occupancy/), { click: true });
      await soft(t, "People: who works there, grouped by role, with how well you know them.", L(p, /^People/), { click: true });
      await soft(t, "Each person shows influence and relationship level — fill these in as you learn.", TX(p, "Ananya Rao"));
      await soft(t, "Requirements: what they are looking for — size, place, dates.", L(p, /^Requirements/), { click: true });
      await soft(t, "Signals: news that may mean they need space — marked unconfirmed until checked.", L(p, /^Signals/), { click: true });
      await soft(t, "Scores: how worth targeting the company is.", L(p, /^Scores/), { click: true });
      await soft(t, "Every score lists its reasons and what is still missing.", TX(p, /^Why:/));
      await soft(t, "Timeline: every call, note, email and change, newest first.", L(p, /^Timeline/), { click: true });
      await soft(t, "Meetings: past and upcoming meetings with this company.", L(p, /^Meetings/), { click: true });
      await soft(t, "Deals: opportunities in progress. Documents: leases, LOIs and files linked here.", L(p, /^Deals/), { click: true });
      await soft(t, "Documents: files linked to this company.", L(p, /^Documents/), { click: true });
      await soft(t, "Next actions: what to do next and when, most urgent first.", L(p, /^Next actions/), { click: true });
      await soft(t, "Open one to plan the work, or turn it into a task.", main(p).getByRole("link", { name: /notice deadline|Prepare/ }));
      await t.outro("read every tab of one company page.", "write outreach and send it yourself.");
    },
  },

  {
    slug: "outreach", category: "Outreach & meetings", title: "Write outreach and send it yourself",
    learn: "The Outreach screen and its tabs, then pick a person and situation, get a draft, approve it and send it from your own app.", tryRoute: "/outreach/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Write outreach and send it yourself", "CRE OS writes the draft. You check it and send it — it never sends anything on its own.");
      await t.step("Open Outreach: who to contact today, and why.", () => t.moveAndClick(navLink(p, "Outreach")));
      await soft(t, "Tabs: Today, Messages (drafts), Conversations, Relationships, Paused and Results.", L(p, /^Messages/));
      await soft(t, "New conversations to start: people worth contacting, with a quick 'Prepare drafts'.", H(p, /^New conversations to start/));
      await soft(t, "Choose Email, WhatsApp or Call for each suggestion.", main(p).getByText("WhatsApp", { exact: true }));
      await soft(t, "Follow-ups due: people waiting for your reply or a promised follow-up.", H(p, /^Follow-ups due/));
      await soft(t, "Re-check follow-ups looks again for anything newly due.", B(p, /Re-check follow-ups/));
      await t.step("To start from scratch, press New outreach.", () => t.moveAndClick(L(p, "New outreach")));
      await t.step("Choose the person — Ananya Rao at Zentrix Analytics.", async () => {
        const sel = main(p).locator("select").first(); await t.point(sel);
        await sel.selectOption({ label: "Ananya Rao — Head of Real Estate at Zentrix Analytics" });
        await t.moveAndClick(B(p, "Continue"));
      });
      await soft(t, "'What we know' lists the facts the draft is allowed to use — nothing else.", TX(p, "What we know"));
      await t.step("Pick the situation — here, Expansion.", async () => { const sel = main(p).locator("select").first(); await t.point(sel); await sel.selectOption({ label: "Expansion" }); });
      await t.step("Press Prepare drafts.", () => t.moveAndClick(B(p, "Prepare drafts")));
      await p.waitForURL(/\/outreach\/[0-9a-f-]{36}/, { timeout: 30000 });
      await soft(t, "The draft appears. 'Why now' shows the reason behind it.", TX(p, /Why now/));
      await soft(t, "Edit the text freely — it is yours.", main(p).locator("textarea").first());
      await t.step("Happy with it? Approve this exact text.", () => t.moveAndClick(B(p, /Approve this exact text/)));
      await t.step("Before sending, confirm the recipient and the text.", async () => {
        await t.moveAndClick(main(p).getByText(/^Recipient is correct/)); await t.moveAndClick(main(p).getByText("The text is exactly what I want to send"));
      });
      await soft(t, "'Check & open' opens your own mail app with this text. You press Send there.", B(p, /Check & open/));
      await soft(t, "After sending, press 'I sent it' so the follow-up is tracked.", B(p, "I sent it"));
      await t.step("The draft is listed under Outreach → Messages until it is sent.", async () => { await t.moveAndClick(navLink(p, "Outreach")); await t.point(L(p, /^Messages/)); });
      await soft(t, "After 'I sent it', it moves to Conversations and the follow-up shows on Today.", L(p, /^Conversations/));
      await t.outro("prepared, approved and got ready to send an outreach email.", "prepare for a meeting.");
    },
  },

  {
    slug: "meeting", category: "Outreach & meetings", title: "Prepare for a meeting",
    learn: "The Meetings tabs, creating a meeting, and every part of the preparation brief.", tryRoute: "/meetings/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Prepare for a meeting", "Add the meeting; CRE OS builds a brief from your records.");
      await t.step("Open Meetings.", () => t.moveAndClick(navLink(p, "Meetings")));
      await soft(t, "Tabs: Today, Upcoming, Needs preparation, Past, Cancelled and Reports.", L(p, /^Needs preparation/));
      await soft(t, "Today's meetings, and follow-ups you still owe from past ones.", H(p, /^Pending follow-ups/));
      await t.step("Press New meeting.", () => t.moveAndClick(L(p, "New meeting")));
      await t.step("Give it a title.", () => t.type(p.locator("input[name=title]"), "Zentrix Analytics — requirement discussion"));
      await t.step("Pick the type, the company and who is attending.", async () => {
        for (const [sel, label] of [["select[name=type]", "Requirement discussion"], ["select[name=org_id]", ZENTRIX], ["select[name=person_id]", "Ananya Rao — Zentrix Analytics"]]) {
          await t.point(p.locator(sel)); await p.locator(sel).selectOption({ label }); await sleep(500);
        }
      });
      await soft(t, "Date, time and place are optional; they put it on your calendar and day plan.", null);
      await soft(t, "'Prepare the brief now' is ticked, so the brief is built straight away.", main(p).getByText(/Prepare the brief now/));
      await t.step("Create the meeting.", () => t.moveAndClick(p.getByRole("button", { name: "Create meeting" })));
      await p.waitForURL(/\/meetings\/[0-9a-f-]{36}/, { timeout: 60000 });
      await soft(t, "Readiness shows how complete the brief is and what is still missing.", p.getByText("Readiness"));
      await soft(t, "Meeting purpose: why you're meeting and what triggered it.", p.getByRole("heading", { name: /Meeting purpose/ }));
      await soft(t, "Contents jumps between sections.", p.getByText("Contents", { exact: true }));
      await soft(t, "The company: who they are, where they sit and their lease dates.", p.locator("a[href=\"#company\"]"), { click: true });
      await t.step("Scroll on: attendees, history with them, requirement, open items…", () => t.scroll(800));
      await soft(t, "Questions to ask: what you still need to find out in the meeting.", p.getByRole("heading", { name: /Questions/ }));
      await t.step("…and risks or sensitive points to keep in mind.", () => t.scroll(800));
      await t.step("Back in Meetings it is listed under Upcoming; it also appears on Today.", async () => { await t.moveAndClick(navLink(p, "Meetings")); await t.point(L(p, /^Upcoming/)); });
      await soft(t, "After the meeting, capture your notes — they are linked back to this meeting.", navLink(p, "Capture"));
      await t.outro("created a meeting and read its preparation brief.", "compare buildings and download a deck.");
    },
  },

  {
    slug: "compare", category: "Deal toolkit", title: "Compare buildings and download a deck",
    learn: "The Deal toolkit home, then score shortlisted buildings against a requirement, read the ranking and download a deck.", tryRoute: "/toolkit/compare/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Compare buildings and download a deck", "Rank buildings against what the client needs — with the reasons shown.");
      await t.step("Open Deal toolkit.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await soft(t, "Start here: every tool — compare, cost a lease, stay or move, negotiation, packs and more.", H(p, /^Start here/));
      await soft(t, "Needs information: analyses that are waiting on missing inputs — shown, never guessed.", H(p, /^Needs information/));
      await soft(t, "Requirements awaiting analysis, and your recently updated work.", H(p, /^Requirements awaiting analysis/));
      await t.step("Choose Compare buildings.", () => t.moveAndClick(L(p, /Compare buildings/)));
      if (!/compare\/new/.test(p.url())) await t.step("Start a new comparison.", () => t.moveAndClick(L(p, /New comparison|New/)));
      await soft(t, "Step 1: the requirement and how buildings are rated.", H(p, /^Step 1/));
      await t.step("Name it.", () => t.type(main(p).getByPlaceholder("e.g. Kharadi 25k sf options"), "Zentrix — Kharadi options"));
      await t.step("Pick the client requirement. Its size and location become the must-have rules.", async () => {
        const sel = main(p).locator("select").first(); await t.point(sel); await sel.selectOption({ label: "Zentrix Analytics — 25,000 sf in Kharadi" });
      });
      await soft(t, "Rating model sets what matters most; lease term is used for the cost maths.", main(p).getByText(/Rating model/).first());
      await soft(t, "Step 2: buildings from your database, with micro-market and grade.", H(p, /^Step 2/));
      await t.step("Tick the buildings to compare: two in Kharadi, one in Hinjewadi.", async () => {
        for (const n of ["Kharadi Tech Park (demo)", "Kharadi Riverside Towers (demo)", "Hinjewadi Phase 2 Business Centre (demo)"]) await t.moveAndClick(main(p).getByLabel(n));
      });
      await soft(t, "Step 3 (optional): add buildings not yet in the database, with rent, CAM, deposit and where the figures came from.", H(p, /^Step 3/));
      await t.step("Press Compare buildings.", () => t.moveAndClick(B(p, /Compare buildings/)));
      await p.waitForURL(/\/toolkit\/compare\/[0-9a-f-]{36}/, { timeout: 60000 });
      await soft(t, "The recommendation, with the reasons in plain words.", main(p).getByText("RECOMMENDATION", { exact: false }));
      await soft(t, "Hinjewadi is 'not eligible': it fails the must-have rule 'in Kharadi'.", TX(p, /is not eligible: fails/));
      await t.step("The table scores each building on each criterion.", () => t.scroll(600));
      await soft(t, "Missing inputs are listed, never treated as zero.", TX(p, /inputs missing/));
      await t.step("Costs are computed by fixed formulas, not by the AI.", () => t.scroll(600));
      await t.step("Download deck makes a PowerPoint you can edit and send.", async () => { await t.scroll(-3000); await t.moveAndClick(main(p).getByText(/Download deck/)); });
      await t.step("The comparison is saved in Deal toolkit under Recently updated.", async () => { await t.moveAndClick(navLink(p, "Deal toolkit")); await t.point(H(p, /^Recently updated/)); });
      await t.outro("compared three buildings against a requirement and downloaded the deck.", "ask the AI a question.");
    },
  },

  {
    slug: "ask-ai", category: "Ask AI & automation", title: "Ask AI anything",
    learn: "The Ask AI screen and tabs, asking a question, the steps it took, coverage, the answer and opening records from it.", tryRoute: "/assistant",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Ask AI anything", "Ask about your accounts in plain words. Every answer shows how it was found.");
      await t.step("Open Ask AI.", () => t.moveAndClick(navLink(p, "Ask AI")));
      await soft(t, "Ready-made starters: prepare for a meeting, expiring leases, promises to clients…", H(p, /What do you need to get done/));
      await soft(t, "Your past conversations are on the side; search them or start a new one.", main(p).getByPlaceholder("Search conversations"));
      await soft(t, "Memory shows what the assistant remembers; Saved commands can run on a schedule.", L(p, /What the assistant remembers/));
      await t.step("Type your question.", () => t.type(main(p).getByPlaceholder(/Ask about your accounts/), "Which five accounts should I focus on this week?"));
      await t.step("Press Ask.", () => t.moveAndClick(B(p, /^Ask$/)));
      const trail = main(p).getByRole("button", { name: /Worked through/ }).first();
      await trail.or(main(p).getByText(/^Coverage:/).first()).first().waitFor({ timeout: 90000 });
      await sleep(800);
      if (await trail.isVisible()) await t.step("It shows the steps it took. Click to see them.", () => t.moveAndClick(trail));
      await soft(t, "Each step is a lookup in your own records — it can't change anything.", null);
      await soft(t, "Coverage says what it checked — and that it only knows what is in CRE OS.", TX(p, /^Coverage:/));
      await soft(t, "The answer: accounts ranked by score, each with its reasons and a next step.", TX(p, /^Identifiable need/));
      await t.step("Scroll to read the rest.", () => t.scroll(500));
      await soft(t, "Ask a follow-up in the same box; the conversation is saved on the side.", main(p).getByPlaceholder(/Ask about your accounts/));
      await t.step("Click a company to open its record.", () => t.moveAndClick(main(p).getByRole("link", { name: "Quokka Grid Infotech" })));
      await t.outro("asked a question, checked the steps and coverage, and opened a company.", "see an automation turn a lease date into a requirement.");
    },
  },

  {
    slug: "automation", category: "Ask AI & automation", title: "Renewal or relocation (automatic)",
    learn: "The Automations screen, then watch the lease automation propose a requirement, wait for your OK, then shortlist, compare and add a task.", tryRoute: "/workflows",
    async run(t) {
      const p = t.page;
      leaseChain("cleanup"); leaseChain("prepare");
      await t.goto("/workflows");
      await t.title("Renewal or relocation — automatically", "When a lease date comes close, an automation prepares the work. You approve the important part.");
      await t.step("Automations live under More → Automations. They run by themselves every few minutes.", () => t.point(H(p, "Workflows")));
      await soft(t, "Check now runs them immediately instead of waiting.", B(p, /Check now/));
      await soft(t, "Each automation can be turned off or on here.", B(p, /Turn off|Turn on/));
      await soft(t, "This one watches leases: when a notice date or expiry comes close, it starts.", TX(p, "Lease → renewal / relocation"));
      await soft(t, "Zentrix's notice deadline is near, so it proposed a requirement — and is waiting for you.", TX(p, "Waiting for approval"));
      await t.step("Open the approval.", () => t.moveAndClick(L(p, "Approval")));
      await t.step("A new requirement, prefilled from the lease. Unknowns are left blank.", async () => {
        await p.waitForURL(/approvals/); await sleep(1500); await t.point(TX(p, "Renewal or relocation — Zentrix Analytics"));
      });
      await soft(t, "Edit proposed values if something needs changing before you approve.", TX(p, /Edit proposed values/));
      await soft(t, "Or ask to clarify, or reject — the automation then stops here.", B(p, /Ask to clarify/));
      await t.step("Approve it.", () => t.moveAndClick(TX(p, "Renewal or relocation — Zentrix Analytics").first().locator("xpath=ancestor::*[.//button[normalize-space()='Approve & apply']][1]//button[normalize-space()='Approve & apply']")));
      await t.step("On its next check, the automation carries on by itself.", async () => { leaseChain("resume"); });
      await t.step("Back in Automations: every step is listed with what it did.", async () => { await t.goto("/workflows"); await t.point(TX(p, /Discuss renewal vs relocation|Task assigned/)); });
      await soft(t, "It matched alternative buildings and compared renewing vs moving.", TX(p, /compar|shortlist|match/i));
      await soft(t, "And it added a task for you.", L(p, "Task"));
      await t.step("Open the task.", () => t.moveAndClick(L(p, "Task")));
      await soft(t, "The task also appears on Today and in Tasks; the comparison is in Deal toolkit.", navLink(p, "Today"));
      await t.outro("approved an automatic renewal-or-relocation requirement and opened the task it created.", "watch the full tour again, or try it yourself.");
    },
  },
];

/** After recording: leave no automation leftovers that would change the other videos next time. */
const finish = () => leaseChain("cleanup");

module.exports = { FLOWS, prepare, finish };
