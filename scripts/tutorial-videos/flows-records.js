// Tutorial videos — group "records": adding and finding records (companies, people, buildings, imports,
// requirements, shortlist, pipeline, lease radar, search, database & places). Captions describe only what is on screen.
const fs = require("fs");
const { execFileSync } = require("child_process");

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const WS = "de000000-0000-4000-8000-000000000001"; // "Demo — Pune CRE (synthetic)"
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", q], { stdio: "pipe" }).toString();

const NEW_CO = "Sahyadri Loom Textiles";
const NEW_PERSON = "Meera Kulkarni";
const NEW_BUILDING = "Riverside One (demo)";
const NEW_REQ = "Sahyadri Loom — Baner office 2027";
const DEAL = "Kestrelbay Payments — managed space for India team";
const DEAL_ID = "2267ef68-fa5c-5e95-a76a-37a56fece917";
const MARIGOLD_ID = "199eb206-ec77-5ecc-92b8-f071a03e5ef1";
const MARIGOLD_NOTE = "Sent intro email to the admin head (tutorial)";
const STAGE_NOTE = "Client confirmed seats and budget on call (tutorial)";
const CSV = "/tmp/tutorial-new-buildings.csv";
const CSV_BUILDINGS = ["Riverbend Tech Park (demo)", "Lakeview Square (demo)", "Sunmill Business Bay (demo)"];

