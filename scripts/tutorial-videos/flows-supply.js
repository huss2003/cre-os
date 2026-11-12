// Tutorial videos — group "supply": Module 14 Property Supply & Matching (/buildings/supply: Inventory, Operators, Match).
// Demo data: setup-supply.ts (run in prepare): Harbour Point (demo) floors 4/5/6, Riverstone Tech Annex (demo) floors 2/3,
// operator centres NestWorks / LoopDesk (demo), requirement "Lumen Harbour Tech — 18–19.5k SF (tutorial)" with a stored shortlist.
// Matching and statuses are code; nothing uses AI. Captions describe only what is on screen.
const { WS, sql, runSetup, main, field, start, side, soft, card, choose, fill, submit, sleep, esc } = require("./new-modules-common");

const CAT = "Records & data";
const REQ = "Lumen Harbour Tech — 18–19.5k SF (tutorial)";
const reqId = () => sql(`select id from mudar.requirement where workspace_id='${WS}' and title='${REQ}' and archived_at is null order by created_at desc limit 1`);
const supplyTab = async (t, name) => t.moveAndClick(main(t.page).getByRole("tablist", { name: "Supply view" }).getByRole("link", { name, exact: true }));
// The Buildings / Supply section tabs sit in the top bar (outside <main>); the sidebar has no "Supply" link.
async function openSupply(t) { await side(t, "Buildings"); await t.moveAndClick(t.page.getByRole("link", { name: "Supply", exact: true }).first()); }
const row = (p, text) => main(p).locator("tr").filter({ hasText: text }).first();
/** A match card by its title text. */
const matchCard = (p, text) => main(p).getByRole("heading", { name: new RegExp(esc(text)) }).first().locator("xpath=ancestor::section[1]");
async function openMatch(t) {
  const p = t.page;
  await supplyTab(t, "Match");
  const link = main(p).getByRole("link", { name: REQ }).first();
  if (await link.isVisible().catch(() => false)) await t.moveAndClick(link); else await t.goto(`/buildings/supply?tab=match&requirement=${reqId()}`);
}

