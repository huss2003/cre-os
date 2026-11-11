// Tutorial videos — group "memory": Module 13 Intelligence Layer (company / contact / property memory, requirement history,
// decision-maker changes, recurring preferences, recommendations, timeline, memory quality, meeting memory, Ask AI).
// Captions describe only what is on screen (practice / mock AI: summaries are rule-based).
// Demo data: setup-memory.ts (run in prepare; demo workspace only, synthetic: Nimbus Ledger Systems, Kavita Menon, Orchid Fintech,
// Skyline Business Park – Tower 2). Videos 5, 7 and 9 acknowledge / complete items; prepare() resets them for the next run.
const path = require("path");
const { execFileSync } = require("child_process");
const { sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const WS = "de000000-0000-4000-8000-000000000001";
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", q], { stdio: "pipe" }).toString().trim();
const setup = () => execFileSync("npx", ["tsx", "--require", "./scripts/assistant-evals.preload.cjs", "--env-file=.env.local",
  "scripts/tutorial-videos/setup-memory.ts"], { cwd: ROOT, stdio: "pipe", timeout: 300000 });

// Deterministic demo ids (did("tutorial:memory:<kind>", key) in setup-memory.ts).
const ID = {
  nimbus: "60adda3b-7c21-5d2e-94d0-8614f8ba95bd", kavita: "0044cbee-a010-5e61-b7ed-134bc8232c44", req: "d69d1dd0-2752-5cad-8573-71d6f2a18050",
  skyline: "f14f83c2-5639-5c8d-95c9-8f90ee9e2795",
};
const meetingId = () => sql(`select p.id from mudar.meeting_prep p join mudar.meeting_visit v on v.id=p.meeting_visit_id where p.workspace_id='${WS}' and v.title='Nimbus Ledger — Kharadi options review (demo)' and p.archived_at is null order by p.created_at desc limit 1`);

const CAT = "Signals, scores & contacts"; // closest existing topic for "Intelligence & memory"
const nav = (p) => p.getByRole("navigation", { name: "Main" }).first();
const main = (p) => p.locator("main");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function start(t) {
  t.page.on("dialog", (d) => d.accept().catch(() => {}));
  await t.page.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
  await t.goto("/today");
}
/** Click a sidebar link, opening the folded "More" group first when needed. */
async function side(t, name) {
  const p = t.page;
  const link = nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
  if (!(await link.first().isVisible().catch(() => false))) { await t.moveAndClick(nav(p).getByRole("button", { name: /More/ })); await sleep(400); }
  await t.moveAndClick(link);
}
/** Point at something if it is on screen; otherwise scroll on (optional details never fail a video). */
async function soft(t, loc) {
  try { await loc.first().waitFor({ state: "visible", timeout: 5000 }); await t.point(loc); } catch { await t.scroll(300); }
}
/** Open a record from its list page (sidebar), falling back to its URL when the list is paged. */
async function openRecord(t, sidebar, name, href) {
  await side(t, sidebar);
  const link = main(t.page).getByRole("link", { name: new RegExp(esc(name)) }).first();
  if (await link.isVisible().catch(() => false)) await t.moveAndClick(link); else await t.goto(href);
}
/** The collapsible "Intelligence · …" panel on a record page. */
const panel = (p) => main(p).locator("details").filter({ has: p.locator("summary", { hasText: /^Intelligence ·/ }) }).first();
async function openPanel(t) {
  const d = panel(t.page);
  if (await d.evaluate((el) => el.open).catch(() => false)) await t.point(d.locator("summary").first()); else await t.moveAndClick(d.locator("summary").first());
  await sleep(500);
}
/** A section inside the panel; opened if folded. */
const sec = (p, title) => panel(p).locator("details").filter({ has: p.locator("summary > span:first-child", { hasText: new RegExp(`^${esc(title)}$`, "i") }) }).first();
async function openSec(t, title) {
  const d = sec(t.page, title);
  await d.waitFor({ state: "attached", timeout: 15000 });
  if (await d.evaluate((el) => el.open).catch(() => false)) await t.point(d.locator("summary").first()); else await t.moveAndClick(d.locator("summary").first());
  await sleep(400);
  return d;
}
const tabLink = (p, name) => p.getByRole("link", { name, exact: true }).first();

function prepare() { setup(); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. company memory
  {
    slug: "memory-company", category: CAT, title: "Company memory: everything about an account in one place",
    learn: "Open a company and expand Intelligence: a labelled summary, important changes, recommendations, live and past requirements, decision-makers, deals, occupancy, conversations, open promises, objections and unanswered questions — each with its source.",
    tryRoute: "/companies",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Company memory", "Everything CRE OS knows about one account — with where each fact came from.");
      await t.step("Open Companies in the sidebar and choose Nimbus Ledger Systems, a demo client.", () => openRecord(t, "Companies", "Nimbus Ledger Systems (demo)", `/companies/${ID.nimbus}`));
      await t.step("Near the top is the Intelligence panel. The summary says: one live requirement, one deal, two open promises.", () => t.point(panel(p).locator("summary").first()));
      await t.step("Click it to open the account's memory.", () => openPanel(t));
      await t.step("First, what is NOT known: industry and current offices. Unknown stays unknown — nothing is guessed.", () => soft(t, panel(p).getByText(/^Unknown:/)));
      await t.step("The summary is built only from the records below. Here AI is off, so it is marked 'rule-based'. Check sources before relying on it.", () => t.point(panel(p).getByText(/^AI summary/i).first()));
      await t.step("Important changes: seven differences found in this account's records. Open the list.", () => openSec(t, "Important changes"));
      await t.step("Each change shows the old value crossed out, the new value, the date, how sure we are, the source and how many deals it affects.", () => t.point(sec(p, "Important changes").locator("li").first()));
      await t.step("Recommendations: suggested next steps with the reason and sources. Nothing is done for you.", () => openSec(t, "Recommendations"));
      await t.step("For example: the requirement area changed by 50%, so refresh the shortlist and comparison.", () => soft(t, sec(p, "Recommendations").locator("li").filter({ hasText: /area changed/i })));
      await t.step("Overview and current requirements: the live brief and whether the client confirmed it.", async () => { await openSec(t, "Current requirements"); });
      await t.step("Decision-makers and contacts: who decides now, and who has left the company — Rahul Bhide, the old CFO.", async () => { const d = await openSec(t, "Decision-makers & contacts"); await soft(t, d.getByText(/\(left\)/)); });
      await t.step("Deals: open and earlier deals stay with the company, even when a contact moves on.", () => openSec(t, "Deals"));
      await t.step("Occupancy and rent history: no leases are recorded, so occupancy is shown as unknown.", () => openSec(t, "Occupancy & rent history"));
      await t.step("Relationship history: every recorded conversation, newest first. 'Full timeline' opens them all with filters.", () => openSec(t, "Relationship history"));
      await t.step("Outstanding commitments: promises we made and when they were due. Red means overdue.", async () => { const d = await openSec(t, "Outstanding commitments"); await soft(t, d.getByText("overdue").first()); });
      await t.step("Objections the client raised — here, limited parking — with a link to the conversation.", () => openSec(t, "Objections raised"));
      await t.step("Recent developments (news and signals) and unresolved questions still to ask the client.", async () => { await openSec(t, "Recent developments"); await openSec(t, "Unresolved questions"); });
      await t.step("Every line links to its source, so you can always check where a fact came from.", () => soft(t, panel(p).locator("a.underline").first()));
      await t.outro("opened a company's memory: changes, recommendations, people, deals, promises and open questions.", "see what CRE OS remembers about a contact.");
    },
  },
  // ------------------------------------------------------------------ 2. contact memory
  {
    slug: "memory-contact", category: CAT, title: "Contact memory: employer changes and relationship strength",
    learn: "A contact's Intelligence panel keeps current and previous employers (the old job is history, its deals stay with the old company), decision roles, a relationship strength score with the reasons behind it, conversations, preferences and promises.",
    tryRoute: "/people",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Contact memory", "Who this person works for now, where they were before, and how strong your relationship really is.");
      await t.step("Open People in the sidebar and choose Kavita Menon.", () => openRecord(t, "People", "Kavita Menon", `/people/${ID.kavita}`));
      await t.step("The panel header already shows the relationship level: developing, 41 out of 100.", () => t.point(panel(p).locator("summary").first()));
      await t.step("Open the Intelligence panel.", () => openPanel(t));
      await t.step("The summary: she is now a Director at Nimbus Ledger, and was previously at Orchid Fintech.", () => t.point(panel(p).getByText(/^AI summary/i).first()));
      await t.step("Important changes: CRE OS detected that she changed employer, with the date and source.", () => openSec(t, "Important changes"));
      await t.step("Recommendation: the relationship moves with the person, but Orchid's deal stays with Orchid — find a new contact there.", async () => { const d = await openSec(t, "Recommendations"); await soft(t, d.locator("li").filter({ hasText: /changed employer/ })); });
      await t.step("Current employer, title and seniority. 'Reported' means someone told us — not yet verified.", () => openSec(t, "Current employer"));
      await t.step("Previous employers are kept as history, marked 'Past'. Nothing is deleted when someone moves.", () => openSec(t, "Previous employers & designations"));
      await t.step("Decision-making role: approver on the Nimbus requirement; her old sponsor role at Orchid is marked Past.", () => openSec(t, "Decision-making role"));
      await t.step("Relationship strength is worked out from recorded evidence only — every factor and its points are listed.", () => openSec(t, "Relationship strength"));
      await t.step("How often you talk counts for little. Trust signals carry the weight: replies, sharing information, introductions, promises kept.", () => soft(t, sec(p, "Relationship strength").getByText(/Counts for little/)));
      await t.step("'No evidence of' lists what would make the relationship stronger.", () => soft(t, sec(p, "Relationship strength").getByText(/^No evidence of/)));
      await t.step("Interaction timeline: every conversation, including the 2024 meeting from when she was at Orchid.", () => openSec(t, "Interaction timeline"));
      await t.step("Known preferences, open commitments and objections she raised.", async () => { await openSec(t, "Known preferences"); await openSec(t, "Commitments"); });
      await t.step("Deals: Nimbus's deal, and Orchid's deal shown as 'stays with Orchid Fintech' — it was not moved with her.", async () => { const d = await openSec(t, "Deals"); await soft(t, d.getByText(/stays with/)); });
      await t.outro("read a contact's employer history and the evidence behind relationship strength.", "see what CRE OS remembers about a building.");
    },
  },
  // ------------------------------------------------------------------ 3. property memory
  {
    slug: "memory-property", category: CAT, title: "Property memory: past quotes, rejections and reasons",
    learn: "A building's Intelligence panel lists old quotations (always history, never current pricing), availability seen over time, rent/CAM changes, which clients looked at it and every rejection with its reason.",
    tryRoute: "/buildings",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Property memory", "Old quotes, which clients saw a building, and why they said no.");
      await t.step("Open Buildings in the sidebar and choose Skyline Business Park – Tower 2.", () => openRecord(t, "Buildings", "Skyline Business Park – Tower 2 (demo)", `/buildings/${ID.skyline}`));
      await t.step("The Intelligence panel shows one quote and one client option on record. Open it.", () => openPanel(t));
      await t.step("Unknown: developer, landlord and property manager are not recorded, so they are not guessed.", () => soft(t, panel(p).getByText(/^Unknown:/)));
      await t.step("The summary says plainly: the latest terms are a historical quote, not current pricing.", () => t.point(panel(p).getByText(/^AI summary/i).first()));
      await t.step("Recommendations: the quote from February is out of date — ask the landlord for refreshed terms.", async () => { const d = await openSec(t, "Recommendations"); await soft(t, d.locator("li").filter({ hasText: /Skyline.*quote/ })); });
      await t.step("Another recommendation: two buildings were rejected because of parking, so filter future options on parking.", () => soft(t, sec(p, "Recommendations").locator("li").filter({ hasText: /rejected because of parking/ })));
      await t.step("Latest known commercial terms: rent 78, CAM unknown, with the date it was quoted.", () => openSec(t, "Latest known commercial terms"));
      await t.step("Historical quotations: every version with its date and validity. Old quotes are history, not today's price.", () => openSec(t, "Historical quotations"));
      await t.step("Availability observations and rent / CAM changes, as they were seen over time.", async () => { await openSec(t, "Availability observations"); await openSec(t, "Rent / CAM changes"); });
      await t.step("Client interest: which requirements this building was proposed for, and the result.", () => openSec(t, "Client interest & related requirements"));
      await t.step("Rejections and reasons: 'client said no' is the client's own decision, from the site-visit feedback.", async () => { const d = await openSec(t, "Rejections & reasons"); await soft(t, d.getByText("client said no").first()); });
      await t.step("'did not fit' means our matching ruled it out — it is not a client decision.", () => soft(t, sec(p, "Rejections & reasons").getByText("did not fit").first()));
      await t.step("The reason is kept: not enough parking for the team. Shortlists for this client will warn about it.", () => soft(t, sec(p, "Rejections & reasons").getByText(/parking/i).first()));
      await t.outro("read a building's old quotes and the reasons clients rejected it.", "see how a requirement changed over time.");
    },
  },
  // ------------------------------------------------------------------ 4. requirement history
  {
    slug: "memory-requirement-history", category: CAT, title: "Requirement history: what changed and why",
    learn: "Every requirement version is kept. The requirement's Intelligence panel shows the current brief with how sure we are of each field, and What changed: old → new value, when, which version and the reason. The original is never overwritten.",
    tryRoute: "/requirements",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Requirement history", "10,000 sq ft in Hinjewadi by December became 15,000 sq ft in Kharadi by March. See every step.");
      await t.step("Open Requirements in the sidebar and choose the Nimbus Ledger Pune office.", () => openRecord(t, "Requirements", "Nimbus Ledger — Pune office (demo)", `/requirements/${ID.req}`));
      await t.step("The Intelligence panel says this requirement has 4 changes. Open it.", () => openPanel(t));
      await t.step("Current requirement: each field with how sure we are — confirmed, our estimate or unknown.", () => openSec(t, "Current requirement"));
      await t.step("Unknown fields, like seats and decision date, stay 'Unknown' until the client tells you.", () => soft(t, sec(p, "Current requirement").getByText("Unknown").first()));
      await t.step("What changed: every difference between versions, newest first.", () => openSec(t, "What changed"));
      await t.step("Area: 10,000 → 15,000 sq ft. The old value is crossed out but kept.", () => soft(t, sec(p, "What changed").locator("li").filter({ hasText: /Area/ })));
      await t.step("Move-in date: December 2026 → March 2027.", () => soft(t, sec(p, "What changed").locator("li").filter({ hasText: /possession/i })));
      await t.step("Budget and preferred locations changed too (Hinjewadi → Kharadi).", () => soft(t, sec(p, "What changed").locator("li").filter({ hasText: /Budget/ })));
      await t.step("Each line says which version (v1→v2) and why: a call with Kavita — headcount grew after funding.", () => soft(t, sec(p, "What changed").getByText(/v1→v2/).first()));
      await t.step("Recommendations: refresh the shortlist and comparison, because they were built on the old brief.", () => openSec(t, "Recommendations"));
      await t.step("Previous property options and rejection reasons stay with the requirement.", async () => { await openSec(t, "Previous property options"); await openSec(t, "Rejection reasons"); });
      await t.step("Open the full timeline for this requirement.", () => t.moveAndClick(panel(p).getByRole("link", { name: "Full timeline" })));
      await t.step("The timeline shows the requirement change as one event with all differences and the version it came from.", () => soft(t, main(p).locator("li").filter({ hasText: /Requirement changed/ })));
      await t.step("An old value counts as obsolete only when the client confirmed the new one; otherwise it is 'superseded, not confirmed yet'.", () => t.point(main(p).locator("h1").first()));
      await t.outro("saw how a requirement changed, version by version, and why.", "see what a decision-maker change affects.");
    },
  },
  // ------------------------------------------------------------------ 5. decision-maker change
  {
    slug: "memory-decision-maker", category: CAT, title: "Decision-maker changed: what it affects",
    learn: "When the approver or sponsor on a requirement leaves or is replaced, CRE OS records the change, flags the affected deals for review and recommends updating the buying group — without assuming the new person shares the old one's views or authority.",
    tryRoute: "/intelligence/changes",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Decision-maker changed", "Rahul (CFO) left Nimbus Ledger. Kavita is the new approver. What does that change?");
      await t.step("Open More in the sidebar, then Intelligence.", () => side(t, "Intelligence"));
      await t.step("Open the Changes tab.", () => t.moveAndClick(tabLink(p, "Changes")));
      await t.step("Filter by type of change: choose 'Decision-maker changed'.", async () => { const s = main(p).locator("select[name=kind]"); await t.point(s); await s.selectOption("decision_maker_change"); });
      await t.step("Press Filter.", () => t.moveAndClick(main(p).getByRole("button", { name: "Filter" })));
      const row = main(p).locator("li").filter({ hasText: /Decision-maker changed/ }).first();
      await t.step("Approver: Rahul Bhide → Kavita Menon. The old name is crossed out but kept.", () => t.point(row));
      await t.step("Impact: the open Nimbus deal is affected and has been flagged for review.", () => soft(t, row.getByText(/Impact/)));
      await t.step("Memory quality shows the same change with a caveat. Open the Quality tab.", () => t.moveAndClick(tabLink(p, "Quality")));
      const q = main(p).locator("li").filter({ hasText: /^Decision-maker changed/ }).first();
      await t.step("The caveat: the new person's preferences and commercial authority are NOT copied from the old one — confirm them.", async () => { await q.scrollIntoViewIfNeeded(); await soft(t, q.getByText(/not copied|NOT assumed|not assumed/i)); });
      await t.step("It also says which modules were told: deals, comparisons and scoring re-check the deal.", () => soft(t, q.getByText(/notifies/)));
      await t.step("Recommendations: update the buying group and confirm Kavita's priorities and authority.", async () => { await t.moveAndClick(tabLink(p, "Recommendations")); await soft(t, main(p).locator("li").filter({ hasText: /Decision-maker changed/ })); });
      await t.step("On the requirement, Decision-makers now lists Kavita as approver.", async () => { await t.goto(`/requirements/${ID.req}`); await openPanel(t); await openSec(t, "Decision-makers"); });
      await t.step("On the company, Rahul is still listed — marked 'left' — so the history is not lost.", async () => { await t.goto(`/companies/${ID.nimbus}`); await openPanel(t); const d = await openSec(t, "Decision-makers & contacts"); await soft(t, d.getByText(/\(left\)/)); });
      await t.step("Back in Changes, Acknowledge the change once you have dealt with it. It stays in the history.", async () => {
        await t.goto("/intelligence/changes?kind=decision_maker_change");
        const r = main(p).locator("li").filter({ hasText: /Decision-maker changed/ }).first();
        await t.moveAndClick(r.getByRole("button", { name: "Acknowledge" })); await sleep(1500);
      });
      await t.outro("found a decision-maker change, its impact and the recommended next step.", "tell recurring preferences from confirmed requirements.");
    },
  },
  // ------------------------------------------------------------------ 6. recurring preferences
  {
    slug: "memory-preferences", category: CAT, title: "Recurring preferences vs confirmed requirements",
    learn: "If a client mentions something in several notes (e.g. \"Grade A, immediate occupancy\"), CRE OS recognises it as a recurring preference — counted once per independent source — but never turns it into a confirmed requirement. Only what the client confirms goes into the requirement.",
    tryRoute: "/intelligence/timeline",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Recurring preferences vs confirmed requirements", "Said three times is a strong preference — but still not a confirmed requirement.");
      await t.step("Open Nimbus Ledger Systems from Companies.", () => openRecord(t, "Companies", "Nimbus Ledger Systems (demo)", `/companies/${ID.nimbus}`));
      await t.step("Open the Intelligence panel, then Relationship history.", async () => { await openPanel(t); await openSec(t, "Relationship history"); });
      await t.step("Open the full timeline to read the notes.", () => t.moveAndClick(sec(p, "Relationship history").getByRole("link", { name: "Full timeline" })));
      await t.step("Show only conversations: choose Event type 'Conversation'.", async () => { const s = main(p).locator("select[name=type]"); await t.point(s); await s.selectOption("interaction"); });
      await t.step("Apply.", () => t.moveAndClick(main(p).getByRole("button", { name: "Apply" })));
      const conv = (re) => main(p).locator("ol > li").filter({ hasText: re }).first();
      await t.step("July: 'They prefer a Grade A building with immediate occupancy.'", () => soft(t, conv(/Intro with Kavita/)));
      await t.step("September: the same again after the site visits.", () => soft(t, conv(/Hinjewadi site visits/)));
      await t.step("October: and again on the requirement call. Three separate notes, three sources.", () => soft(t, conv(/Requirement update call/)));
      await t.step("Now ask AI about the requirement. Open Ask AI.", () => t.moveAndClick(nav(p).getByRole("link", { name: /^Ask AI/ })));
      await t.step("Ask: has the Nimbus Ledger requirement changed?", async () => {
        const b = main(p).getByRole("button", { name: "New", exact: true }).first(); if (await b.isVisible().catch(() => false)) await b.click();
        await t.type(main(p).getByPlaceholder(/Ask about your accounts/), "Has the Nimbus Ledger requirement changed?", 30);
        await t.moveAndClick(main(p).getByRole("button", { name: "Ask", exact: true }));
        await main(p).getByRole("button", { name: /Worked through/ }).last().waitFor({ timeout: 120000 }); await sleep(1500);
      });
      await t.step("Open 'Worked through' to read the full answer from the records.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: /Worked through/ }).last()); await sleep(600); });
      await t.step("At the end: 'Recurring preferences (not confirmed requirements): Grade A, immediate occupancy.'", () => soft(t, main(p).getByText(/Recurring preferences/).last()));
      await t.step("A note captured twice counts once — only independent notes make it recurring.", () => soft(t, main(p).getByText(/Recurring preferences/).last()));
      await t.step("Now the requirement itself. Open it from Requirements.", () => openRecord(t, "Requirements", "Nimbus Ledger — Pune office (demo)", `/requirements/${ID.req}`));
      await t.step("Current requirement holds only what the client confirmed: area, location, move-in, budget.", async () => { await openPanel(t); await openSec(t, "Current requirement"); });
      await t.step("Building grade and fit-out are still Unknown — the preference was not copied in. Confirm it with the client first.", () => soft(t, sec(p, "Current requirement").getByText(/Fit-out standard/)));
      await t.outro("saw a preference repeated in three notes kept apart from the confirmed requirement.", "act on recommendations.");
    },
  },
  // ------------------------------------------------------------------ 7. recommendations
  {
    slug: "memory-recommendations", category: CAT, title: "Recommendations: what to do next and why",
    learn: "More → Intelligence → Recommendations lists suggested next actions from your records: what, why, the evidence, sources, confidence and the next step. Filter by type, confidence or record. Done / Dismiss for stored ones; rule-based ones clear by themselves when the record is updated. Nothing runs automatically.",
    tryRoute: "/intelligence/recommendations",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Recommendations", "What to do next — and exactly why CRE OS suggests it.");
      await t.step("Open More → Intelligence. The overview counts open recommendations, changes and quality items.", () => side(t, "Intelligence"));
      await t.step("Open the Recommendations tab.", () => t.moveAndClick(tabLink(p, "Recommendations")));
      const card = main(p).locator("ul > li").filter({ hasText: /Why:/ });
      await t.step("Each card: what to do, how confident CRE OS is, and why.", () => t.point(card.first()));
      await t.step("Below 'Why': the evidence it found, and the sources — click one to check it.", () => soft(t, card.first().getByText(/^Sources:/)));
      await t.step("'Next' is the suggested action. It is only a suggestion — nothing is sent or changed for you.", () => soft(t, card.first().getByText(/^Next:/)));
      await t.step("Filter by type, confidence or record. Choose High confidence.", async () => { const s = main(p).locator("select[name=confidence]"); await t.point(s); await s.selectOption("high"); });
      await t.step("Press Filter.", () => t.moveAndClick(main(p).getByRole("button", { name: "Filter" })));
      await t.step("High confidence: the requirement changed, and an old quotation should not be used as current pricing.", () => soft(t, card.filter({ hasText: /Quotation outdated/ })));
      await t.step("Rule-based ones say 'Clears by itself' — they go away once the record is updated.", () => soft(t, main(p).getByText(/Clears by itself/).first()));
      await t.step("Stored ones have Done and Dismiss. Mark the budget change Done once you've checked it with the client.", async () => {
        await t.goto("/intelligence/recommendations");
        const c = card.filter({ hasText: /budget changed/i }).first();
        await t.point(c);
        await t.moveAndClick(c.getByRole("button", { name: "Done" })); await sleep(1500);
      });
      await t.step("It disappears from the open list; the decision is kept in the history.", () => t.point(main(p).getByText(/\d+ open/).first()));
      await t.step("Recommendations also appear on each record and in Today → Recommended next actions.", async () => { await t.goto("/today"); await soft(t, main(p).getByText("Recommended next actions").first()); });
      await t.outro("filtered recommendations, read why each was made and marked one done.", "browse the intelligence timeline.");
    },
  },
  // ------------------------------------------------------------------ 8. timeline
  {
    slug: "memory-timeline", category: CAT, title: "Intelligence timeline with filters",
    learn: "More → Intelligence → Timeline lists conversations, meetings, job changes, requirement versions, deal stages, quotes, commitments, objections and rejections, newest first. Filter by company, contact, event type and dates; building, requirement and deal filters come from those pages.",
    tryRoute: "/intelligence/timeline",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Intelligence timeline", "What happened with an account, in order — and where each line came from.");
      await t.step("Open More → Intelligence, then the Timeline tab.", async () => { await side(t, "Intelligence"); await t.moveAndClick(tabLink(p, "Timeline")); });
      await t.step("Without filters it shows everything, newest first.", () => t.point(main(p).locator("ol > li").first()));
      await t.step("Each line: date, event type, how sure we are, what happened and a link to its source.", () => t.point(main(p).locator("ol > li").first()));
      await t.step("Pick a company: type 'Nimbus' and choose it from the list.", async () => {
        const box = main(p).getByRole("combobox").first();
        await t.type(box, "Nimbus", 60);
        await t.moveAndClick(p.getByRole("option", { name: /Nimbus Ledger Systems/ }).first());
      });
      await t.step("You can also pick a contact, an event type and a date range.", () => t.point(main(p).locator("select[name=type]")));
      await t.step("Apply.", () => t.moveAndClick(main(p).getByRole("button", { name: "Apply" })));
      await t.step("Now only Nimbus Ledger: tomorrow's meeting, the rejections, deal stage, job changes, requirement change and conversations.", () => t.point(main(p).locator("ol > li").first()));
      await t.step("The requirement change lists every difference and the version it came from.", () => soft(t, main(p).locator("ol > li").filter({ hasText: /Requirement changed/ })));
      await t.step("Narrow it down: Event type 'Commitment'.", async () => { const s = main(p).locator("select[name=type]"); await t.point(s); await s.selectOption("commitment"); await t.moveAndClick(main(p).getByRole("button", { name: "Apply" })); });
      await t.step("Promises we made, with due dates. Overdue ones say so.", () => soft(t, main(p).locator("ol > li").filter({ hasText: /Overdue/ })));
      await t.step("Filters appear as chips. Click ✕ on a chip to remove that filter.", () => soft(t, main(p).getByRole("link", { name: /Company: .*✕/ })));
      await t.step("Building, requirement and deal filters are set from their own pages with 'Full timeline'.", () => soft(t, main(p).getByText(/Full timeline/).first()));
      await t.step("'Clear all' removes every filter.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: "Clear all" })); });
      await t.outro("filtered the timeline by company and event type.", "check memory quality.");
    },
  },
  // ------------------------------------------------------------------ 9. memory quality
  {
    slug: "memory-quality", category: CAT, title: "Memory quality: stale, missing and conflicting information",
    learn: "More → Intelligence → Quality runs 11 checks with exact counts (outdated, missing, contradictory, assumptions, incomplete histories, unverified requirements, stale quotes, old employment, no source, duplicates, needs review). Scan for changes, Acknowledge / Dismiss changes and correct a status with a reason.",
    tryRoute: "/intelligence/quality",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Memory quality", "What CRE OS remembers that is out of date, missing, contradictory or unsourced.");
      await t.step("Open More → Intelligence, then the Quality tab.", async () => { await side(t, "Intelligence"); await t.moveAndClick(tabLink(p, "Quality")); });
      await t.step("Totals: items to look at, open changes, recommendations and the number of checks.", () => t.point(main(p).getByText("Items to look at").first()));
      const check = (label) => main(p).locator("li").filter({ has: p.getByText(label, { exact: true }) }).first();
      const openCheck = async (label) => { const c = check(label); await t.moveAndClick(c.locator("summary")); await sleep(500); return c; };
      await t.step("Eleven checks, each with an exact count. A check that fails to run says 'Unavailable' — never zero.", () => t.point(main(p).getByText("Quality checks").first()));
      await t.step("Outdated information: requirements not updated for six months and old availability. Click a check to open it.", () => openCheck("Outdated information"));
      await t.step("Missing information: live requirements with no area, budget or move-in date. Ask the client.", () => openCheck("Missing information"));
      await t.step("Contradictory information: two different values for the same thing, waiting for you to decide.", () => openCheck("Contradictory information"));
      await t.step("Stale property quotations: past their validity date — like the Skyline quote from February.", async () => { const c = await openCheck("Stale property quotations"); await soft(t, c.getByText(/Skyline/)); });
      await t.step("Also checked: unsupported assumptions, unverified requirements, old employment, records with no source and duplicates.", () => soft(t, check("Duplicate observations")));
      await t.step("Detected changes: each with old → new value, date, source and which deals were flagged.", async () => { await t.scroll(-200); await t.point(main(p).getByText("Detected changes").first()); });
      const ch = main(p).locator("li[id^='c-']").filter({ hasText: /Requirement timeline changed/ }).first();
      await t.step("Correct status: if a change is wrong, open 'Correct status', choose a status and give a reason. It is kept in the history.", async () => { await t.moveAndClick(ch.getByText(/Correct status/)); await sleep(400); });
      await t.step("Choose 'historical' and type why.", async () => {
        const s = ch.locator("select[name=status]"); await t.point(s); await s.selectOption("historical").catch(() => s.selectOption({ index: 1 }));
        await t.type(ch.locator("input[name=note]"), "Move-in confirmed by Kavita on the call", 25);
      });
      await t.step("Save.", async () => { await t.moveAndClick(ch.getByRole("button", { name: "Save" })); await sleep(1500); });
      const ch2 = main(p).locator("li[id^='c-']").filter({ hasText: /Requirement area changed/ }).first();
      await t.step("Acknowledge: you have seen and handled the change. Dismiss: it doesn't matter. Acknowledge the area change.", async () => { await t.moveAndClick(ch2.getByRole("button", { name: "Acknowledge" })); await sleep(1500); });
      await t.step("At the bottom, Recommended next actions, each with why, evidence, sources and next step.", async () => { await t.scroll(2500); await soft(t, main(p).getByText("Recommended next actions").first()); });
      await t.step("Scan for changes re-checks your records now. It also runs by itself whenever records change.", async () => { await t.scroll(-6000); await t.moveAndClick(main(p).getByRole("button", { name: "Scan for changes" })); await sleep(3000); });
      await t.step("The result says how many changes were found. Nothing here edits a record or sends anything.", () => soft(t, main(p).getByText(/found|scan|Scanned/i).first()));
      await t.outro("read the quality checks, corrected a status and acknowledged a change.", "see what to know before a meeting.");
    },
  },
  // ------------------------------------------------------------------ 10. before a meeting
  {
    slug: "memory-before-meeting", category: CAT, title: "Before a meeting: what you should know",
    learn: "Open the meeting: the brief lists attendees with current titles (and where they worked before), previous discussions, promises on record, objections, the requirement, old quotes, open questions and 'From your records' — source-linked memory. Unknown means not recorded.",
    tryRoute: "/meetings",
    async run(t) {
      const p = t.page;
      await start(t);
      const mid = meetingId();
      await t.title("Before a meeting", "Tomorrow: Kharadi options review with Kavita and Sanjay. What should you know?");
      await t.step("Open Meetings in the sidebar and choose tomorrow's Nimbus Ledger meeting.", async () => {
        await side(t, "Meetings");
        const link = main(p).getByRole("link", { name: /Nimbus Ledger — Kharadi options review/ }).first();
        if (await link.isVisible().catch(() => false)) await t.moveAndClick(link); else await t.goto(`/meetings/${mid}`);
      });
      await t.step("The brief is ready. Meeting purpose: walk Kavita through the Kharadi shortlist.", () => soft(t, main(p).getByText("Why we're meeting").first()));
      await t.step("Attendees: Kavita's current title — and 'before: Head – Admin & Facilities at Orchid Fintech'.", async () => { await soft(t, main(p).getByText(/before: Head/).first()); });
      await t.step("Each attendee's decision role is shown as unknown until confirmed. Confirm it in the meeting.", () => soft(t, main(p).getByText(/decision role not yet known/).first()));
      await t.step("Opportunity: the current requirement — 15,000 sq ft, budget 95, move-in March 2027.", () => soft(t, main(p).getByText(/15000 sq ft/).first()));
      await t.step("Previous discussions: every conversation, including the 2024 Orchid meeting with Kavita.", () => soft(t, main(p).getByText(/Orchid — Baner lease renewal/).first()));
      await t.step("Commitments on record and objections they raised — parking at Skyline.", () => soft(t, main(p).getByText("OBJECTIONS THEY RAISED").or(main(p).getByText(/Objections they raised/i)).first()));
      const mem = main(p).locator("#memory, section").filter({ has: p.getByText("From your records", { exact: true }) }).first();
      await t.step("'From your records': source-linked memory. Unknown means nothing is recorded — not that it didn't happen.", () => soft(t, main(p).getByText("From your records", { exact: true }).first()));
      await t.step("Attendees with relationship level and how many past conversations. Sanjay: none yet.", () => soft(t, mem.getByText(/Attendees & current designation/)));
      await t.step("Pending commitments: two promises are overdue — deal with them before the meeting.", () => soft(t, mem.getByText(/Pending commitments/)));
      await t.step("Commercial discussions: the old Skyline quote, clearly marked historical.", () => soft(t, mem.getByText(/historical/).first()));
      await t.step("Pending questions to ask, and suggested discussion points.", () => soft(t, mem.getByText(/Pending questions/)));
      await t.step("Meeting strategy: opening, discovery, value, discussion, closing — and what to avoid.", () => soft(t, main(p).getByText(/Meeting strategy/).first()));
      await t.step("Questions to ask: 'Already known' shows answers we have, so you don't ask twice.", () => soft(t, main(p).getByText(/Already known/).first()));
      await t.outro("read the meeting brief and what CRE OS remembers about the people and the deal.", "ask AI about relationships and history.");
    },
  },
  // ------------------------------------------------------------------ 11. ask AI
  {
    slug: "memory-ask-ai", category: CAT, title: "Ask AI about relationships and history",
    learn: "Ask AI answers history questions from your records: how a requirement changed, who the decision-makers are, which buildings were rejected and why, what changed at an account. Every answer lists its sources and what is missing.",
    tryRoute: "/assistant",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Ask AI about relationships and history", "Plain questions, answers from your records — with sources.");
      const ask = async (q) => {
        await t.type(main(p).getByPlaceholder(/Ask about your accounts/), q, 28);
        const n = await main(p).getByRole("button", { name: /Worked through/ }).count();
        await t.moveAndClick(main(p).getByRole("button", { name: "Ask", exact: true }));
        await main(p).getByRole("button", { name: /Worked through/ }).nth(n).waitFor({ timeout: 120000 }); await sleep(1500);
      };
      await t.step("Open Ask AI from the sidebar and start a new conversation.", async () => {
        await t.moveAndClick(nav(p).getByRole("link", { name: /^Ask AI/ }));
        const b = main(p).getByRole("button", { name: "New", exact: true }).first(); if (await b.isVisible().catch(() => false)) await t.moveAndClick(b);
      });
      await t.step("Ask: has the Nimbus Ledger requirement changed?", () => ask("Has the Nimbus Ledger requirement changed?"));
      await t.step("The answer: changed once on 20 Oct — area, budget, location and move-in, with the source.", () => soft(t, main(p).getByText(/Requirement history/).last()));
      await t.step("Sources list each record used, its date and whether it is verified or reported.", () => soft(t, main(p).getByText("Sources", { exact: true }).last()));
      await t.step("Ask: who are the decision-makers at Nimbus Ledger?", () => ask("Who are the decision-makers at Nimbus Ledger?"));
      await t.step("Kavita is the decision-maker (approver); Sanjay's role is unknown. Contact details are unverified.", () => soft(t, main(p).getByText(/Decision-makers and influencers/).last()));
      await t.step("Missing: nobody on record for finance, procurement or legal — people you may still need to meet.", () => soft(t, main(p).getByText(/Missing category: Finance/).last()));
      await t.step("Ask: which properties did Nimbus Ledger reject and why?", () => ask("Which properties did Nimbus Ledger reject and why?"));
      await t.step("Rejected options: the buildings, the reason and whether it was the client's decision or our matching.", () => soft(t, main(p).getByText(/Rejected options/).last()));
      await t.step("Ask: what changed at Nimbus Ledger?", () => ask("What changed at Nimbus Ledger?"));
      await t.step("The detected changes with recommended next steps and their sources.", async () => {
        const h = main(p).getByText("What changed", { exact: true }).last();
        await h.scrollIntoViewIfNeeded().catch(() => {}); await sleep(400); await soft(t, h);
      });
      await t.step("'Worked through' shows which records were read. The assistant never sends anything and never changes records without approval.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: /Worked through/ }).last()); await sleep(600); });
      await t.outro("asked AI about a requirement's history, decision-makers, rejections and changes.", "open a company's memory to check the details.");
    },
  },
];

module.exports = { FLOWS, prepare };
