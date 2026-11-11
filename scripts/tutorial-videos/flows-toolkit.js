// Deal toolkit tutorial videos (group "toolkit"). Record: node scripts/tutorial-videos/record.js --group toolkit
// Captions describe only what is on screen. Every number shown comes from the toolkit's fixed, tested calculators — not AI.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { BASE, sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
const CAT = "Deal toolkit";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REQ = "Zentrix Analytics — 25,000 sf in Kharadi";
const NEGO_TITLE = "Zentrix — Kharadi Tech Park negotiation";

const nav = (p) => p.getByRole("navigation", { name: "Main" });
const navLink = (p, name) => nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
const main = (p) => p.locator("main");
const field = (p, name) => main(p).locator(`[name="${name}"]`).first();
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", q], { encoding: "utf8" }).trim();
const esc = (s) => s.replace(/'/g, "''");

/** Open every <details> around an element so it can be seen and typed into. */
async function reveal(loc) {
  await loc.evaluate((e) => { let d = e.closest("details"); while (d) { d.open = true; d = d.parentElement && d.parentElement.closest("details"); } });
}
/** Fill fields by name without filming each keystroke (used for the less important inputs). */
async function fillQuiet(p, obj) {
  for (const [k, v] of Object.entries(obj)) {
    const l = field(p, k);
    await reveal(l);
    const tag = await l.evaluate((e) => `${e.tagName}:${e.type}`);
    if (tag.startsWith("SELECT")) await l.selectOption({ label: v });
    else if (tag.endsWith("checkbox")) await l.setChecked(!!v);
    else await l.fill(String(v));
  }
}
/** Type one field on camera (opens its section first). */
async function typeField(t, name, value) { const l = field(t.page, name); await reveal(l); await t.type(l, String(value), 30); }
/** Open the Deal toolkit from the sidebar, then a task card's button. */
async function openTool(t, cta) {
  const p = t.page;
  await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
  return cta;
}

/** Only film a step if its element exists (keeps flows robust when a page has no such section). */
async function maybe(t, loc, caption, click) {
  const l = loc.filter({ visible: true }).first();
  if (!(await l.count().catch(() => 0))) { await l.waitFor({ timeout: 3000 }).catch(() => {}); if (!(await l.count())) return; }
  await t.step(caption, () => (click ? t.moveAndClick(l) : t.point(l)));
}
/** The parts every calculator result page shares: status, method, versions, deck. */
async function resultTour(t, { deck = true, method = true, saved } = {}) {
  const p = t.page;
  await maybe(t, main(p).getByText("CALCULATED", { exact: true }), "'Calculated' marks a figure produced by the tested formula from your inputs — never typed in or guessed by AI.");
  await maybe(t, main(p).getByText(/^(Quoted|Estimated)$/), "Quoted = from a landlord or partner document; Estimated = your own assumption. The label follows the number everywhere.");
  if (method) await maybe(t, main(p).locator("summary", { hasText: "How we calculated this" }), "How we calculated this: the formula version and every step, so anyone can check the maths.", true);
  await maybe(t, main(p).getByText(/version \d|Version \d|· version/).first(), "Each save is a version. Change any input and recalculate — earlier versions are kept, never overwritten.");
  if (deck) await maybe(t, main(p).getByRole("button", { name: /Download deck/ }).or(main(p).getByRole("link", { name: /Download deck/ })), "Download deck makes an editable PowerPoint of these results for the client.", true);
  if (saved) await maybe(t, main(p).getByText(saved), "Everything you save is also listed here and on the Deal toolkit home under Recently updated.");
}
/** "How to read this page" panel at the top of each tool. */
async function howTo(t) {
  const p = t.page;
  await maybe(t, main(p).locator("summary", { hasText: "How to read this page" }), "How to read this page opens a short guide to every box and label on this screen.", true);
  await maybe(t, main(p).getByText(/Blank = unknown, 0 = none/), "Blank = unknown, 0 = none. A blank is listed as missing and never counted as zero.");
}
const dump = async (t, slug) => { if (process.env.TK_DUMP) fs.writeFileSync(`/tmp/tk/${slug}.txt`, await main(t.page).innerText()); };

/** Not filmed: a fresh negotiation with Offer 1, and one landlord offer on the Zentrix requirement. */
async function prepare(browser, statePath) {
  const reqId = sql(`select id from mudar.requirement where title='${esc(REQ)}' and archived_at is null limit 1`);
  if (!reqId) throw new Error("Zentrix requirement missing — run setup-demo.ts");
  const ws = sql(`select workspace_id from mudar.requirement where id='${reqId}'`);
  // Clear what earlier runs of these videos created (demo workspace only).
  sql(`update mudar.quote set archived_at=now() where workspace_id='${ws}' and requirement_id='${reqId}' and kind='landlord_offer' and archived_at is null`);
  sql(`update mudar.deal_analysis set archived_at=now() where workspace_id='${ws}' and kind='negotiation' and title='${esc(NEGO_TITLE)}' and archived_at is null`);
  const ctx = await browser.newContext({ storageState: statePath, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(60000);
  // Negotiation with the landlord's first offer.
  await p.goto(`${BASE}/toolkit/negotiation`, { waitUntil: "networkidle", timeout: 90000 });
  await fillQuiet(p, { title: NEGO_TITLE, discount: "10", o0_name: "Kharadi Tech Park", o0_area: "25000", o0_tenure: "60", o0_lc: "2027-03-01", o0_rf: "2",
    o0_rent: "98", o0_esc: "5", o0_escevery: "12", o0_cam: "18", o0_pslots: "0", o0_other_none: true, o0_dep: "10", o0_fitout: "0", o0_lockin: "36" });
  await Promise.all([p.waitForURL(/\/toolkit\/negotiation\/[0-9a-f-]{36}/), p.getByRole("button", { name: "Save Offer 1" }).click()]);
  // First landlord offer on the requirement (the video records the second one).
  await p.goto(`${BASE}/requirements/${reqId}`, { waitUntil: "networkidle", timeout: 90000 });
  const card = p.locator("details").filter({ has: p.locator("summary", { hasText: "Record a landlord offer" }) }).first();
  await card.locator("summary").click();
  const f = (n) => card.locator(`[name="${n}"]`);
  const vals = { name: "Riverside Towers, Floors 6–7", building_name: "Kharadi Riverside Towers (demo)", areaSf: "26000", rentPerSf: "92", escalationPct: "5",
    escalationEveryMonths: "12", termMonths: "60", lockInMonths: "36", rentFreeMonths: "3", securityDepositMonths: "8", fitoutAllowanceInr: "0", camPerSf: "16",
    carParks: "20", carParkRatePerSlot: "3500", seats: "250", leaseCommencement: "2027-04-01", validUntil: "2026-12-31", sourceDoc: "Riverside LOI.pdf" };
  for (const [k, v] of Object.entries(vals)) await f(k).fill(v);
  await f("areaBasis").selectOption("chargeable");
  await card.getByRole("button", { name: "Save offer" }).click();
  await p.waitForLoadState("networkidle").catch(() => {});
  await sleep(2000);
  await ctx.close();
}

const FLOWS = [
  {
    slug: "toolkit-overview", category: CAT, title: "The Deal toolkit: which tool answers which client question",
    learn: "Where each calculator lives and which client question it answers — all figures come from fixed, tested formulas.", tryRoute: "/toolkit",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("The Deal toolkit", "Which tool answers which client question.",
        ["Brief — what does the client need?", "Lease / occupancy — what will it really cost?", "Stay or move, lease or managed?", "Offers, negotiation, documents"]);
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Four stages: write the brief, run the numbers, check and approve, make the client document.", () => t.point(main(p).getByRole("heading", { name: "What do you want to do?" })));
      await t.step("'What exactly do you need?' — the requirement brief.", () => t.point(main(p).getByText("Write down what the client needs")));
      await t.step("'What will this lease really cost?' — lease economics, and cost per seat all-in.", () => t.point(main(p).getByText("Work out the true cost of a lease")));
      await t.step("'Should we stay or move?' and 'Lease or managed office?' — side-by-side comparisons.", () => t.point(main(p).getByText("Stay or move?")));
      await t.step("Landlord offers, negotiation rounds and fit-out quotes each have their own tool.", () => t.point(main(p).getByText("Compare landlord offers")));
      await t.step("Built-to-suit and investment returns sit under Specialist models.", () => t.point(main(p).getByText("Specialist models")));
      await t.step("Each card has one clear button; the counter shows how many you have saved with that tool.", () => t.point(main(p).getByText(/\d+ saved/).first()));
      await t.step("Fit-out & loan: budget the fit-out, then Financing works out the loan.", () => t.point(main(p).getByText("Fit-out & loan")));
      await t.step("Make a client document and Site-visit pack turn saved work into Word, PDF and decks.", () => t.point(main(p).getByText("Make a client document")));
      await t.step("Every number comes from fixed, tested formulas — not from AI — and keeps its inputs.", async () => { await t.scroll(500); });
      await t.step("Needs information lists saved work with missing inputs — blanks are never treated as zero.", () => t.point(main(p).getByRole("heading", { name: /Needs information/ })));
      await t.step("Requirements awaiting analysis: client searches with nothing worked out yet.", () => t.point(main(p).getByRole("heading", { name: /Requirements awaiting analysis/ })));
      await maybe(t, main(p).getByRole("heading", { name: "Recently updated" }), "Recently updated: your latest saved analyses with version and status — click one to open it.");
      await maybe(t, main(p).getByRole("alert", { name: "Quotes needing attention" }), "A red box warns when a landlord quote has expired or expires within 14 days.");
      await t.step("Start with a brief is the suggested first step for any new client search.", async () => { await t.scroll(-3000); await t.point(main(p).getByRole("link", { name: /Start with a brief/ })); });
      await t.outro("toured the Deal toolkit and saw which tool answers which question.", "build a requirement brief.");
    },
  },

  {
    slug: "requirement-brief", category: CAT, title: "Build a requirement brief and download it",
    learn: "See what is confirmed, estimated or missing for a client search, save a snapshot and download the brief deck.", tryRoute: "/toolkit/brief",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Build a requirement brief", "Everything the client needs on one page — each item marked confirmed, estimated or missing.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Open briefs.", () => t.moveAndClick(main(p).getByRole("link", { name: /Open briefs/ })));
      await t.step("Pick the client search — Zentrix, 25,000 sf in Kharadi.", () => t.moveAndClick(main(p).getByRole("link", { name: new RegExp(REQ) }).first()));
      await t.step("The score card: how many items are confirmed, estimated or still missing.", () => t.point(main(p).getByText("How complete is this brief")));
      await t.step("Ask the client next: the must-have questions still open, most important first.", () => t.point(main(p).getByText("Ask the client next")));
      await t.step("Sections A–G: client, space, location, budget, timeline, approvals and gaps.", () => t.point(main(p).getByRole("link", { name: /^B\s*Space/ })));
      await t.step("Each value shows its status. The size range here is an estimate until the client confirms.", () => t.point(main(p).getByRole("button", { name: /target: 25,000/ })));
      await maybe(t, main(p).getByRole("button", { name: /Fill these in/ }), "Fill these in opens the missing items of a section so you can type them straight in.");
      await maybe(t, main(p).getByRole("heading", { name: "Assumptions & open questions" }), "Assumptions & open questions sums up confirmed, estimated, assumed and missing items, plus pending approvals.");
      await maybe(t, main(p).getByRole("heading", { name: /Brief snapshots/ }), "Brief snapshots lists every saved version; Meeting outcomes shows what was agreed in meetings.");
      await maybe(t, main(p).getByRole("link", { name: "Open requirement" }), "Open requirement goes to the client's requirement record behind this brief.");
      await t.step("Save a snapshot — a fixed version you can approve and use in client documents.", async () => {
        await t.scroll(-3000); await t.type(field(p, "note"), "After first call with Ananya", 30);
        await t.moveAndClick(main(p).getByRole("button", { name: "Save brief snapshot" }));
      });
      await t.step("Saved. It lists the mandatory items still missing before it can be approved.", () => t.point(main(p).getByText(/Brief snapshot saved/)));
      await t.step("The step bar: fill the gaps, save a snapshot, approve it, then use it in client documents.", () => t.point(main(p).getByText(/Fill the gaps/).first()));
      await t.step("Download deck makes an editable PowerPoint of the brief.", () => t.moveAndClick(main(p).getByRole("button", { name: /Download deck/ }).or(main(p).getByRole("link", { name: /Download deck/ })).first()));
      await dump(t, "requirement-brief");
      await t.outro("opened a client brief, read its gaps, saved a snapshot and downloaded the deck.", "work out what a lease really costs.");
    },
  },

  {
    slug: "lease-economics", category: CAT, title: "Lease economics: what a lease really costs",
    learn: "Enter rent, escalation, rent-free, CAM and deposit; read effective rent, total cost over the term and present value.", tryRoute: "/toolkit/lease",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Lease economics", "Rent, escalation, rent-free, CAM and deposit → effective rent and total cost over the term.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Cost a lease.", () => t.moveAndClick(main(p).getByRole("link", { name: /Cost a lease/ })));
      await howTo(t);
      await t.step("Name it and set a discount rate — used to work out today's value of future rent.", async () => {
        await typeField(t, "title", "Zentrix — Kharadi Tech Park terms"); await typeField(t, "discount", "10");
      });
      await t.step("Space and term: 25,000 sq ft for 60 months, 3 months rent-free.", async () => {
        await fillQuiet(p, { o0_name: "Kharadi Tech Park", o0_tenure: "60", o0_lc: "2027-03-01" });
        await typeField(t, "o0_area", "25000"); await typeField(t, "o0_rf", "3");
      });
      await t.step("Rent ₹95 per sq ft per month, going up 5% every 12 months.", async () => {
        await typeField(t, "o0_rent", "95"); await fillQuiet(p, { o0_esc: "5", o0_escevery: "12" });
      });
      await t.step("CAM ₹18 per sq ft and a 6-month deposit. Blank means unknown — never zero.", async () => {
        await typeField(t, "o0_cam", "18"); await fillQuiet(p, { o0_pslots: "0", o0_other_none: true }); await typeField(t, "o0_dep", "6");
      });
      await t.step("Calculate & save. Fixed formulas do the maths — no AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/lease\?id=/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Calculate & save" }))]);
      });
      await t.step("Monthly rent and CAM: what is paid each month at the start.", () => t.point(main(p).getByText("Monthly rent (starting)")));
      await t.step("Effective rent: the average per sq ft after rent-free and escalation.", () => t.point(main(p).getByText("Effective rent", { exact: true })));
      await t.step("Total cost over the tenure, and its present value — today's money at your discount rate.", () => t.point(main(p).getByText("Total cost over tenure")));
      await t.step("The deposit is shown apart: it is not a cost, it comes back at the end.", () => t.point(main(p).getByText("Refundable deposit", { exact: true })));
      await t.step("Year by year: rent, CAM and total cost for each lease year.", () => t.point(main(p).getByText("Year by year", { exact: true })));
      await resultTour(t, { saved: "Saved lease analyses" });
      await dump(t, "lease-economics");
      await t.outro("costed one lease: effective rent, total cost and present value.", "work out occupancy cost and cash at signing.");
    },
  },

  {
    slug: "occupancy-cost", category: CAT, title: "Occupancy cost: monthly, upfront cash and present value",
    learn: "Add fit-out and moving to the lease terms; see cash at signing (refundable vs not), present value, peak cash and what-ifs.", tryRoute: "/toolkit/occupancy",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Occupancy cost", "The all-in cost: monthly, cash at signing (refundable or not) and present value.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Cost per seat.", () => t.moveAndClick(main(p).getByRole("link", { name: /Cost per seat/ })));
      await howTo(t);
      await t.step("Enter the lease terms — the same boxes as lease economics.", async () => {
        await typeField(t, "title", "Zentrix — all-in cost");
        await fillQuiet(p, { discount: "10", o0_name: "Kharadi Tech Park", o0_area: "25000", o0_tenure: "60", o0_lc: "2027-03-01", o0_rf: "3", o0_rent: "95", o0_esc: "5",
          o0_escevery: "12", o0_cam: "18", o0_pslots: "20", o0_prate: "3000", o0_other_none: true, o0_dep: "6" });
      });
      await t.step("A one-off at signing: ₹12 lakh legal and stamp duty — a cost you don't get back.", async () => {
        await typeField(t, "o0_nr_label", "Legal & stamp duty"); await typeField(t, "o0_nr_amount", "1200000");
      });
      await t.step("Cash at signing: fit-out ₹3 crore and moving ₹25 lakh.", async () => { await typeField(t, "fitout", "30000000"); await typeField(t, "moving", "2500000"); });
      await t.step("Calculate & save — fixed, tested formulas, not AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/occupancy\?id=/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Calculate & save" }))]);
      });
      await t.step("Nominal rent is the quoted rate; effective rent spreads rent-free and escalation over the term.", () => t.point(main(p).getByText("Effective rent", { exact: true })));
      await t.step("Present value: the whole term in today's money. Peak cash: the most you are out of pocket.", () => t.point(main(p).getByText("Peak cash needed")));
      await t.step("Cash at signing: the deposit is marked refundable; fit-out, moving and fees are not.", () => t.point(main(p).getByText("Cash needed at signing")));
      await t.step("Unknown items stay 'unknown' and are left out of the total — never guessed.", () => t.point(main(p).getByText("Total (known items only)")));
      await t.step("What-ifs: how much the present value moves if rent, escalation or fit-out change.", () => t.point(main(p).getByText("Standard what-ifs")));
      await resultTour(t, { saved: "Saved occupancy analyses" });
      await dump(t, "occupancy-cost");
      await t.outro("worked out the all-in occupancy cost, cash at signing and present value.", "compare a managed office with a conventional lease.");
    },
  },

  {
    slug: "managed-vs-conventional", category: CAT, title: "Managed office vs conventional lease",
    learn: "Compare the same seats over the same months; services in the seat price are not counted twice.", tryRoute: "/toolkit/managed",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Managed office vs conventional lease", "Same seats, same months — and nothing counted twice.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Compare options under Lease vs managed office.", () => t.moveAndClick(main(p).getByRole("link", { name: /Compare options/ })));
      await howTo(t);
      await t.step("Compare 250 seats over 36 months — both options use the same seats and period.", async () => {
        await typeField(t, "title", "Zentrix — lease vs managed, 250 seats"); await typeField(t, "comparisonMonths", "36"); await typeField(t, "headcount", "250");
      });
      await t.step("Conventional: rent, CAM, fit-out, furniture, deposit and running costs.", async () => {
        await typeField(t, "c_rentRate", "95");
        await fillQuiet(p, { c_chargeableSf: "25000", c_seats: "250", c_camRate: "18", c_tenureMonths: "60", c_lockInMonths: "36", c_escPct: "5", c_deposit: "14250000",
          c_fitout: "30000000", c_furniture: "5000000", c_it: "3000000", c_restoration: "2000000", c_utilitiesMonthly: "250000", c_housekeepingMonthly: "120000",
          c_maintenanceMonthly: "80000", c_parkingMonthly: "60000", c_otherServicesMonthly: "50000", c_monthsToOccupy: "5", c_control: "5" });
      });
      await t.step("Managed: ₹14,000 per seat per month, 12-month lock-in.", async () => {
        await typeField(t, "m_perSeatPrice", "14000");
        await fillQuiet(p, { m_seats: "250", m_contractMonths: "36", m_lockInMonths: "12", m_escPct: "5", m_deposit: "7000000", m_setup: "500000", m_monthsToOccupy: "1", m_control: "3" });
      });
      await t.step("Ticked services are already in the seat price, so they are not added again.", async () => {
        const box = main(p).locator('input[name="m_included"][value="utilities"]'); await reveal(box); await t.point(box.locator("xpath=ancestor::fieldset[1]").or(box.locator("xpath=../..")).first());
      });
      await t.step("Only extras billed on top go under Charged separately — here, parking.", async () => {
        await fillQuiet(p, { m_internetMonthly: "0", m_utilitiesMonthly: "0", m_housekeepingMonthly: "0", m_receptionMonthly: "0", m_securityMonthly: "0",
          m_maintenanceMonthly: "0", m_addOnsMonthly: "0", m_furniture: "0", m_it: "0" });
        await typeField(t, "m_parkingMonthly", "60000");
      });
      await t.step("Weights: what matters most to the client — cost, flexibility, commitment, speed, control.", async () => { const w = field(p, "w_cost"); await reveal(w); await t.point(w); });
      await t.step("Compare & save — calculated by fixed formulas, not AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/managed\/[0-9a-f-]{36}/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Compare & save" }))]);
      });
      await t.step("The answer: cheaper over the period, and better on the client's weighted criteria — with reasons.", () => t.point(main(p).getByText("THE ANSWER")));
      await t.step("Totals over 36 months and cost per seat per month, side by side.", () => t.point(main(p).getByText("Per seat / month")));
      await t.step("Side by side: one-off costs, refundable deposit, lock-in and flexibility.", () => t.point(main(p).getByRole("heading", { name: "Side by side" }).or(main(p).getByText("Side by side", { exact: true })).first()));
      await maybe(t, main(p).getByText("Cost over time", { exact: true }), "Cost over time: running totals month by month — dashed is conventional, solid is managed.");
      await maybe(t, main(p).getByText("Managed office — line by line").or(main(p).getByText(/Managed — line by line/)), "Line by line: every cost behind each total; included services show as 'in seat price', not added again.");
      await resultTour(t, {});
      await dump(t, "managed-vs-conventional");
      await t.outro("compared a managed office with a conventional lease for the same 250 seats.", "compare renewing with relocating.");
    },
  },

  {
    slug: "renewal-relocation", category: CAT, title: "Renew or relocate: the total impact",
    learn: "Compare staying with moving: moving costs, overlap rent, deposits, present value and break-even.", tryRoute: "/toolkit/renewal",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Renew or relocate?", "Moving costs, overlap rent and deposits — the total impact of each choice.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Stay or move.", () => t.moveAndClick(main(p).getByRole("link", { name: /Stay or move/ })));
      await howTo(t);
      await t.step("Compare over 60 months at a 10% discount rate.", async () => {
        await typeField(t, "title", "Zentrix — stay or move"); await fillQuiet(p, { comparisonMonths: "60" }); await typeField(t, "discountRatePct", "10");
      });
      await t.step("Stay: the landlord's renewal rent of ₹21.5 lakh a month, plus CAM and a refurbishment.", async () => {
        await fillQuiet(p, { r_currentRentMonthly: "1900000" }); await typeField(t, "r_proposedRentMonthly", "2150000");
        await fillQuiet(p, { r_extensionMonths: "60", r_rentFreeMonths: "0", r_escPct: "5", r_camMonthly: "400000", r_maintenanceMonthly: "50000", r_otherMonthly: "0",
          r_refurbishment: "5000000", r_otherOneOff: "0", r_depositChange: "1500000" });
      });
      await t.step("Move: new rent, 3 months rent-free — and 2 months of overlap paying both rents.", async () => {
        await fillQuiet(p, { l_newRentMonthly: "2375000", l_rentFreeMonths: "3" }); await typeField(t, "l_overlapMonths", "2");
        await fillQuiet(p, { l_escPct: "5", l_camMonthly: "450000", l_otherMonthly: "0" });
      });
      await t.step("Moving costs: fit-out, moving, restoring the old office, IT, downtime and deposits.", async () => {
        await typeField(t, "l_fitout", "30000000");
        await fillQuiet(p, { l_moving: "2500000", l_restorationOld: "2000000", l_brokerage: "0", l_itRelocation: "1500000", l_downtimeCost: "1000000",
          l_employeeTransition: "500000", l_otherOneOff: "0", l_deposit: "14250000", l_oldDepositReturned: "11400000" });
      });
      await t.step("Non-money factors (location, disruption…) are scored 1–5 separately — optional, never mixed into cost.", async () => { const l = field(p, "s_location_r"); await reveal(l); await t.point(l); });
      await t.step("Compare & save — fixed formulas, not AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/renewal\/[0-9a-f-]{36}/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Compare & save" }))]);
      });
      await t.step("The answer: staying is cheaper in today's money. Non-money scores are kept separate.", () => t.point(main(p).getByText("THE ANSWER")));
      await t.step("Break-even: the month moving would become cheaper — here, not within 60 months.", () => t.point(main(p).getByText("Break-even", { exact: true })));
      await t.step("Present-value difference: positive means moving costs more in today's money.", () => t.point(main(p).getByText(/Present-value difference/)));
      await maybe(t, main(p).getByText("Cost over time", { exact: true }), "Cost over time: running totals — dashed is stay, solid is move. If they cross, that is break-even.");
      await t.step("Line by line: every cost behind each total, including the overlap rent.", async () => { await t.point(main(p).getByText("Move — line by line")); });
      await resultTour(t, {});
      await dump(t, "renewal-relocation");
      await t.outro("compared renewing with relocating, including moving costs and overlap rent.", "budget the fit-out and finance it.");
    },
  },

  {
    slug: "fitout-financing", category: CAT, title: "Fit-out budget, partner quotes and financing",
    learn: "Budget the fit-out line by line, rank partner quotes like-for-like, then work out the loan EMI.", tryRoute: "/toolkit/fitout",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Fit-out quotes and financing", "Budget the fit-out, rank partner quotes, then see the loan EMI.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Fit-out budget.", () => t.moveAndClick(main(p).getByRole("link", { name: /Fit-out budget/ })));
      await t.step("Name it, with carpet area and seats so it can show cost per sq ft and per seat.", async () => {
        await t.type(main(p).locator("#fo-title"), "Zentrix Kharadi fit-out", 30);
        await main(p).locator("#fo-area").fill("20000"); await main(p).locator("#fo-seats").fill("250");
      });
      await t.step("Budget lines: quantity × unit price, with tax % on each line (never assumed).", async () => {
        const L = (i, x) => main(p).getByLabel(`Line ${i} ${x}`, { exact: true });
        await L(1, "category").selectOption({ label: "Civil" });
        await t.type(L(1, "description"), "Partitions & civil works", 20);
        await L(1, "quantity").fill("20000"); await L(1, "unit").fill("sf"); await L(1, "unit price ₹").fill("900"); await L(1, "tax %").fill("18");
        await main(p).getByRole("button", { name: "＋ Add budget line" }).click();
        await L(2, "category").selectOption({ label: "Furniture" }); await L(2, "description").fill("Workstations");
        await L(2, "quantity").fill("250"); await L(2, "unit").fill("nos"); await L(2, "unit price ₹").fill("28000"); await L(2, "tax %").fill("18");
        await t.point(L(2, "tax %"));
      });
      await t.step("Add two partner quotations — price before tax, tax, delivery and warranty.", async () => {
        const add = main(p).getByRole("button", { name: "＋ Add partner quotation" });
        const q = [["Studio Axis Interiors", "24500000", "18", "14", "24"], ["Buildwell Projects", "22800000", "18", "18", "12"]];
        for (let i = 0; i < q.length; i++) {
          await t.moveAndClick(add);
          const a = main(p).getByRole("article", { name: `Quotation ${i + 1}` });
          const ins = a.locator("input");
          await ins.nth(0).fill(q[i][0]); await ins.nth(1).fill(q[i][1]); await ins.nth(2).fill(q[i][2]); await ins.nth(3).fill(q[i][3]); await ins.nth(4).fill(q[i][4]);
          for (const c of ["Civil", "Furniture"]) await a.getByRole("button", { name: new RegExp(c) }).click();
        }
      });
      await t.step("Compare & save — the totals and the ranking are fixed formulas, not AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/fitout\/[0-9a-f-]{36}/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Compare & save" }))]);
      });
      await t.step("The budget total, with tax shown separately, and cost per sq ft and per seat.", async () => { await sleep(300); await t.scroll(350); });
      await maybe(t, main(p).getByText("By category", { exact: true }), "Estimated, approved and actual are kept apart. 'Unknown' means not entered yet — not zero.");
      await maybe(t, main(p).getByText("Approved − estimated", { exact: true }), "Variances show how far approved and actual costs moved from the estimate.");
      await t.step("Quotes ranked on price, scope, timeline and warranty — the weights are shown.", async () => { await t.scroll(600); });
      await resultTour(t, { method: false });
      await dump(t, "fitout-result");
      await t.step("Now Financing: how to pay for the fit-out.", async () => { await t.goto("/toolkit"); await t.moveAndClick(main(p).getByRole("link", { name: /^Financing/ })); });
      await t.step("A ₹2 crore loan at 11% over 36 months, after a ₹45 lakh client contribution.", async () => {
        await t.type(field(p, "title"), "Zentrix fit-out — 36m loan", 25);
        await fillQuiet(p, { partner: "Buildwell Projects", projectCost: "24500000", clientContribution: "4500000", financedAmount: "20000000", tenureMonths: "36" });
        await typeField(t, "annualRatePct", "11");
      });
      await t.step("Calculate & save.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/financing\/[0-9a-f-]{36}/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Calculate & save" }))]);
      });
      await t.step("The EMI, total interest and the full repayment schedule — calculated, not estimated by AI.", async () => { await t.point(main(p).getByText(/EMI/).first()); });
      await maybe(t, main(p).getByText("Repayment schedule", { exact: true }), "Repayment schedule: each month's interest on the opening balance, and how much goes to the loan.");
      await resultTour(t, {});
      await dump(t, "fitout-financing");
      await t.outro("budgeted a fit-out, ranked two partner quotes and worked out the loan EMI.", "track landlord offers in a negotiation.");
    },
  },

  {
    slug: "negotiation-offers", category: CAT, title: "Track landlord offers and counter-offers",
    learn: "Record each landlord offer as it comes; see what changed term by term and what it is worth.", tryRoute: "/toolkit/negotiation",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Track offers and counter-offers", "Record each landlord offer as it arrives and see exactly what changed.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Plan negotiation.", () => t.moveAndClick(main(p).getByRole("link", { name: /Plan negotiation/ })));
      await howTo(t);
      await t.step("Open the Zentrix negotiation — the landlord's first offer is already recorded.", () => t.moveAndClick(main(p).getByRole("link", { name: new RegExp(NEGO_TITLE) }).first()));
      await t.step("Offer 1: present value of the whole term, rent total and the refundable deposit.", () => t.point(main(p).getByText("Offer timeline")));
      await t.step("The landlord came back. Record Offer 2 — it starts pre-filled with Offer 1.", async () => {
        const h = main(p).getByText(/^Record Offer 2/); await t.point(h);
      });
      await t.step("Change only what changed: rent ₹98 → ₹92, rent-free 2 → 4 months, deposit 10 → 6 months.", async () => {
        await typeField(t, "note", "Counter after site visit");
        for (const [k, v] of [["o0_rent", "92"], ["o0_rf", "4"], ["o0_dep", "6"]]) { const l = field(p, k); await reveal(l); await l.fill(""); await t.type(l, v, 60); }
      });
      await t.step("Save as Offer 2. Earlier offers stay exactly as recorded.", async () => {
        await t.moveAndClick(main(p).getByRole("button", { name: "Save as Offer 2" }));
        await main(p).getByText(/What changed: Offer 1/).waitFor({ timeout: 60000 });
      });
      await t.step("What changed: Offer 2 is ₹1.6 crore cheaper in present value — calculated, not AI.", () => t.point(main(p).getByText(/What changed: Offer 1/)));
      await t.step("Term by term: improved, unchanged or still unresolved with the landlord.", () => t.point(main(p).getByRole("cell", { name: "Base rent ₹/SF/month" })));
      await maybe(t, main(p).locator("summary", { hasText: "Define packages" }), "Concession packages: describe up to three asks (e.g. more rent-free) and see what each is worth.", true);
      await maybe(t, main(p).getByText(/inputs missing — still unresolved/), "Missing inputs: terms still unresolved with the landlord — listed, not assumed.");
      await maybe(t, main(p).getByText("! Risks").or(main(p).getByText("Risks", { exact: true })), "Risks: e.g. a long lock-in or a big deposit, flagged from the numbers.");
      await maybe(t, main(p).getByRole("button", { name: /Draft talking points/ }), "Draft talking points can word your points for you (optional AI wording) — the numbers stay from the calculator.");
      await t.step("Strategy reads the numbers and lists the open terms and risks. Nothing is sent from here.", async () => { await t.point(main(p).getByText("Strategy", { exact: true })); });
      await resultTour(t, {});
      await dump(t, "negotiation-offers");
      await t.outro("recorded a counter-offer and saw what changed and what it is worth.", "compare landlord offers on a requirement.");
    },
  },

  {
    slug: "landlord-offers", category: CAT, title: "Compare landlord offers on a requirement, line by line",
    learn: "Record each landlord's offer on the client requirement and compare rent, rent-free, deposit and cost line by line.", tryRoute: "/requirements",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Landlord offers, line by line", "Record each landlord's offer on the client's requirement and compare them.");
      await t.step("Open Requirements from the sidebar.", () => t.moveAndClick(navLink(p, "Requirements")));
      await t.step("Open the Zentrix requirement.", () => t.moveAndClick(main(p).getByRole("link", { name: new RegExp(REQ) }).first()));
      const card = main(p).locator("details").filter({ has: p.locator("summary", { hasText: "Record a landlord offer" }) }).first();
      await t.step("The Landlord offers card already holds one offer: Riverside Towers.", async () => { await t.point(main(p).getByText("Landlord offers (compare line by line)")); });
      await t.step("Record a second offer, from the Kharadi Tech Park LOI.", () => t.moveAndClick(card.locator("summary")));
      await t.step("Type the terms as the landlord wrote them. Leave blank anything it does not say.", async () => {
        const f = (n) => card.locator(`[name="${n}"]`);
        await t.type(f("name"), "Kharadi Tech Park, Floor 5", 25);
        await f("building_name").fill("Kharadi Tech Park (demo)"); await f("areaSf").fill("25000"); await f("areaBasis").selectOption("chargeable");
        await t.type(f("rentPerSf"), "95", 60);
        for (const [k, v] of Object.entries({ escalationPct: "5", escalationEveryMonths: "12", termMonths: "60", lockInMonths: "36", rentFreeMonths: "4", securityDepositMonths: "6",
          fitoutAllowanceInr: "2500000", camPerSf: "18", carParks: "20", carParkRatePerSlot: "3000", seats: "250", leaseCommencement: "2027-03-01", validUntil: "2026-12-31", sourceDoc: "KTP LOI.pdf" })) await f(k).fill(v);
        await t.point(f("securityDepositMonths"));
      });
      await t.step("Save offer.", async () => { await t.moveAndClick(card.getByRole("button", { name: "Save offer" })); });
      await t.step("Now both offers sit side by side, one line per term.", async () => {
        const tbl = main(p).locator("table").filter({ hasText: "Kharadi Tech Park, Floor 5" }).first(); await tbl.waitFor({ timeout: 60000 }); await t.point(tbl);
      });
      await t.step("Bold marks the better offer on each line; blanks show as 'unknown', never zero.", () => t.point(main(p).getByText(/Bold = best on the line/)));
      await t.step("Costs use the same start date and a 10% discount rate, from tested lease formulas — not AI.", async () => { await t.point(main(p).getByText(/Costs at 10% discount/)); });
      await maybe(t, main(p).locator("summary", { hasText: "Save comparison as an analysis" }), "Save comparison as an analysis keeps it in the Deal toolkit, with your own discount rate and start date.", true);
      await maybe(t, main(p).locator("summary", { hasText: /^Revise/ }), "Revise saves a landlord's updated terms as a new version; the old version is kept.");
      await dump(t, "landlord-offers");
      await t.outro("recorded a landlord offer and compared two offers line by line.", "model a built-to-suit option.");
    },
  },

  {
    slug: "bts-model", category: CAT, title: "Built-to-suit model",
    learn: "From land and construction cost and the developer's yield, work out the rent a built-to-suit needs — and compare with leasing.", tryRoute: "/toolkit/bts",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Built-to-suit model", "What rent would a building made for the client need — and is it cheaper than leasing?");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Built-to-suit under Specialist models.", () => t.moveAndClick(main(p).getByRole("link", { name: /Built-to-suit/ })));
      await howTo(t);
      await t.step("Name it and link it to the Zentrix requirement.", async () => {
        await t.type(field(p, "title"), "Zentrix BTS — Kharadi", 30); await fillQuiet(p, { requirement_id: REQ });
      });
      await t.step("Land bought for ₹15 crore; 25,000 sq ft built at ₹4,500 per sq ft over 18 months.", async () => {
        await fillQuiet(p, { landMode: "Purchase" }); await typeField(t, "landCost", "150000000");
        await fillQuiet(p, { areaSf: "25000", areaBasis: "Chargeable", softCostPct: "10", constructionMonths: "18" }); await typeField(t, "constructionCostPerSf", "4500");
      });
      await t.step("The developer wants a 9% yield on cost.", async () => { await fillQuiet(p, { mode: "Required rent (I know the yield)" }); await typeField(t, "yieldOnCostPct", "9"); });
      await t.step("A 10-year lease to the client, and a lease elsewhere at ₹95 to compare against.", async () => {
        await fillQuiet(p, { leaseTermMonths: "120", escalationPct: "5", escalationEveryMonths: "12", rentFreeMonths: "3", depositMonths: "6", tenantFitout: "30000000", discountRatePct: "10",
          alt_name: "Kharadi Tech Park lease", alt_areaSf: "25000", alt_areaBasis: "Chargeable", alt_escalationPct: "5", alt_escalationEveryMonths: "12", alt_rentFreeMonths: "3",
          alt_depositMonths: "6", alt_fitout: "30000000" });
        await typeField(t, "alt_rentPerSfMonth", "95");
      });
      await t.step("Calculate & save — fixed formulas, not AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/bts\/[0-9a-f-]{36}/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Calculate & save" }))]);
      });
      await t.step("Total project cost: land, construction and soft costs.", () => t.point(main(p).getByText("Total project cost", { exact: true })));
      await t.step("Required rent: what the client must pay per sq ft per month for the developer to earn 9%.", () => t.point(main(p).getByText("Required rent", { exact: true })));
      await t.step("Rent schedule: the rent for each lease year after escalation.", () => t.point(main(p).getByText("Rent schedule by lease year")));
      await t.step("BTS vs leasing: lower total and present value for the client — built-to-suit wins here.", () => t.point(main(p).getByText(/^BTS vs /)));
      await t.step("Assumptions are written out, e.g. interest during construction is not included.", () => t.point(main(p).getByText("Assumptions", { exact: true })));
      await resultTour(t, {});
      await dump(t, "bts-model");
      await t.outro("modelled a built-to-suit option and compared it with leasing.", "run an investment analysis.");
    },
  },

  {
    slug: "investment-model", category: CAT, title: "Investment analysis: IRR, NPV and sensitivities",
    learn: "Price, tenancies, costs and exit give IRR, NPV, yield and equity multiple — with what-if sensitivities.", tryRoute: "/toolkit/investment",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Investment analysis", "Is this building a good buy? IRR, NPV and how sensitive they are.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Investment under Specialist models.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Investment/ })));
      await howTo(t);
      await t.step("Buy for ₹120 crore plus 7% stamp duty; 1 lakh sq ft leasable.", async () => {
        await t.type(field(p, "title"), "Kharadi Tech Park — buy & hold", 25);
        await typeField(t, "purchasePrice", "1200000000"); await fillQuiet(p, { stampDutyPct: "7", otherAcquisitionCosts: "10000000", leasableAreaSf: "100000", areaBasis: "Leasable" });
      });
      await t.step("Tenancy schedule: two tenants, with expiry, vacant months and re-let rent.", async () => {
        await typeField(t, "t0_name", "Zentrix Analytics");
        await fillQuiet(p, { t0_areaSf: "60000", t0_rentPerSfMonth: "95", t0_escalationPct: "5", t0_escalationEveryMonths: "12", t0_expiryMonth: "60", t0_downtimeMonths: "6",
          t0_reletRentPerSfMonth: "105", t0_reletEscalationPct: "5", t0_camRecoveryPerSfMonth: "0", t1_name: "Second tenant", t1_areaSf: "40000", t1_rentPerSfMonth: "90",
          t1_escalationPct: "5", t1_escalationEveryMonths: "12", t1_expiryMonth: "36", t1_downtimeMonths: "6", t1_reletRentPerSfMonth: "100", t1_reletEscalationPct: "5", t1_camRecoveryPerSfMonth: "0" });
        await t.point(field(p, "t1_name"));
      });
      await t.step("Running costs, then hold 7 years and sell at an 8% exit cap rate; discount at 12%.", async () => {
        await fillQuiet(p, { opexPerSfMonth: "5", opexEscalationPct: "5", capexReservePerSfYear: "20", holdingYears: "7", saleCostsPct: "2", discountRatePct: "12" });
        await typeField(t, "exitCapRatePct", "8");
      });
      await t.step("Debt is optional: tick it to add a loan and see levered returns and DSCR.", async () => { const d = field(p, "debt"); await reveal(d); await t.point(d); });
      await t.step("Calculate & save — fixed formulas, not AI.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/investment\/[0-9a-f-]{36}/, { timeout: 60000 }), t.moveAndClick(main(p).getByRole("button", { name: "Calculate & save" }))]);
      });
      await t.step("IRR: the yearly return on the money put in. NPV: value in today's money at your 12% rate.", () => t.point(main(p).getByText("Unlevered IRR", { exact: true })));
      await t.step("Negative NPV means the return is below 12%; equity multiple is cash back ÷ cash in.", () => t.point(main(p).getByText("Equity multiple", { exact: true })));
      await t.step("Cash flows by year: rent, costs, net operating income — and the sale in the final year.", () => t.point(main(p).getByText("Cash flows by year")));
      await t.step("Sensitivities: how IRR and NPV move if the exit cap or rent change.", () => t.point(main(p).getByText("Sensitivities", { exact: true }).first()));
      await maybe(t, main(p).getByText("Assumptions", { exact: true }), "Assumptions are written out, e.g. how the exit value is worked out.");
      await resultTour(t, {});
      await dump(t, "investment-model");
      await t.outro("ran an investment analysis with IRR, NPV and sensitivities.", "make a site-visit pack.");
    },
  },

  {
    slug: "visit-pack", category: CAT, title: "Site-visit pack and deliverables (Word, PDF, deck)",
    learn: "Pick a requirement and buildings; download a Word pack, a printable PDF and an editable deck. Nothing is sent.", tryRoute: "/toolkit/packs",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Site-visit pack and deliverables", "A Word pack, a printable PDF and an editable deck for a shortlist.");
      await t.step("Open Deal toolkit from the sidebar.", () => t.moveAndClick(navLink(p, "Deal toolkit")));
      await t.step("Choose Make a pack.", () => t.moveAndClick(main(p).getByRole("link", { name: /Make a pack/ })));
      await t.step("Choose the requirement.", async () => { const s = field(p, "requirement_id"); await t.point(s); await s.selectOption({ label: REQ }); });
      await t.step("Put the client's name on the cover.", () => t.type(field(p, "prepared_for"), "Zentrix Analytics", 35));
      await t.step("Tick the buildings to show on the visit.", async () => {
        for (const n of ["Kharadi Tech Park \\(demo\\)", "Kharadi Riverside Towers \\(demo\\)"]) await t.moveAndClick(main(p).getByLabel(new RegExp(n)));
      });
      await t.step("Generate the files.", async () => {
        await Promise.all([p.waitForURL(/\/toolkit\/packs\/[0-9a-f-]{36}/, { timeout: 90000 }), t.moveAndClick(main(p).getByRole("button", { name: "Generate the files" }))]);
      });
      await t.step("Three files: a Word visit pack, the same pack as a printable PDF, and a PowerPoint deck.", () => t.point(main(p).getByText("Downloads", { exact: true })));
      await t.step("Download the Word pack — details, key commercials, checklist and a feedback form.", () => t.moveAndClick(main(p).getByText(/Site visit pack \(.docx\)/)));
      await t.step("Built from shows which saved analysis and version the figures came from.", () => t.point(main(p).getByText("Built from", { exact: true })));
      await t.step("Nothing is sent from here — download the files and share them yourself.", () => t.point(main(p).getByText(/Nothing is sent: share the files yourself/)));
      await maybe(t, main(p).getByText(/Links expire after 10 minutes/), "Download links expire after 10 minutes — reload the page for fresh ones.");
      await maybe(t, main(p).getByRole("button", { name: /Add evidence/ }).or(main(p).getByText("+ Add evidence")), "Add evidence: attach the quote, brochure or floor plan the pack relied on.");
      await t.step("All packs: every pack you made is listed, newest first.", () => t.moveAndClick(main(p).getByRole("link", { name: /All packs/ })));
      await t.step("Make client documents builds a proposal, workbook and decision summary from saved analyses.", async () => { await t.goto("/toolkit"); await t.moveAndClick(main(p).getByRole("link", { name: /Make documents/ })); });
      await t.step("Choose the requirement, then Show its analyses to pick what goes in.", async () => {
        const s2 = field(p, "requirement"); await t.point(s2); await s2.selectOption({ index: 1 }); await t.moveAndClick(main(p).getByRole("button", { name: "Show its analyses" }));
      });
      await dump(t, "visit-pack");
      await t.outro("generated a site-visit pack as Word, PDF and a deck.", "make client documents from saved analyses.");
    },
  },
];

module.exports = { FLOWS, prepare };
