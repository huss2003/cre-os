// Tutorial videos, group "intel": signals, research, scores, contacts, network, market & reports.
// Record: node scripts/tutorial-videos/record.js --group intel
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { sleep } = require("./harness");

const CAT = "Signals, scores & contacts";
const ZENTRIX = "Zentrix Analytics";
const WS = "de000000-0000-4000-8000-000000000001";
const ZENTRIX_ID = "db898560-1396-5fc1-b121-4bec23da7315";
const ANANYA = "dc09713c-84ef-5bc7-b214-2e3b3529738f";
const VIKRAM = "1fc4a8c7-1432-5694-b87d-a48d6e142297";
const OWNER = process.env.TUT_OWNER_ID || null;
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const CSV = path.join(os.tmpdir(), "tutorial-intel", "Connections.csv");

const nav = (p) => p.getByRole("navigation", { name: "Main" });
const main = (p) => p.locator("main");
const psql = (sql) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", sql], { stdio: "pipe" }).toString();

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
/** Point at something if it is on screen; otherwise just scroll on (re-runs and optional sections never fail a video). */
async function soft(t, loc) {
  try { await loc.first().waitFor({ state: "visible", timeout: 4000 }); await t.point(loc); } catch { await t.scroll(300); }
}
/** Page tab (the row of section tabs above the page, e.g. Market / Network / Legal). */
const pageTab = (p, name) => p.getByRole("link", { name, exact: true }).filter({ hasNot: p.locator("nav[aria-label=Main] *") });

/** Not filmed: demo data this group needs (demo workspace only; only rows this group owns). */
async function prepare() {
  // A colleague-style path for the warm-intro video: Ananya Rao has worked with Vikram Desai (CFO, Zentrix).
  psql(`insert into mudar.relationship_edge (id, workspace_id, from_person_id, to_person_id, edge_type, warmth, strength_basis, last_meaningful_contact, classification)
        values ('de000000-0000-4000-8000-0000000a1e01', '${WS}', '${ANANYA}', '${VIKRAM}', 'worked_with', 'warm', 'Tutorial demo: worked together on the Zentrix Pune office (synthetic).', current_date - 20, 'permitted_personal')
        on conflict (id) do nothing`);
  // Score-override video starts from the computed priority.
  psql(`update mudar.score_override set active = false where workspace_id = '${WS}' and model_key = 'company' and entity_id = '${ZENTRIX_ID}' and kind = 'priority' and active`);
  // LinkedIn export used by the find-contacts video (synthetic person).
  fs.mkdirSync(path.dirname(CSV), { recursive: true });
  fs.writeFileSync(CSV, "Notes:\n\"Synthetic demo export for the tutorial video.\"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n" +
    "Rohan,Kulkarni,,rohan.kulkarni@zentrix.example,Zentrix Analytics,Head of Facilities & Workplace,01 Oct 2026\n");
}

/** First link to a signal card (not the Sources / lookup pages linked from the header). */
const signalLink = (p) => main(p).locator("a[href^='/signals/']:not([href^='/signals/sources']):not([href^='/signals/lookup'])").first();