function prepare() { console.log(" setup-supply:", runSetup("setup-supply.ts")); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. inventory + statuses
  {
    slug: "supply-inventory", category: CAT, title: "Supply inventory and availability statuses",
    learn: "Buildings → Supply shows every space's current availability: one of nine statuses, area, rent and CAM, the source and last verification date, and a confidence level. Lease expiry and future supply are never shown as vacancy.",
    tryRoute: "/buildings/supply",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Supply inventory", "What is really available now, how sure we are, and where it came from.");
      await t.step("Open Buildings from the sidebar, then the Supply tab.", () => openSupply(t));
      await t.step("The rule at the top: lease expiry and future supply are never shown as vacancy.", () => soft(t, main(p).getByText(/never shown as vacancy/)));
      await t.step("Three views: Inventory (this one), Operators for managed offices and coworking, and Match for a client requirement.", () => t.point(main(p).getByRole("tablist", { name: "Supply view" })));
      await t.step("The yellow line counts stale observations — reconfirm them before presenting to a client.", () => soft(t, main(p).getByText(/availability observations are stale/)));
      await t.step("Each row: the building, floor and unit, category and contiguous block.", async () => { await row(p, "Harbour Point (demo) · Floor 4").evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {}); await sleep(400); await soft(t, row(p, "Harbour Point (demo) · Floor 4")); });
      await t.step("Harbour Point floor 4 is Immediately available, verified this week from a landlord email: high confidence.", () => soft(t, row(p, "Harbour Point (demo) · Floor 4").getByText("high")));
      await t.step("Floor 5 is Future availability from April 2027 — it is not counted as available today.", () => soft(t, row(p, "Harbour Point (demo) · Floor 5")));
      await t.step("Floor 6 is Occupied: confidence none, so it is never offered.", () => soft(t, row(p, "Harbour Point (demo) · Floor 6")));
      await t.step("Other statuses include under offer, leased, withdrawn and unconfirmed. Unknown CAM shows as unknown — never zero.", () => soft(t, main(p).getByText("Under offer").first()));
      await t.step("Source and verified: where the information came from and when it was last checked. 'Never verified' rows have low confidence.", () => soft(t, main(p).getByText("never verified").first()));
      await t.step("Click a building to open it and see all its spaces.", () => t.moveAndClick(row(p, "Harbour Point (demo) · Floor 4").getByRole("link", { name: "Harbour Point (demo)" })));
      await t.outro("read the supply inventory: statuses, sources, verification and confidence.", "look at operator centres.");
    },
  },

  // ------------------------------------------------------------------ 2. operators
  {
    slug: "supply-operators", category: CAT, title: "Managed office and coworking operators",
    learn: "The Operators view lists managed-office and coworking centres: seats available out of capacity, private offices, price per seat, services, extra charges, brokerage and when it was verified. Add or update a centre with the form.",
    tryRoute: "/buildings/supply?tab=operators",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Operator centres", "Seats, prices, services and extra charges for managed offices and coworking.");
      await t.step("Open Buildings, then Supply.", () => openSupply(t));
      await t.step("Choose the Operators view.", () => supplyTab(t, "Operators"));
      await t.step("NestWorks Kharadi Hub, a managed office: 140 of 600 seats available, 12 private offices, ₹11,000–14,500 a seat.", () => soft(t, row(p, "NestWorks")));
      await t.step("Its services, and extra charges listed separately — car parks and meeting rooms beyond 10 hours.", () => soft(t, row(p, "NestWorks").getByText(/Car park/)));
      await t.step("Brokerage terms and the date it was verified.", () => soft(t, row(p, "NestWorks").getByText(/12-month term/)));
      await t.step("LoopDesk, a coworking centre: seats available is unknown and the top price is '?' — missing stays missing.", () => soft(t, row(p, "LoopDesk")));
      await t.step("Add centre: operator, centre name and type — managed office or coworking.", async () => {
        await fill(t, field(p, "operator_name"), "Skyhive (demo)"); await fill(t, field(p, "centre_name"), "Baner"); await choose(t, field(p, "category"), "Managed office");
      });
      await t.step("Capacity, seats available, private offices and the price range per seat.", async () => {
        await fill(t, field(p, "capacity_seats"), "300"); await fill(t, field(p, "seats_available"), "60"); await fill(t, field(p, "private_offices"), "6");
        await fill(t, field(p, "price_per_seat_min"), "9500"); await fill(t, field(p, "price_per_seat_max"), "12000");
      });
      await t.step("Services, amenities, brokerage, the source and when you verified it.", async () => {
        await fill(t, field(p, "services"), "housekeeping, reception"); await fill(t, field(p, "source_label"), "Operator call (demo)");
        await field(p, "last_verified_on").fill(new Date().toISOString().slice(0, 10)); await t.point(field(p, "last_verified_on"));
      });
      await t.step("Save centre. Seats available can never be more than capacity.", () => submit(t, main(p).getByRole("button", { name: "Save centre" })));
      await t.step("The new centre is in the list.", () => soft(t, row(p, "Skyhive")));
      await t.outro("compared operator centres and added one.", "match supply to a client requirement.");
    },
  },

  // ------------------------------------------------------------------ 3. matching with explanations
  {
    slug: "supply-matching", category: CAT, title: "Match supply to a requirement — with explanations",
    learn: "The Match view ranks every space against a requirement. Hard filters come first (status, area, budget, category); each option explains why, what it satisfies or fails, advantages, disadvantages, missing information, availability confidence and what needs verifying.",
    tryRoute: "/buildings/supply?tab=match",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Matching with explanations", "Why each space ranks where it does — failures are shown, never hidden behind a score.");
      await t.step("Open Buildings, then Supply, then the Match view.", async () => { await openSupply(t); await supplyTab(t, "Match"); });
      await t.step("Choose a requirement — Lumen Harbour Tech, 18,000 to 19,500 sf, up to ₹100 a sf.", () => openMatch(t));
      await t.step("#1 Harbour Point floor 4: eligible, availability confidence high, with its fit score and how complete the data is.", () => t.point(matchCard(p, "#1 ").getByRole("heading").first()));
      await t.step("The reason in one line: it meets all hard requirements.", () => soft(t, matchCard(p, "#1 ").locator("p").first()));
      await t.step("Satisfies, advantages, disadvantages and missing information — for example deposit and escalation not recorded.", () => soft(t, matchCard(p, "#1 ").getByText("Missing information")));
      await t.step("Harbour Point floor 5 is eligible but its disadvantage says: future availability from April 2027. Unknown CAM is not assumed to be zero.", () => soft(t, matchCard(p, "Harbour Point (demo) · Floor 5").getByText(/Future availability from/)));
      await t.step("Riverstone floor 2 needs verification: the availability is stale and the price is out of date.", () => soft(t, matchCard(p, "Riverstone Tech Annex (demo) · Floor 2")));
      await t.step("Riverstone floor 3 only has a lease ending — lease expiry is not vacancy, so it needs verification too.", () => soft(t, matchCard(p, "Riverstone Tech Annex (demo) · Floor 3")));
      await t.step("Lower down, ineligible spaces list exactly which hard filter they fail. They are ranked last, not hidden.", async () => { const c = main(p).getByRole("heading", { name: /Ineligible/ }).first(); await c.scrollIntoViewIfNeeded().catch(() => {}); await soft(t, c); });
      await t.step("The Requirement button opens the brief to change area, budget or location; the ranking updates.", () => soft(t, main(p).getByRole("link", { name: "Requirement", exact: true })));
      await t.outro("matched supply to a requirement and read each explanation.", "reconfirm options before presenting.");
    },
  },

  // ------------------------------------------------------------------ 4. reconfirmation
  {
    slug: "supply-reconfirmation", category: CAT, title: "Reconfirm before presenting or a site visit",
    learn: "Before a presentation or site visit, check the shortlist: options with stale availability, outdated pricing, expired quotes or missing technical details are listed and must be reconfirmed first.",
    tryRoute: "/buildings/supply?tab=match",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Reconfirmation", "Never show a client a space you have not rechecked.");
      await t.step("Open Buildings → Supply → Match and choose the Lumen Harbour Tech requirement.", async () => { await openSupply(t); await openMatch(t); });
      await t.step("The yellow line lists shortlisted properties that need reconfirmation, and why: stale availability, outdated pricing, missing technical details.", () => soft(t, main(p).getByText(/need reconfirmation/).first()));
      await t.step("Choose what you are preparing for: a client presentation or a site visit.", () => choose(t, field(p, "purpose"), "Site visit"));
      await t.step("Press Check ready to present.", () => submit(t, main(p).getByRole("button", { name: "Check ready to present" })));
      await t.step("The answer lists every option that is not ready and what to recheck. Nothing is presented until they are reconfirmed.", () => soft(t, main(p).getByText(/reconfirm|not ready|Reconfirm/).first()));
      await t.step("To reconfirm, call or email the landlord and update the availability with today's date and the source — the confidence goes up.", () => soft(t, matchCard(p, "Riverstone Tech Annex (demo) · Floor 2").getByText(/Verification required|stale/i).first()));
      await t.step("Old quotes stay in the history and are never used as current pricing.", () => soft(t, main(p).getByText(/outdated pricing/).first()));
      await t.outro("checked which options must be reconfirmed before a site visit.", "record client feedback on the shortlist.");
    },
  },

  // ------------------------------------------------------------------ 5. shortlist feedback
  {
    slug: "supply-feedback", category: CAT, title: "Shortlist feedback and rejection reasons",
    learn: "Record the client's feedback on each shortlisted option. A rejection needs a reason (price, area, location, timing, specification, landlord, parking, availability, other) and marks the option rejected; everything is kept in the shortlist history.",
    tryRoute: "/buildings/supply?tab=match",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Shortlist feedback", "What the client said about each option — and why they said no.");
      await t.step("Open Buildings → Supply → Match and choose the Lumen Harbour Tech requirement.", async () => { await openSupply(t); await openMatch(t); });
      await t.step("Each option on the stored shortlist has a feedback form and shows its status — proposed here.", () => soft(t, matchCard(p, "#1 ").getByRole("button", { name: /^Record/ })));
      await t.step("Client feedback on Harbour Point floor 4: liked the floor plate.", async () => {
        const c = matchCard(p, "#1 "); await choose(t, c.locator('[name="kind"]'), "Client feedback"); await fill(t, c.locator('[name="comment"]'), "Liked the floor plate and natural light");
        await submit(t, c.getByRole("button", { name: /^Record/ }));
      });
      await t.step("Now a rejection on Harbour Point floor 5. A reason is required.", async () => {
        const c = matchCard(p, "Harbour Point (demo) · Floor 5"); await choose(t, c.locator('[name="kind"]'), "Rejection"); await choose(t, c.locator('[name="reason_code"]'), "Timing");
        await fill(t, c.locator('[name="comment"]'), "April 2027 is too late for the move");
      });
      await t.step("Record. The option becomes rejected.", () => submit(t, matchCard(p, "Harbour Point (demo) · Floor 5").getByRole("button", { name: /^Record/ })));
      await t.step("Shortlist history at the bottom: each shortlist version with how many options were eligible, and every piece of feedback with its reason.", async () => {
        const h = main(p).getByRole("heading", { name: "Shortlist history" }); await h.scrollIntoViewIfNeeded().catch(() => {}); await soft(t, h);
      });
      await t.step("Rejections are remembered: the company's memory shows rejected buildings and why, so they are not offered again by mistake.", () => soft(t, main(p).getByText(/Rejected \(timing\)/).first()));
      await t.outro("recorded client feedback and a rejection with its reason.", "run a new shortlist after the requirement changes.");
    },
  },
];

module.exports = { FLOWS, prepare };