const nav = (p) => p.getByRole("navigation", { name: "Main" });
const navLink = (p, name) => nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
const main = (p) => p.locator("main");
const lit = (s) => s.replace(/'/g, "''");
const iso = (d) => d.toISOString().slice(0, 10);

/** Archive what earlier runs of these videos created (demo workspace only), so each recording starts the same. */
function reset() {
  sql(`update mudar.organisation set archived_at=now() where workspace_id='${WS}' and display_name='${lit(NEW_CO)}' and archived_at is null`);
  sql(`update mudar.person set archived_at=now() where workspace_id='${WS}' and full_name='${lit(NEW_PERSON)}' and archived_at is null`);
  sql(`update mudar.asset set archived_at=now() where workspace_id='${WS}' and name in ('${lit(NEW_BUILDING)}',${CSV_BUILDINGS.map((b) => `'${lit(b)}'`).join(",")}) and archived_at is null`);
  sql(`update mudar.requirement set archived_at=now() where workspace_id='${WS}' and title='${lit(NEW_REQ)}' and archived_at is null`);
  // Pipeline video: put the demo deal back on "Qualified discussion".
  sql(`delete from mudar.opportunity_stage_history where workspace_id='${WS}' and opportunity_id='${DEAL_ID}' and evidence='${lit(STAGE_NOTE)}'`);
  sql(`delete from mudar.opportunity_stage_history where workspace_id='${WS}' and opportunity_id='${MARIGOLD_ID}' and evidence='${lit(MARIGOLD_NOTE)}'`);
  sql(`update mudar.opportunity set stage='research' where workspace_id='${WS}' and id='${MARIGOLD_ID}'`);
  sql(`update mudar.opportunity set stage='qualified_discussion' where workspace_id='${WS}' and id='${DEAL_ID}'`);
  // Import video: forget the mapping approved by an earlier run so the mapping step shows again.
  sql(`delete from mudar.adapter_mapping where workspace_id='${WS}' and sample_headers::text like '%Micro-market%'`);
}

async function prepare() {
  reset();
  // Unique content per run (otherwise the upload is recognised as the same file and nothing new happens).
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  fs.writeFileSync(CSV, [
    "Property,Micro-market,Typical floor plate,Size,No. of floors,Stage,Deals,Remarks",
    `${CSV_BUILDINGS[0]},Kharadi,32000,640000,20,Ready,4,checked ${stamp}`,
    `${CSV_BUILDINGS[1]},Baner,NA,210000,9,Under construction,0,`,
    `${CSV_BUILDINGS[2]},Hinjewadi,28000,0,12,Ready,2,`,
  ].join("\n") + "\n");
}

/** Leave the demo workspace as it was: archive the imported demo buildings and the place names the import created. */
async function finish() {
  sql(`update mudar.asset set archived_at=now() where workspace_id='${WS}' and name in (${CSV_BUILDINGS.map((b) => `'${lit(b)}'`).join(",")}) and archived_at is null`);
  sql(`update mudar.geography g set archived_at=now() where g.workspace_id='${WS}' and g.archived_at is null and g.created_at > now() - interval '2 hours'
       and g.name in ('Kharadi','Baner','Hinjewadi') and exists (select 1 from mudar.geography o where o.workspace_id=g.workspace_id and o.id<>g.id and o.name=g.name and o.created_at < g.created_at)`);
}

async function pick(t, select, label) {
  await t.point(select);
  await select.filter({ visible: true }).first().selectOption({ label });
}
const field = (p, name) => main(p).locator(`[name="${name}"]`).filter({ visible: true }).first();
/** Open a folded (empty) section or a "More details" fold by its summary text, if it is still closed. */
async function unfold(t, text) {
  const s = main(t.page).locator("details:not([open]) > summary").filter({ hasText: text }).filter({ visible: true }).first();
  if (await s.count()) await t.moveAndClick(s);
}
/** Open a "+ Add …" form. (Inside a folded empty section its button is hidden by CSS — app bug — so open it directly.) */
async function openAdd(t, title) {
  const d = main(t.page).locator("details").filter({ has: t.page.locator(":scope > summary", { hasText: title }) }).last();
  const sum = d.locator(":scope > summary");
  if (await sum.isVisible()) { await t.moveAndClick(sum); return; }
  await d.evaluate((e) => { e.open = true; });
  await t.point(d.locator("form"));
}
const say = (t, caption, loc) => t.step(caption, loc ? () => t.point(loc) : null);

const FLOWS = [
  {
    slug: "add-company", category: "Records & data", title: "Add a company by hand",
    learn: "Search first so you don't create a duplicate, add the company with only what you know, then read its page.", tryRoute: "/companies/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Add a company by hand", "Search first to avoid duplicates. Fill in only what you know — blanks stay 'unknown'.",
        ["Search the list first", "Add company: name + optional details", "Read the new company page"]);
      await t.step("Open Companies under Records in the sidebar.", () => t.moveAndClick(navLink(p, "Companies")));
      await say(t, "This is every company you can see, A to Z. 'Show archived' brings back hidden ones.", main(p).getByRole("link", { name: "Show archived" }));
      await t.step("Search first: someone may already have added this company.", async () => {
        await t.type(main(p).getByPlaceholder("Filter company names…"), "Sahyadri"); await p.keyboard.press("Enter");
      });
      await say(t, "Only 'Sahyadri Arc Realty' matches — a different company, so ours is new.", main(p).getByRole("link", { name: "Sahyadri Arc Realty" }));
      await t.step("Press Add company.", () => t.moveAndClick(main(p).getByRole("link", { name: "Add company" })));
      await t.step("Display name: the name people use day to day.", () => t.type(field(p, "display_name"), NEW_CO));
      await t.step("Legal name only if you know it — e.g. from an invoice or MCA record.", () => t.type(field(p, "legal_name"), "Sahyadri Loom Textiles Pvt Ltd"));
      await t.step("More details holds website, CIN, GSTIN, sector, HQ country, headcount and GCC flag.", () => unfold(t, "More details"));
      await t.step("Fill only what you know. Here: the sector. Everything blank stays 'unknown'.", () => t.type(field(p, "sector"), "Textiles"));
      await say(t, "Classification controls who may see the record; the default is corporate confidential.", field(p, "classification"));
      await t.step("Press Create company.", () => t.moveAndClick(main(p).getByRole("button", { name: "Create company" })));
      await say(t, "The company page opens. Its badges show classification and how fresh the facts are.", main(p).getByRole("heading", { name: NEW_CO }));
      await say(t, "Identity shows the facts you gave; the rest say unknown — nothing is guessed.", main(p).getByText("Identity").first());
      await t.step("Below: people, signals, locations and group structure — each folds open when you add to it.", () => t.scroll(500));
      await t.outro("searched for a company, added it with only the facts you know, and read its page.", "add a person and link them to a company.");
    },
  },
  {
    slug: "add-person", category: "Records & data", title: "Add a person and link them to a company",
    learn: "Add a contact, then record where they work and their role so they show on the company page.", tryRoute: "/people/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Add a person → link to a company", "Create the person, then add their job: which company, which role.",
        ["Add person: just the name is required", "Add employment: company + designation", "See the role on both pages"]);
      await t.step("Open People under Records.", () => t.moveAndClick(navLink(p, "People")));
      await t.step("Search first, as with companies — then press Add person.", () => t.moveAndClick(main(p).getByRole("link", { name: /Add person/ })));
      await t.step("Full name is the only required field.", () => t.type(field(p, "full_name"), NEW_PERSON));
      await say(t, "Other spellings help CRE OS match notes and imports to this person later.", field(p, "aliases"));
      await t.step("More details: profile link, preferred language and channel, contact limits and notes.", () => unfold(t, "More details"));
      await t.step("Press Create person.", () => t.moveAndClick(main(p).getByRole("button", { name: "Create person" })));
      await say(t, "The person page. 'No current role on record' — so let's link them to a company.", main(p).getByText("No current role on record"));
      await t.step("Open Employment timeline, then Add employment.", async () => { await unfold(t, "Employment timeline"); await openAdd(t, "Add employment"); });
      await t.step("Choose the company they work for.", () => pick(t, field(p, "org_id"), "Zentrix Analytics"));
      await t.step("Designation: their role, so you know who decides.", () => t.type(field(p, "title"), "Head of Workplace"));
      await t.step("Works here now? Yes. Start and end dates are optional.", () => pick(t, field(p, "is_current"), "Yes"));
      await t.step("Press Add role.", () => t.moveAndClick(main(p).getByRole("button", { name: "Add role" })));
      await say(t, "The timeline now shows Head of Workplace at Zentrix Analytics.", main(p).getByText("Head of Workplace").first());
      await say(t, "Relationship level on the right: only you set it — suggestions never claim a good relationship.", main(p).getByText("Relationship level").first());
      await t.step("Further down: relationship context, intro paths, interactions, meetings and outreach.", () => t.scroll(600));
      await t.outro("added a person and linked them to a company with their role.", "add a building with a space and its availability.");
    },
  },
  {
    slug: "add-building", category: "Records & data", title: "Add a building with a space and its availability",
    learn: "Create the building, add a floor or unit, then record a dated availability snapshot with asking rent and its area basis.", tryRoute: "/buildings/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Add a building → space → availability", "Availability is a dated snapshot, so you always know how fresh it is.",
        ["Add building", "Add a floor / unit", "Record availability: status, date, rent + basis"]);
      await t.step("Open Buildings under Records, then Add building.", async () => {
        await t.moveAndClick(navLink(p, "Buildings"));
        await t.moveAndClick(main(p).getByRole("link", { name: /Add building/ }));
      });
      await t.step("Type the building name.", () => t.type(field(p, "name"), NEW_BUILDING));
      await say(t, "Kind: a building, a tower inside a campus, a campus, or a project. Add the campus first, then each tower.", field(p, "asset_kind"));
      await t.step("More details: parent campus, locality, address, grade, area, floors, completion and map pin.", () => unfold(t, "More details"));
      await t.step("Pick the locality, so searches and shortlists by place find it.", async () => {
        const s = field(p, "locality_id"); await t.point(s);
        const v = await s.locator("option", { hasText: /^Kharadi/ }).first().getAttribute("value"); await s.selectOption(v);
      });
      await t.step("Press Create building.", () => t.moveAndClick(main(p).getByRole("button", { name: "Create building" })));
      await say(t, "The building page. The Building section lists its facts; blanks say unknown.", main(p).getByRole("heading", { name: NEW_BUILDING }));
      await t.step("Spaces & availability is empty — nothing is assumed vacant. Add a floor.", async () => {
        await unfold(t, "Spaces & availability"); await openAdd(t, "Add floor / unit");
      });
      await t.step("Floor label is kept as text, like '5' or 'Upper Ground'. Unit is optional.", async () => {
        await t.type(field(p, "floor_text"), "5"); await t.type(field(p, "unit"), "East wing");
      });
      await t.step("More details: carpet and chargeable area, and seats — add if known.", async () => {
        await t.moveAndClick(main(p).locator("form").filter({ hasText: "Add space" }).getByText("More details (optional)"));
        await t.type(field(p, "chargeable_sf"), "24000");
      });
      await t.step("Press Add space.", () => t.moveAndClick(main(p).getByRole("button", { name: "Add space" })));
      await say(t, "Floor 5 appears with 'No availability evidence' — we haven't said it is free yet.", main(p).getByText("No availability evidence").first());
      await t.step("Now record availability: a dated snapshot.", () => openAdd(t, "Record availability"));
      await t.step("Choose the floor and the date you heard it.", async () => {
        const sp = field(p, "space_id"); await t.point(sp);
        await sp.selectOption(await sp.locator("option", { hasText: /Floor 5/ }).first().getAttribute("value"));
        const asOf = main(p).locator("form").filter({ hasText: "Save snapshot" }).locator("[name=as_of]");
        await t.point(asOf); await asOf.fill(iso(new Date()));
      });
      await t.step("Status: available, under offer, leased, withdrawn — or unknown.", () => pick(t, field(p, "status"), "Available (claimed)"));
      await say(t, "Evidence: 'claimed' if the landlord said so, 'verified' only if you checked it now.", field(p, "fact_status"));
      await t.step("More details: available-from, valid-until, and the asking rent.", async () => {
        await t.moveAndClick(main(p).locator("form").filter({ hasText: "Save snapshot" }).getByText("More details (optional)"));
        await t.type(field(p, "asking_rent_min"), "85");
      });
      await t.step("Rent basis says which area the rent is quoted on — carpet, chargeable or per seat.", () => pick(t, field(p, "rent_basis"), "Chargeable"));
      await t.step("Press Save snapshot.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save snapshot" })));
      await say(t, "Floor 5: Available (reported), as of today, asking ₹85/sf on chargeable area.", main(p).getByText(/asking ₹85/));
      await say(t, "Leases, specifications and other names are added the same way, further down.", main(p).getByText("Leases").first());
      await t.outro("added a building, a floor and a dated availability with asking rent and its basis.", "import a spreadsheet.");
    },
  },
  {
    slug: "import-spreadsheet", category: "Records & data", title: "Import a spreadsheet",
    learn: "Upload a sheet, tell CRE OS which column is which (once), then see what was added and which rows need fixing.", tryRoute: "/imports",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Import a spreadsheet", "Upload → map the columns → check problem rows → done.",
        ["Upload a file", "Map unknown columns once", "Read the three-step result", "Fix or dismiss problem rows"]);
      await t.step("Open More in the sidebar, then Imports.", async () => {
        await t.moveAndClick(nav(p).getByRole("button", { name: /More/ }));
        const im = navLink(p, "Imports");
        if (await im.count()) await t.moveAndClick(im); else await t.goto("/imports");
      });
      await say(t, "Earlier uploads are listed with their status and row counts. The original file is kept read-only.", main(p).getByRole("heading", { name: "Imports" }));
      await t.step("Choose your spreadsheet — here a small CSV with three buildings.", async () => {
        await t.point(field(p, "file")); await main(p).locator("input[name=file]").setInputFiles(CSV);
      });
      await say(t, "As-of date: when the data in the file was true. Source: where it came from.", field(p, "source_id"));
      await t.step("Press Upload and reconcile.", () => t.moveAndClick(main(p).getByRole("button", { name: "Upload and reconcile" })));
      await say(t, "The result in three steps: added, needs your OK, could not be imported.", main(p).getByText("Already added to your records"));
      await say(t, "These column names weren't recognised, so the rows wait here — nothing is lost.", main(p).getByText("Could not be imported"));
      await t.step("Open Technical details to map the columns once.", () => t.moveAndClick(main(p).getByText("Technical details (reconciliation, sheets, mapping)")));
      await t.step("What is this sheet? An asset list with a header row.", () => pick(t, main(p).locator("form").filter({ hasText: "Approve mapping" }).locator("select").first(), "Asset inventory (existing / upcoming) — Asset list with header row"));
      await t.step("Match each field to a column: Building name ← Property, Locality ← Micro-market…", async () => {
        const form = main(p).locator("form").filter({ hasText: "Approve mapping" });
        const cols = ["A: Property", "B: Micro-market", "C: Typical floor plate", "D: Size", "E: No. of floors", "F: Stage", "G: Deals"];
        const sels = form.locator("select");
        for (let i = 0; i < cols.length; i++) { const s = sels.nth(i + 1); await t.point(s); await s.selectOption({ label: cols[i] }); }
      });
      await t.step("Press Approve mapping and re-process. Next time this layout imports by itself.", () => t.moveAndClick(main(p).getByRole("button", { name: "Approve mapping and re-process" })));
      await t.step("Done: step 1 shows the buildings and localities now in your records (new, or matched to ones you had).", async () => {
        await t.sleep(3000); await p.reload(); await t.settle?.(); await t.point(main(p).getByText("Already added to your records"));
      });
      await say(t, "Needs your OK: anything that would change an existing record waits for approval.", main(p).getByText("Needs your OK"));
      await say(t, "Rows with a problem list the reason; 'NA' and '0' areas are kept as unknown, never as numbers.", main(p).getByText(/Rows with a problem/));
      await say(t, "Possible duplicates: merge look-alike names or keep them separate.", main(p).getByText("Possible duplicates"));
      await say(t, "Values that differ from your records are never overwritten — they go to Approvals.", main(p).getByText(/Values that differ/));
      await t.outro("uploaded a sheet, mapped its columns and checked what was added.", "create a client requirement.");
    },
  },
  {
    slug: "new-requirement", category: "Records & data", title: "Create a client requirement",
    learn: "Write down what the client needs — area and its basis, places, budget, move-in date — and leave unknowns blank.", tryRoute: "/requirements/new",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Create a client requirement", "Area + basis, locations, budget and timing. Anything you don't know stays blank.",
        ["Who and what", "Size and timing (+ basis, budget)", "Questions to ask the client", "Add a location preference"]);
      await t.step("Open Requirements under Records.", () => t.moveAndClick(navLink(p, "Requirements")));
      await say(t, "Each requirement has a status: draft, estimated, client confirmed, closed. Filter by it here.", field(p, "status"));
      await t.step("Press New requirement.", () => t.moveAndClick(main(p).getByRole("link", { name: "New requirement" })));
      await say(t, "It is saved as an estimate until the client confirms.", main(p).getByText("Saved as an estimate until the client confirms."));
      await t.step("Give it a short title and pick the company — or type a new company name.", async () => {
        await t.type(field(p, "title"), NEW_REQ, 25);
        await pick(t, field(p, "org_id"), "Zentrix Analytics");
      });
      await t.step("Target area and move-in date.", async () => {
        await t.type(field(p, "area_target"), "12000");
        await t.point(field(p, "occupation_date")); await field(p, "occupation_date").fill("2027-06-01");
      });
      await t.step("More details: area range and whether it is carpet or chargeable area.", async () => {
        await t.moveAndClick(main(p).getByText("More details (optional)").nth(1));
        await t.type(field(p, "area_min"), "10000"); await t.type(field(p, "area_max"), "14000");
        await pick(t, field(p, "area_basis"), "Chargeable");
      });
      await say(t, "Also: seats, fit-out standard, decision date, tenure and mandate.", field(p, "seats_target"));
      await say(t, "Budget only if the client said it. We don't know, so it stays blank — unknown.", field(p, "budget_min"));
      await t.step("Press Create requirement.", () => t.moveAndClick(main(p).getByRole("button", { name: "Create requirement" })));
      await say(t, "Top cards: how many mandatory facts are known and how many the client confirmed.", main(p).getByText("Mandatory known"));
      await say(t, "The requirement contract: each field is Estimated, Confirmed or Unknown.", main(p).getByText("Requirement contract"));
      await say(t, "Questions to ask: the gaps, most important first — take this list to your next call.", main(p).getByText(/Questions to ask/));
      await say(t, "Update a field when the client answers, with the source of the answer.", main(p).getByText("Update a field"));
      await t.step("Add where they want to be: Add location preference.", async () => {
        await unfold(t, "Locations & required features");
        await openAdd(t, "Add location preference");
        const loc = field(p, "geography_id"); await t.point(loc);
        const v = await loc.locator("option", { hasText: /^Baner/ }).first().getAttribute("value"); await loc.selectOption(v);
      });
      await say(t, "Preference: preferred, acceptable, must, or excluded.", field(p, "preference"));
      await t.step("Press Add location.", () => t.moveAndClick(main(p).getByRole("button", { name: "Add location" })));
      await say(t, "Baner is now listed. Required features (parking, power…) are added the same way.", main(p).getByText("Locations & required features"));
      await t.outro("created a requirement with area, basis, timing and a location — unknowns left blank.", "run a shortlist for a requirement.");
    },
  },
  {
    slug: "shortlist", category: "Records & data", title: "Run a shortlist for a requirement",
    learn: "Match buildings to a requirement and read why each one fits or doesn't.", tryRoute: "/requirements",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Run a shortlist", "CRE OS matches buildings with dated availability against the requirement — and says why.");
      await t.step("Open Requirements and pick one.", async () => {
        await t.moveAndClick(navLink(p, "Requirements"));
        await t.moveAndClick(main(p).getByRole("link", { name: /Glasswing Retail Tech Centre/ }));
      });
      await say(t, "Hard constraints decide what gets excluded — e.g. the area range and must-have locations.", main(p).getByText(/^Hard constraints/));
      await say(t, "Scroll to Shortlist. If the client hasn't confirmed, the shortlist is marked provisional.", main(p).getByText(/^Shortlist \(match/));
      await t.step("Press Run shortlist.", () => t.moveAndClick(main(p).getByRole("button", { name: /Run shortlist|Re-run shortlist/ })));
      await say(t, "One row per floor or unit, ranked. Eligibility: eligible, needs verification, or ineligible.", main(p).getByText("Needs verification").first());
      await say(t, "Fit score: how well it matches. Data completeness: how much of the needed data is known.", main(p).getByRole("columnheader", { name: "Data completeness" }));
      await say(t, "Flags say what to check: vacancy unverified, stale availability, seat count unknown…", main(p).getByText("Vacancy unverified").first());
      await t.step("Open 'Why it qualifies' to read the matching reasons.", () => t.moveAndClick(main(p).getByText("Why it qualifies").first()));
      await say(t, "Ineligible rows say exactly why — e.g. area outside the range, too few seats.", main(p).getByText("Why it fails").first());
      await t.step("Set each option's status as you go: proposed, shortlisted, visited, rejected, selected.", async () => {
        const st = main(p).locator("select").filter({ has: p.locator("option", { hasText: "shortlisted" }) }).first();
        await t.point(st); await st.selectOption({ label: "shortlisted" });
        await t.moveAndClick(main(p).getByRole("button", { name: "Set" }).first());
      });
      await say(t, "The status is saved on that option; the shortlist count at the top of the page updates.", main(p).getByText(/^Shortlist$/).first());
      await t.outro("ran a shortlist and read why each building matches.", "move a deal through its stages.");
    },
  },
  {
    slug: "deal-pipeline", category: "Records & data", title: "Move a deal through stages",
    learn: "Move an opportunity to its next stage with a reason, and see what blocks a stage (an unconfirmed requirement, checklist items).", tryRoute: "/deals",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Move a deal through stages", "Each move needs a reason. Some later stages wait for checklist items.");
      await t.step("Open Deals under Records: every opportunity, in columns by stage.", () => t.moveAndClick(navLink(p, "Deals")));
      await say(t, "'Show lost / dormant' brings back closed deals. New opportunity is at the bottom.", main(p).getByRole("link", { name: "Show lost / dormant" }));
      await t.step("Open a deal in Research — Marigold Loop.", () => t.moveAndClick(main(p).getByRole("link", { name: /Marigold Loop — Pune office opportunity/ }).first()));
      await say(t, "Top cards: expected fee (a forecast), then invoiced, recognised and collected — real money only.", main(p).getByText("Expected gross fee"));
      await say(t, "The stage bar: green = done, blue = now, grey = still to come.", main(p).getByText("Research", { exact: true }).first());
      await t.step("Move to: the next stage is already chosen — Approach attempted.", async () => {
        await p.reload(); await p.waitForLoadState("networkidle"); await pick(t, field(p, "stage"), "Approach attempted");
      });
      await t.step("Add a reason. Later stages require one; it is kept in the stage history.", () => t.type(field(p, "evidence"), MARIGOLD_NOTE, 22));
      await t.step("Press Move stage.", () => t.moveAndClick(main(p).getByRole("button", { name: "Move stage" })));
      await say(t, "Moved: the deal is now in Approach attempted.", main(p).getByText(/· Approach attempted ·/));
      await say(t, "Stage history keeps every move with its reason.", main(p).getByText(MARIGOLD_NOTE).first());
      await say(t, "Labels & outcome: temperature, mandate, next action and expected close; set won/lost here too.", main(p).getByText("Labels & outcome"));
      await say(t, "Closing checklist: items 'needed before' a stage block it until done (with proof) or waived.", main(p).getByText(/Closing checklist/));
      await say(t, "Fees: each amount has its own status — a forecast never counts as invoiced or collected.", main(p).getByText(/^Fees \(gross/));
      await t.step("Some moves are blocked. Back to Deals, open Kestrelbay Payments.", async () => {
        await t.moveAndClick(navLink(p, "Deals"));
        await t.moveAndClick(main(p).getByRole("link", { name: new RegExp(DEAL) }).first());
      });
      await t.step("Try Requirement confirmed, with a reason, and press Move stage.", async () => {
        await pick(t, field(p, "stage"), "Requirement confirmed");
        await t.type(field(p, "evidence"), STAGE_NOTE, 18);
        await t.moveAndClick(main(p).getByRole("button", { name: "Move stage" }));
      });
      await say(t, "Blocked: the linked requirement must be client-confirmed first. It is still 'estimated'.", main(p).getByText(/stage change blocked/));
      await t.step("Open the requirement to confirm its facts with the client first.", () => t.moveAndClick(main(p).getByRole("link", { name: DEAL }).first()));
      await say(t, "Client confirmation lists what the client still has to confirm.", main(p).getByText("Client confirmation").first());
      await t.step("Changes from captures, imports or the official CRM wait in Review for your OK.", () => t.moveAndClick(navLink(p, "Review")));
      await t.outro("moved a deal to its next stage with evidence and saw what can block a stage.", "check the lease radar.");
    },
  },
  {
    slug: "lease-radar", category: "Records & data", title: "Lease radar: expiries, lock-ins and notice deadlines",
    learn: "See which leases expire soon, when lock-ins end and by when notice must be given.", tryRoute: "/leases",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Lease radar", "Upcoming expiries, lock-ins and notice deadlines — the moments to call a client.");
      await t.step("Open More in the sidebar, then Lease radar.", async () => {
        await t.moveAndClick(nav(p).getByRole("button", { name: /More/ }));
        await t.moveAndClick(navLink(p, "Lease radar"));
      });
      await say(t, "Verified dates come from the lease; 'calculated by radar' dates are formulas, never treated as verified.", main(p).getByText(/Contractual \/ confirmed dates/));
      await say(t, "Buckets: needs review, notice in 90 days, expiring in 0–3, 3–12, 12–24 months…", main(p).getByRole("link", { name: /Expiring in 3–12 months/ }));
      await say(t, "…expired but not confirmed, and dates unknown. Each shows how many leases are in it.", main(p).getByRole("link", { name: /Dates unknown/ }));
      await t.step("Start with notice deadlines in the next 90 days — the most urgent.", () => t.moveAndClick(main(p).getByRole("link", { name: /Notice deadline within 90 days/ })));
      await say(t, "Each lease: tenant, building, landlord, area, and a call-window status.", main(p).getByText(/Call window/).first());
      await say(t, "Expiry, lock-in end and notice-by, each with days left.", main(p).getByText("NOTICE BY").first());
      await say(t, "Under each date: where it came from — contractual, or calculated (formula shown).", main(p).getByText(/Calculated by radar/).first());
      await say(t, "Reverse plan: working back from the move date — warns when the decision date has passed.", main(p).getByText(/Reverse plan/).first());
      await t.step("See all leases, then search one tenant, building or landlord.", async () => {
        await t.moveAndClick(main(p).getByRole("link", { name: /^All leases/ }));
        await t.type(main(p).getByPlaceholder("Tenant, building or landlord"), "Zentrix"); await p.keyboard.press("Enter");
      });
      await say(t, "Click the tenant to open the company and act on it.", main(p).getByRole("link", { name: "Zentrix Analytics" }).first());
      await t.outro("checked upcoming expiries, lock-ins and notice deadlines.", "search everything.");
    },
  },
  {
    slug: "search-everything", category: "Records & data", title: "Search everything",
    learn: "One search box for companies, people, buildings, leases, meetings, documents — narrow it with type and filters.", tryRoute: "/search",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Search everything", "Companies, people, leases, meetings, documents… in one place, with filters.");
      await t.step("Click Search at the top of the sidebar.", async () => {
        await t.moveAndClick(p.getByRole("link", { name: /^Search/ }).or(p.getByPlaceholder(/^Search/)));
        if (!/\/search/.test(p.url())) await t.goto("/search");
      });
      await say(t, "Two modes: Search everything (words), and Find accounts (describe companies you want).", main(p).getByRole("link", { name: "Find accounts" }));
      await t.step("Type a word — here a company name — and press Search.", async () => {
        await t.type(field(p, "q"), "Zentrix");
        await t.moveAndClick(main(p).getByRole("button", { name: "Search", exact: true }));
      });
      await say(t, "Results of every type: lease, company, signal, requirement, meetings…", main(p).getByRole("link", { name: /Zentrix Analytics — Kharadi/ }));
      await say(t, "Each keeps its status — reported, confirmed or hypothesis are never mixed.", main(p).getByText("Reported", { exact: true }).first());
      await say(t, "You only see what your access allows.", main(p).getByText(/Results are filtered by your access/));
      await t.step("Narrow it: choose a type — Lease.", async () => {
        const s = field(p, "type"); await t.point(s);
        const v = await s.locator("option", { hasText: /^Lease/ }).first().getAttribute("value"); await s.selectOption(v);
      });
      await t.step("More filters: place, from/to dates, status and source.", async () => {
        await t.moveAndClick(main(p).getByText(/More filters/));
        await t.type(field(p, "place"), "Kharadi");
      });
      await t.step("Press Search — only leases in Kharadi remain.", () => t.moveAndClick(main(p).getByRole("button", { name: "Search", exact: true })));
      await say(t, "Click any result to open it.", main(p).locator("a").filter({ hasText: /Kharadi/ }).first());
      await t.outro("searched everything, then filtered by type and place.", "browse the database and places.");
    },
  },
  {
    slug: "database-places", category: "Records & data", title: "Browse the database and places (micro-markets)",
    learn: "See how many records you have, what needs review, and the place hierarchy: city › corridor › micro-market › locality.", tryRoute: "/database",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("The database and places", "Counts of everything you hold, and the places buildings and requirements point to.");
      await t.step("Open More, then Database.", async () => {
        await t.moveAndClick(nav(p).getByRole("button", { name: /More/ }));
        const db = navLink(p, "Database");
        if (await db.count()) await t.moveAndClick(db); else await t.goto("/database");
      });
      await say(t, "Counts of every record type: companies, people, buildings, spaces, requirements…", main(p).getByRole("link", { name: /^Companies/ }));
      await say(t, "…opportunities, leases, interactions, source files and imports in progress. Click one to open its list.", main(p).getByRole("link", { name: /^Source files/ }));
      await say(t, "Needs review lists import rows waiting for a decision.", main(p).getByText(/^Needs review/));
      await say(t, "Recent changes: who changed what — the full audit log is one click away.", main(p).getByText("Recent changes"));
      await t.step("Now places: open Places in the More menu.", async () => {
        const g = navLink(p, "Places");
        if (await g.count()) await t.moveAndClick(g); else await t.goto("/geography");
      });
      await say(t, "Places nest: city › corridor › micro-market › locality.", main(p).getByText(/City › Corridor/));
      await say(t, "Pune is the city; East corridor holds the SBD East micro-market and its localities.", main(p).getByText("East corridor").first());
      await say(t, "Each place keeps other spellings, so 'KP' or 'Vimannagar' still match.", main(p).getByText(/also: KP/));
      await t.step("Search a place by any of its names.", async () => {
        await t.type(main(p).getByPlaceholder("Search place or other name…"), "SBD"); await p.keyboard.press("Enter");
      });
      await say(t, "Add place (at the bottom) creates a new one with its level, parent and other names.", main(p).getByText(/Add place/).first());
      await t.outro("browsed record counts, recent changes and the place hierarchy.", "add a company by hand.");
    },
  },
];

module.exports = { FLOWS, prepare, finish };