const FLOWS = [
  {
    slug: "signal-paste-v3", category: CAT, title: "Turn pasted news into a signal",
    learn: "Paste an article or a note; CRE OS finds the event in it and adds an unverified signal you can review.", tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await p.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
      await t.goto("/today");
      await t.title("Turn pasted news into a signal", "Saw something in the news? Paste it — CRE OS picks out the event and files it as a signal to check.");
      await t.step("Open Signals: news and events that may mean a company needs space.", () => side(t, "Signals"));
      await t.step("Top: how many signals are open and how many need action now. 'Scan now' re-checks your sources.", () => t.point(main(p).getByRole("button", { name: "Scan now" })));
      await t.step("Right next to it, at the top of the page: 'Paste news or a note'. Open it.", () => t.moveAndClick(main(p).getByText("Paste news or a note")));
      await t.step("Name the company it is about.", () => t.type(main(p).getByPlaceholder("ABC Technologies"), "Tamarind Stack Labs", 30));
      await t.step("Paste the article text. It is only read for events — instructions inside it are ignored.", () => t.type(main(p).getByPlaceholder("Paste the announcement or article"),
        "Tamarind Stack Labs is expanding in Pune: it plans a new office in Kharadi and is hiring 400 engineers next year.", 14));
      await t.step("Press Find signals.", () => t.moveAndClick(main(p).getByRole("button", { name: "Find signals" })));
      await t.step("The result line says how many signals were found and how many are new — the same news pasted twice is not added twice.", () => soft(t, main(p).getByText(/signal\(s\) found/)));
      await t.step("The signal is listed, marked Unverified until you check it.", () => soft(t, main(p).getByRole("link", { name: /Tamarind Stack Labs/ })));
      await t.step("Below the paste box: the 12-month strip of dated events, like lease expiries, month by month.", () => soft(t, main(p).getByText("Next 12 months")));
      await t.step("Filters: by type (expansion, lease events, leadership…), Unverified, and Dismissed & snoozed.", () => soft(t, main(p).getByRole("link", { name: /^Unverified/ })));
      await t.step("Each card: type, headline, company, source and status. The bars show how strong the evidence is.", () => soft(t, main(p).getByText(/Tamarind Stack Labs: possible/).first()));
      await t.step("Open it to see the evidence and decide what to do.", async () => {
        const tamLink = main(p).getByRole("link", { name: /Tamarind Stack Labs/ }).first();
        if (await tamLink.isVisible().catch(() => false)) return t.moveAndClick(tamLink);
        await t.moveAndClick(main(p).getByRole("link", { name: /^Unverified/ })); // pasted on an earlier run: open it from the Unverified view
        const again = main(p).getByRole("link", { name: /Tamarind Stack Labs/ }).first();
        await t.moveAndClick((await again.isVisible().catch(() => false)) ? again : signalLink(p));
      });
      await t.step("'What happened' quotes the event; the source is your pasted text.", () => t.point(main(p).locator("summary", { hasText: /^1\. What happened/ }).first()));
      await t.outro("pasted a news item and got an unverified signal for Tamarind Stack Labs.", "review a signal and decide what to do with it.");
    },
  },
  {
    slug: "signals-review-v2", category: CAT, title: "Review a new signal and decide",
    learn: "Every part of a signal page: the 12 evidence sections, priority and history, and each decision — approve, investigate, dismiss, snooze, task, deal, research, evidence, override.", tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await p.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
      await t.goto("/today");
      await t.title("Review a new signal", "A signal is a hint, not a fact. Check the evidence, then decide what to do with it.",
        ["Read the 12 sections", "Add supporting or counter evidence", "Approve, investigate, dismiss or snooze", "Link it to a task or deal"]);
      await t.step("Open Signals.", () => side(t, "Signals"));
      await t.step("Unverified lists signals nobody has checked yet.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Unverified/ })));
      const tam = main(p).getByRole("link", { name: /Tamarind Stack Labs/ }).first();
      const isTam = (await tam.count()) > 0;
      await t.step("Open one to review it.", () => t.moveAndClick(isTam ? tam : signalLink(p)));
      await t.step("Header: type, company, and badges — urgency, evidence strength, Unverified and New.", () => soft(t, main(p).getByText("Unverified").first()));
      await t.step("1. What happened — the event, quoted from the source.", () => soft(t, main(p).locator("summary", { hasText: /^1\. What happened/ }).first()));
      await t.step("2. Why it matters — CRE OS's reading of it, labelled as interpretation, not fact.", () => soft(t, main(p).getByText("2. Why it matters")));
      await t.step("3. Supporting evidence: every source behind the signal.", () => soft(t, main(p).getByText("3. Supporting evidence")));
      await t.step("4–9: what you already know — company records, offices, occupancy, leases, contacts, requirements.", () => soft(t, main(p).getByText("7. Relevant lease events")));
      await t.step("10. Counter-evidence: 'none found yet' does not mean there is none.", () => soft(t, main(p).getByText("10. Counter-evidence")));
      await t.step("11. Missing information and 12. Suggested next steps.", () => soft(t, main(p).getByText(/^12\. Suggested next step/).first()));
      await t.step("Priority — why: the reasons behind its urgency. History: every decision made on it.", () => soft(t, main(p).getByText("Priority — why")));
      await t.step("Know something? Add it as evidence, with its source.", async () => {
        await t.type(main(p).locator("textarea[name=text]").last(), "Their Pune HR head confirmed the hiring plan on a call.", 22);
      });
      await t.step("'Add supporting' backs the signal; 'Add counter-evidence' records evidence against it.", async () => {
        await t.point(main(p).getByRole("button", { name: /^Add counter/ }));
        await t.moveAndClick(main(p).getByRole("button", { name: "Add supporting" }));
      });
      await t.step("Wrong company matched? Correct it here.", () => soft(t, main(p).getByRole("button", { name: "Save company" })));
      await t.step("Research this company searches the web for recent news (needs an AI key).", () => soft(t, main(p).getByRole("button", { name: "Research this company" })));
      await t.step("Link it to an existing deal, or propose a new opportunity — it goes to Review for approval.", () => soft(t, main(p).getByRole("button", { name: "Propose opportunity" })));
      await t.step("Override the priority with a reason and a review date — it comes back for review then.", () => soft(t, main(p).getByRole("button", { name: "Save override" })));
      await t.step("Or just create a follow-up task from it.", () => soft(t, main(p).getByRole("button", { name: "Create task" })));
      await t.step("Decide: write a short reason first — it is kept in History.", () => t.type(main(p).locator("input[name=reason]").first(), "Hiring plan confirmed on a call", 22));
      await t.step("Investigate: keep it open while you check. Assign to me: make it yours. Already known: you knew.", () => soft(t, main(p).getByRole("button", { name: "Investigate" })));
      await t.step("Reject: it is wrong. Dismiss: not relevant. Snooze until a date: look again later. Nothing is deleted.", () => soft(t, main(p).getByRole("button", { name: "Dismiss" })));
      if (isTam) {
        await t.step("Approve + task: it becomes a confirmed lead with a follow-up task.", () => t.moveAndClick(main(p).getByRole("button", { name: "Approve + task" })));
        await t.step("The decision now shows in History, and the task appears under Tasks on Today.", async () => { await t.scroll(-3000); await soft(t, main(p).getByText("History").first()); });
      } else {
        await t.step("Approve + task makes it a confirmed lead with a follow-up task (shown under Tasks on Today).", () => soft(t, main(p).getByRole("button", { name: "Approve + task" })));
      }
      await t.outro("read every section of a signal, added evidence and made a decision.", "research the company behind it.");
    },
  },
  {
    slug: "research-company", category: CAT, title: "Research a company (dossier with sources)",
    learn: "Store evidence with its source and date, then generate a dossier where every section shows its source — and unknowns stay unknown.", tryRoute: "/research",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Research a company", "Collect evidence with its source and date, then build a dossier. Nothing is guessed.");
      await t.step("Open Research from the More menu.", () => side(t, "Research"));
      await t.step("The banner says web research is off (no AI key) — only pasted news and your own data are used.", () => t.point(main(p).getByText("Web research is off")));
      await t.step("The counters: companies watched, research due now, and AI spend this month.", () => t.point(main(p).getByText("AI this month")));
      await t.step("'Is this a potential client?' scores one company out of 100. Pick Zentrix Analytics.", async () => {
        const sel = main(p).locator("select[name=org_id]").first(); await t.point(sel); await sel.selectOption({ label: ZENTRIX });
      });
      await t.step("Press Assess company.", () => t.moveAndClick(main(p).getByRole("button", { name: "Assess company" })));
      await t.step("The result: a score out of 100, scored from your records because AI is not connected.", () => t.point(main(p).getByText(/Zentrix Analytics: \d+\/100/).first()));
      await t.step("Live research lists each run — what was searched and which sites gave evidence.", () => t.point(main(p).getByText(/Client score: Zentrix Analytics/).first()));
      await t.step("To keep researching it on a schedule, add it to the watchlist.", async () => {
        const sel = main(p).locator("select[name=org_id]").nth(1); await t.point(sel); await sel.selectOption({ label: ZENTRIX });
        const tier = main(p).locator("select[name=tier]").first(); await t.point(tier); await tier.selectOption({ index: 0 });
        await t.type(main(p).locator("input[name=reason]").first(), "Lease event within 12 months", 22);
      });
      await t.step("Press Add to watchlist (already watched? it just stays on the list).", async () => {
        const watched = (await main(p).getByRole("link", { name: ZENTRIX, exact: true }).count()) > 0;
        if (watched) await t.point(main(p).getByRole("button", { name: "Add to watchlist" })); else await t.moveAndClick(main(p).getByRole("button", { name: "Add to watchlist" }));
      });
      await t.step("Zentrix is now watched. Open it to see its research dossier.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX, exact: true }).first()));
      await t.step("The dossier page. Paste evidence first — sections without evidence will say 'unknown'.", () => t.point(main(p).getByText("Paste evidence").first()));
      await t.step("Paste what the source says.", () => t.type(main(p).locator("textarea[name=text]").first(),
        "Zentrix Analytics careers page lists 120 open roles in Pune (Kharadi office).", 16));
      await t.step("Add the link and publication date, so anyone can check it later.", async () => {
        await t.moveAndClick(main(p).getByText("More details (optional)").first());
        await t.type(main(p).locator("input[name=url]").first(), "https://zentrix.example/careers", 18);
        await main(p).locator("input[name=published_on]").first().fill("2026-11-01");
      });
      await t.step("Store evidence.", () => t.moveAndClick(main(p).getByRole("button", { name: "Store evidence" })));
      await t.step("Watchlist tier sets how often it is re-researched: weekly, monthly or quarterly.", () => t.point(main(p).getByText("Watchlist tier").first()));
      await t.step("Detect signals checks the stored evidence for expansion, hiring, funding and similar — as hypotheses.", () => t.moveAndClick(main(p).getByRole("button", { name: "Detect signals" })));
      await t.step("Generate (or refresh) the dossier from everything on file.", () => t.moveAndClick(main(p).getByRole("button", { name: /Generate dossier|Refresh if changed/ }).first()));
      await t.step("Each section lists its sources and dates; missing ones say 'unknown'.", async () => { await t.scroll(500); await sleep(800); await t.scroll(500); });
      await t.step("Evidence on file: every item with its source and date.", () => t.point(main(p).getByText(/Evidence on file/)));
      await t.outro("stored a piece of evidence with its source and generated a company dossier.", "read the company's scores.");
    },
  },
  {
    slug: "scores-explained", category: CAT, title: "Read a company's scores — and why",
    learn: "The Scores page (counters, tabs, filters) and one score in full: factors, evidence, missing information, risks, AI summary and feedback. Unknown is not a low score.", tryRoute: "/scoring",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Read a company's scores — and why", "Every score shows its reasons, how much is known and how sure it is.");
      await t.step("Open Scores from the More menu: who to focus on first.", () => side(t, "Scores"));
      await t.step("Counters: companies scored, high-priority companies and leads, matches, contacts ranked…", () => soft(t, main(p).getByText("Companies scored")));
      await t.step("'Waiting to recalculate' and 'Not enough data' show what is still pending.", () => soft(t, main(p).getByText("Waiting to recalculate")));
      await t.step("'Score everything now' recalculates all scores at once — normally they update on their own.", () => soft(t, main(p).getByRole("button", { name: /Score everything now/ })));
      await t.step("Tabs: Companies, Leads, Contacts, Requirements, Property matches, Opportunities, Relationships.", () => soft(t, main(p).getByRole("link", { name: "Leads", exact: true })));
      await t.step("Filter by priority and confidence, and sort — highest, lowest, recent, most complete.", async () => { await soft(t, main(p).locator("select").first()); });
      await t.step("More filters: industry, place, lease expiry, owner, score range, completeness.", () => soft(t, main(p).getByText("More filters")));
      await t.step("Each row: rank, recommended action, the score bar, confidence, % known, score and priority.", () => soft(t, main(p).getByText(/% known/).first()));
      await t.step("Open Zentrix Analytics.", () => t.moveAndClick(main(p).getByRole("link", { name: new RegExp(ZENTRIX) }).first()));
      await t.step("Top: the score, priority, confidence and completeness. 'Open record' goes to the company; 'Recalculate' re-scores now.", () => soft(t, main(p).getByRole("button", { name: "Recalculate" })));
      await t.step("Recommended next step: what the score suggests you do.", () => soft(t, main(p).getByText("Recommended next step")));
      await t.step("AI summary: a plain-English read of the score. It explains, it never changes the score.", () => soft(t, main(p).getByText("AI summary")));
      await t.step("How the score is built: points per factor, out of its maximum.", async () => { await soft(t, main(p).getByText("How the score is built")); await t.scroll(250); });
      await t.step("Open a factor to see the evidence behind it — linked signals and sources with dates.", () => t.moveAndClick(main(p).locator("details summary").filter({ hasText: "Pune relevance" }).first()));
      await t.step("A factor with no data shows 'Unknown' — left out, not scored as zero.", () => soft(t, main(p).getByText("Unknown", { exact: true })));
      await t.step("Missing information: what would make the score more certain. Key risks: what could undermine it.", () => soft(t, main(p).getByText("Missing information")));
      await t.step("Change priority: overrule the band with a reason (next video).", () => soft(t, main(p).getByText("Change priority")));
      await t.step("Is this score right? Send feedback — too high, too low, wrong company… — to tune the rules.", () => soft(t, main(p).getByRole("button", { name: "Send feedback" })));
      await t.step("The same scores appear on the company page under its Scores tab.", async () => { await t.scroll(600); });
      await t.outro("read the Scores page and one company's score in full.", "override a priority when you know better.");
    },
  },
  {
    slug: "score-override", category: CAT, title: "Override a priority (with a reason)",
    learn: "Change a company's priority when you know better; the reason is kept, the score is untouched, and the list shows both. Remove the override any time.", tryRoute: "/scoring",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Override a priority", "You know something the score doesn't? Set the priority yourself — with a reason, so others see why.");
      await t.step("Open Scores.", () => side(t, "Scores"));
      await t.step("Zentrix Analytics: score and priority High, worked out from the rules.", () => t.point(main(p).getByRole("link", { name: new RegExp(ZENTRIX) }).first()));
      await t.step("Open it.", () => t.moveAndClick(main(p).getByRole("link", { name: new RegExp(ZENTRIX) }).first()));
      await t.step("Scroll to Change priority.", () => t.point(main(p).getByText("Change priority")));
      await t.step("The list holds the priority bands of this model, from Very High to Very Low.", () => t.point(main(p).locator("select[name=value]").first()));
      await t.step("Pick Very High.", async () => { const s = main(p).locator("select[name=value]").first(); await s.selectOption("Very High"); });
      await t.step("Write why. Without a reason it won't save.", () => t.type(main(p).locator("input[name=reason]").first(), "CFO confirmed board approval for the Kharadi move", 22));
      await t.step("Save priority. The score number is not changed — only the priority you act on.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save priority" })));
      await t.step("A Remove button now appears: it switches the override off and the computed priority returns.", () => soft(t, main(p).getByRole("button", { name: "Remove" })));
      await t.step("Use 'Is this score right?' too, so the rules can be tuned if they keep getting it wrong.", () => soft(t, main(p).getByRole("button", { name: "Send feedback" })));
      await t.step("Back to the Scores list…", () => side(t, "Scores"));
      await t.step("…the computed priority is struck through and yours is shown next to it.", () => soft(t, main(p).getByRole("link", { name: new RegExp(ZENTRIX) }).first().locator("s")));
      await t.step("Filtering by priority uses your override, so Zentrix now shows under Very High.", async () => {
        const s = main(p).locator("select").first(); await t.point(s);
        await s.selectOption({ label: "Very High" }).catch(() => {});
        await t.moveAndClick(main(p).getByRole("button", { name: "Apply" }));
      });
      await t.step("Signals have their own override, with a review date, on each signal page.", () => soft(t, main(p).getByRole("link", { name: new RegExp(ZENTRIX) }).first()));
      await t.outro("overrode a company's priority with a reason and saw it on the Scores list.", "adjust the scoring weights.");
    },
  },
  {
    slug: "scoring-models", category: CAT, title: "Adjust scoring weights and preview the effect",
    learn: "Every part of the scoring rules page: the six models, weights, rules for unknown data, priority thresholds, industry weights, focus cities, preview and versions.", tryRoute: "/scoring/models",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Adjust scoring weights", "Decide what matters most to you — and preview what changes before you save.");
      await t.step("Open Scores.", () => side(t, "Scores"));
      await t.step("Press Scoring rules.", () => t.moveAndClick(main(p).getByRole("link", { name: "Scoring rules" })));
      await t.step("Six models, one per thing being scored: companies, leads, contacts, requirements, opportunities, relationships.", () => t.point(main(p).getByRole("link", { name: "Lead priority" })));
      await t.step("This is Company attractiveness. The version number shows which rules are live.", () => soft(t, main(p).getByText(/version \d+/i).first()));
      await t.step("Weights add up to 100; if they don't, they are scaled to 100.", () => soft(t, main(p).getByText(/Weights total/)));
      await t.step("Each factor says what it measures — here Company scale: headcount and number of sites.", () => soft(t, main(p).getByText("Company scale").first()));
      await t.step("'If unknown': leave it out (default), count it as half, or count it as zero.", () => t.point(main(p).locator("select[name=u_scale]")));
      await t.step("Say growth matters more this quarter: raise Growth indicators from 20 to 30.", async () => { const w = main(p).locator("input[name=w_growth]"); await t.point(w); await w.fill(""); await w.pressSequentially("30", { delay: 120 }); });
      await t.step("Priority thresholds: the lowest score for each band — e.g. 80 and up is Very High.", () => soft(t, main(p).locator("textarea[name=bands]")));
      await t.step("Industry weights: how attractive each sector is, from 0 to 1. GCCs always count as 1.", () => soft(t, main(p).locator("textarea[name=industry]")));
      await t.step("Focus cities: where occupancy counts for the location factor — here Pune.", () => soft(t, main(p).locator("input[name=focus]")));
      await t.step("Try on a record before saving — pick Zentrix Analytics.", async () => { const s = main(p).locator("select[name=sample]"); await t.point(s); await s.selectOption({ label: ZENTRIX }); });
      await t.step("Press Preview.", () => t.moveAndClick(main(p).getByRole("button", { name: "Preview" })));
      await t.step("The preview shows the score under the new weights. Nothing is saved yet.", async () => { await t.scroll(400); });
      await t.step("To keep it: add a note saying why, then 'Save as new version'. Old versions stay, so past scores can be explained.", () => soft(t, main(p).getByRole("button", { name: "Save as new version" })));
      await t.step("Versions: switch back to an older one, or switch a model off, any time.", () => soft(t, main(p).getByRole("button", { name: "Switch off" })));
      await t.outro("explored every scoring rule and previewed a weight change on one company.", "find decision-makers at a company.");
    },
  },
  {
    slug: "find-contacts", category: CAT, title: "Find decision-makers and verify a contact",
    learn: "Bring in people (here from your own LinkedIn export), approve the right ones, then mark a contact detail verified.", tryRoute: "/contacts?tab=research",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Find decision-makers, verify a contact", "Find the people who decide on office space. Nothing is saved until you approve it.");
      await t.step("Open Find contacts from the More menu.", () => side(t, "Find contacts"));
      await t.step("Find people: three ways to bring in new people.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Find people/ })));
      await t.step("Web search needs an AI key; your own LinkedIn connections export works without one.", () => t.point(main(p).getByText("Import your LinkedIn connections")));
      await t.step("Choose your Connections.csv and keep 'Only CRE-relevant roles' ticked.", async () => {
        await main(p).locator("input[name=file]").setInputFiles(CSV);
        await t.point(main(p).getByText("Only CRE-relevant roles"));
      });
      await t.step("Press Import. People go to 'To review' — not into your records yet.", () => t.moveAndClick(main(p).getByRole("button", { name: "Import", exact: true })));
      await t.step("Open To review.", () => t.moveAndClick(main(p).getByRole("link", { name: /^To review/ })));
      await t.step("Rohan Kulkarni, Head of Facilities at Zentrix — a decision-maker. Approve him.", async () => {
        const card = main(p).locator("li, article, div").filter({ hasText: "Rohan Kulkarni" }).filter({ has: p.getByRole("button", { name: "Approve" }) }).last();
        await t.point(card.getByText("Rohan Kulkarni").first());
        await t.moveAndClick(card.getByRole("button", { name: "Approve" }));
      });
      await t.step("Open Your contacts → he is listed with his role.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Your contacts/ })));
      await t.step("Open his contact page.", async () => {
        const all = main(p).getByRole("link", { name: /^Everyone/ });
        if (await all.count()) await t.moveAndClick(all);
        await t.moveAndClick(main(p).getByRole("link", { name: /Rohan Kulkarni/ }).first());
      });
      await t.step("What we know, field by field: each has its own status — Reported, Inferred or Missing.", () => t.point(main(p).getByText("What we know, field by field")));
      await t.step("The score shows how relevant this contact is for office decisions.", () => t.point(main(p).getByText(/Contact relevance/).first()));
      await t.step("CRE relevance: assessed from his title as a Decision-maker — confirm it, with a reason.", async () => {
        await t.point(main(p).getByText("CRE relevance").first());
        await t.type(main(p).getByPlaceholder("Why? (required)").first(), "He confirmed he signs off office leases", 22);
      });
      await t.step("Press Correct role to save the verified role.", () => t.moveAndClick(main(p).getByRole("button", { name: "Correct role" }).first()));
      await t.step("Has a business email you confirmed? It appears under contact details with 'Mark verified'.", async () => { await t.scroll(500); });
      await t.outro("imported a connection, approved a decision-maker and confirmed his role.", "find a warm introduction path.");
    },
  },
  {
    slug: "warm-intro", category: CAT, title: "Find a warm introduction path",
    learn: "The Network tab: record job moves, confirm them, record who knows whom, see introduction paths with consent status, and multi-threading gaps on deals.", tryRoute: "/network",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Find a warm introduction path", "Who can introduce you to a decision-maker? Only relationships you recorded are used.");
      await t.step("Open Market & reports from the More menu.", () => side(t, "Market & reports"));
      await t.step("Choose the Network tab. Nothing here is scraped — you record what you saw.", () => t.moveAndClick(pageTab(p, "Network")));
      await t.step("Record a job move: the person, where they moved, and how you saw it.", () => soft(t, main(p).getByText("Record a job move")));
      await t.step("Recent job moves stay 'unverified — not a fact yet' until you confirm them.", () => soft(t, main(p).getByText(/unverified — not a fact yet/).first()));
      await t.step("Mark confirmed, with how you checked, turns the move into a fact.", () => soft(t, main(p).getByRole("button", { name: "Mark confirmed" })));
      await t.step("Record a relationship: who knows whom, how, and how strong. Intro consent is set on the person's page.", () => soft(t, main(p).getByText("Record a relationship")));
      await t.step("Introduction paths: pick the company — Zentrix Analytics — and press Show paths.", async () => {
        const s = main(p).locator("select[name=org]"); await t.point(s); await s.selectOption({ label: ZENTRIX });
        await t.moveAndClick(main(p).getByRole("button", { name: "Show paths" }));
      });
      await t.step("Direct: you know Ananya Rao yourself — warm, with the last contact date.", () => soft(t, main(p).getByText("You → Ananya Rao").first()));
      await t.step("Via a person: Ananya worked with Vikram Desai, the CFO — she could introduce you.", () => soft(t, main(p).getByText(/Ananya Rao → Vikram Desai/).first()));
      await t.step("'Ask first': no intro consent recorded. Green 'intro consent recorded' means she agreed.", () => soft(t, main(p).getByText(/ask first/).first()));
      await t.step("People who asked not to be contacted are left out of paths automatically.", () => soft(t, main(p).getByText("Introduction paths")));
      await t.step("Multi-threading gaps: open deals missing key people, like procurement or tenant legal.", () => soft(t, main(p).getByText(/Multi-threading gaps/)));
      await t.step("Open a deal from here to fix the gap.", () => soft(t, main(p).locator("a[href^='/insights/deals/']").first()));
      await t.outro("found direct and via-colleague introduction paths and saw the rest of the Network tab.", "open one person's contact workspace.");
    },
  },
  {
    slug: "contact-workspace", category: CAT, title: "Understand one person",
    learn: "A person's page: role, employment history, relationships and intro consent, relationship level, interactions, outreach, tasks and contact details.", tryRoute: "/people",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Understand one person", "Everything about one contact: where they work, how well you know them, and what has happened.");
      await t.step("Open People.", () => side(t, "People"));
      await t.step("Find Ananya Rao.", async () => {
        const box = main(p).getByRole("searchbox").or(main(p).getByPlaceholder(/search|name/i)).first();
        await t.type(box, "Ananya Rao"); await p.keyboard.press("Enter");
        await t.moveAndClick(main(p).getByRole("link", { name: "Ananya Rao" }).first());
      });
      await t.step("Her role and company at the top. 'Why do we believe this?' shows the evidence.", () => soft(t, main(p).getByRole("link", { name: "Why do we believe this?" })));
      await t.step("Plan outreach starts a draft; Enrichment & verification checks her details; Edit changes them.", () => soft(t, main(p).getByRole("link", { name: "Enrichment & verification" })));
      await t.step("Employment history: each job with its dates. Past roles are kept, not overwritten.", () => soft(t, main(p).getByText(/start unknown – present/).first()));
      await t.step("Relationships: who knows her, how (client of), how warm, and the last contact.", () => soft(t, main(p).getByText(/client of · warm/).first()));
      await t.step("Add relationship context or connect her to another person — this feeds intro paths.", () => soft(t, main(p).getByText("+ Connect to another person")));
      await t.step("Introduction consent: whether she agreed to introduce you. 'Permission not recorded' means ask first.", () => soft(t, main(p).getByText(/permission not recorded/).first()));
      await t.step("Interactions: every meeting, call and email with her, newest first.", () => soft(t, main(p).getByText(/meeting Debrief — Zentrix Analytics/).first()));
      await t.step("Outreach: drafts and approved messages to her, with their status.", () => soft(t, main(p).getByText(/email approved/).first()));
      await t.step("Commitments and tasks you promised her — like 'Send 3 options'.", () => soft(t, main(p).getByText("Send 3 options").first()));
      await t.step("Relationship level: CRE OS suggests one from your history — 'Use suggestion' or pick your own.", async () => {
        const b = main(p).getByRole("button", { name: "Use suggestion" });
        if (await b.count()) await t.point(b); else await soft(t, main(p).locator("select[name=level]"));
      });
      await t.step("Memories: what the assistant remembers about her, which you can review.", () => soft(t, main(p).getByRole("link", { name: "Open memories" })));
      await t.step("Contact details: add only what she shared — never guessed.", () => soft(t, main(p).getByPlaceholder("Only what the person shared. Never guess.")));
      await t.step("Archive needs a reason and goes to Review — nothing is deleted outright.", () => soft(t, main(p).getByRole("button", { name: "Request archive" })));
      await t.outro("read a person's role, history, relationships, interactions and next steps.", "explore Market & reports.");
    },
  },
  {
    slug: "market-reports-v2", category: CAT, title: "Market & reports: a tour of all five tabs",
    learn: "Five tabs: market figures with their source, network moves and intro paths, the legal desk, content planning and pipeline reports.", tryRoute: "/market",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Market & reports", "Market figures, your network, legal documents, content and reports — five tabs in one place.",
        ["Market", "Network", "Legal", "Content", "Reports"]);
      await t.step("Open Market & reports from the More menu.", () => side(t, "Market & reports"));
      await t.step("Market: validated releases only. 'Re-run checks' re-validates the figures.", () => soft(t, main(p).getByRole("button", { name: "Re-run checks" })));
      await t.step("Descriptive only — not a forecast. Stock is never summed and no vacancy is guessed.", () => soft(t, main(p).getByText(/Descriptive only/)));
      await t.step("Each series names its measure, area and unit — here absorption in msf, per year.", () => soft(t, main(p).getByText(/absorption/).first()));
      await t.step("Below each chart: period, unit and source with its release date. Missing years stay unknown.", async () => { await soft(t, main(p).getByText("Source").first()); await t.scroll(400); });
      await t.step("Network: job moves, who knows whom, introduction paths and deal gaps.", () => t.moveAndClick(pageTab(p, "Network")));
      await t.step("Recent job moves are unverified until you confirm them.", () => soft(t, main(p).getByText("Recent job moves")));
      await t.step("Legal: for LOIs, term sheets and leases — for the tenant's lawyers, not legal advice.", () => t.moveAndClick(pageTab(p, "Legal")));
      await t.step("Upload a PDF or Word file; add a later version with the same family key to get a redline.", () => soft(t, main(p).getByText(/Upload a document/).first()));
      await t.step("Link it to a lease so Leases (and its Radar tab) can use its clauses (notice dates, break options).", () => soft(t, main(p).getByText(/Related to/).first()));
      await t.step("Content: LinkedIn posts and market notes in your voice. You publish them yourself.", () => t.moveAndClick(pageTab(p, "Content")));
      await t.step("'Plan this week' suggests two post ideas and a market-note slot (it also runs every Monday).", () => soft(t, main(p).getByRole("button", { name: "Plan this week" })));
      await t.step("Drafts are checked against the evidence and confidentiality rules before they can be approved.", async () => { await t.scroll(500); });
      await t.step("Reports: approaches, discussions and deals by month — descriptive, not predictions.", () => t.moveAndClick(pageTab(p, "Reports")));
      await t.step("Targets are your planning assumptions. Drafts and follow-ups never count as approaches.", () => soft(t, main(p).getByText(/Drafts and follow-ups are never approaches/)));
      await t.step("Cohort funnel: what happened to the approaches started each month.", () => soft(t, main(p).getByText(/Cohort funnel/)));
      await t.step("Stage conversion: how many deals are at each stage, from research to collected.", () => soft(t, main(p).getByText("Stage conversion").first()));
      await t.step("Time to stage: how many days deals take to reach each step.", () => soft(t, main(p).getByText(/Time to stage/)));
      await t.outro("toured the Market, Network, Legal, Content and Reports tabs.", "go back to Signals and review what's new.");
    },
  },
];

module.exports = { FLOWS, prepare };
