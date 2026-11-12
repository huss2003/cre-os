// Tutorial videos — group "leases": Module 15 Lease Lifecycle (dashboard, new lease, critical dates + human confirmation,
// escalation, renewals + renew-vs-relocate, termination + handover, obligations, calendar, portfolio).
// Demo data: setup-leases.ts (run in prepare; synthetic tenants Lumen Harbour Tech, Peregrine Loom Studios, Quillstone Labs;
// references TUT-LEASE-A/B/C are rebuilt on every run so each video starts from the same state).
// Captions describe only what is on screen. Dates are calculated by code; nothing here uses AI.
const { WS, sql, runSetup, nav, main, field, start, side, soft, card, showCard, subTab, choose, fill, submit, sleep } = require("./new-modules-common");

const CAT = "Records & data";
const leaseId = (ref) => sql(`select id from mudar.lease where workspace_id='${WS}' and reference='${ref}' and archived_at is null order by created_at desc limit 1`);
/** Open a demo lease from the Leases list (search box), falling back to its URL. */
async function openLease(t, tenant, ref) {
  const p = t.page;
  await side(t, "Leases");
  await fill(t, field(p, "q"), tenant.replace(/ \(demo\)$/, ""));
  await submit(t, main(p).getByRole("button", { name: "Filter" }).first());
  const link = main(p).getByRole("link", { name: tenant }).first();
  if (await link.isVisible().catch(() => false)) await t.moveAndClick(link); else await t.goto(`/leases/${leaseId(ref)}`);
  await p.waitForURL(/\/leases\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {});
}
/** One row of the Important dates list. */
const dateRow = (p, label) => card(p, "Important dates").locator("li").filter({ has: p.locator("strong", { hasText: label }) }).first();

function prepare() { console.log(" setup-leases:", runSetup("setup-leases.ts")); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. dashboard
  {
    slug: "leases-dashboard", category: CAT, title: "Leases: the lease dashboard and its filters",
    learn: "Open Leases: headline counts, filters by status, category, event and window, the upcoming milestones list, the lease table and the tabs for calendar, renewals, obligations, portfolio and radar.",
    tryRoute: "/leases",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("The lease dashboard", "Every lease you manage, its important dates and what still needs checking.");
      await t.step("Open Leases from the sidebar, under Work.", () => side(t, "Leases"));
      await t.step("The tabs: Leases (this dashboard), Calendar, Renewals, Obligations, Portfolio and Radar — the old lease radar now lives here.", () => t.point(main(p).getByRole("link", { name: "Radar", exact: true }).first()));
      await t.step("The headline counts: active leases, expiries in the next 12 months, renewal deadlines, escalations, lock-in completions, break options and pending obligations.", () => soft(t, main(p).getByText("Active leases").first()));
      await t.step("They count only confirmed dates. Dates awaiting review are counted separately because they are not yet contractual deadlines.", () => soft(t, main(p).getByText("Dates awaiting review").first()));
      await t.step("Filter by lifecycle status: draft, under negotiation, executed, active, renewal under discussion, termination notice served, expired and more.", () => t.point(field(p, "status")));
      await t.step("Filter by category: conventional office, managed office, coworking, retail or industrial.", () => t.point(field(p, "category")));
      await t.step("Filter by event type and time window — for example lock-in completions in the next 90 days.", async () => { await choose(t, field(p, "type"), "Lock-in completion"); await choose(t, field(p, "days"), "Next 90 days"); });
      await t.step("Press Filter.", () => submit(t, main(p).getByRole("button", { name: "Filter" }).first()));
      await t.step("Upcoming milestones lists each confirmed date with the lease and how many days are left.", () => soft(t, main(p).getByRole("heading", { name: /^Upcoming milestones/ })));
      await t.step("Widen the window to the next 365 days and clear the event filter to see everything coming up.", async () => { await choose(t, field(p, "type"), "Any event"); await choose(t, field(p, "days"), "Next 365 days"); await submit(t, main(p).getByRole("button", { name: "Filter" }).first()); });
      await t.step("The milestones now include expiries and renewal notice deadlines for the demo leases.", () => soft(t, main(p).getByRole("heading", { name: /^Upcoming milestones/ })));
      await t.step("Below is every lease: tenant, property, category, status and what it still Needs — for example rent or a confirmed expiry.", async () => { const h = main(p).getByRole("heading", { name: /^Leases/ }).last(); await h.scrollIntoViewIfNeeded(); await t.point(h); });
      await t.step("Search finds a lease by tenant, landlord or building.", () => fill(t, field(p, "q"), "Lumen Harbour"));
      await t.step("Filter, then open the lease to see its details.", async () => { await submit(t, main(p).getByRole("button", { name: "Filter" }).first()); await t.moveAndClick(main(p).getByRole("link", { name: "Lumen Harbour Tech (demo)" }).first()); });
      await t.step("The lease page: overview, important dates, terms, financials, documents, obligations, renewal, termination, reminders and history.", () => t.point(main(p).getByRole("heading", { level: 1 }).first()));
      await t.outro("found leases by status, event and date window and opened one.", "add a lease and attach its agreement.");
    },
  },

  // ------------------------------------------------------------------ 2. add a lease
  {
    slug: "lease-add", category: CAT, title: "Add a lease and attach the agreement",
    learn: "Create a lease (tenant, landlord, property, category, status, rent, area and optional details), then paste the executed agreement so dates, terms and obligations are extracted by code with page references.",
    tryRoute: "/leases/new",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Add a lease", "Create the record, then attach the agreement — dates are read with page references.");
      await t.step("Open Leases from the sidebar.", () => side(t, "Leases"));
      await t.step("Press New lease.", () => t.moveAndClick(main(p).getByRole("link", { name: "New lease" }).first()));
      await t.step("New leases always start as draft or negotiation. Executed and active need evidence: a signed agreement and confirmed dates.", () => soft(t, main(p).getByText(/Leases start as draft/)));
      await t.step("Choose the tenant company. If it is not a company record yet, type its name in the box below instead.", () => choose(t, field(p, "tenant_org_id"), "Quillstone Labs (demo)"));
      await t.step("Choose the landlord and the property. Unknown is allowed — nothing is guessed.", async () => { await choose(t, field(p, "landlord_org_id"), "Harbourline Estates (demo)"); await choose(t, field(p, "asset_id"), "Kharadi Tech Park (demo)"); });
      await t.step("Category and status: a conventional office lease, under negotiation.", async () => { await choose(t, field(p, "category"), "Conventional office lease"); await choose(t, field(p, "status"), "Under negotiation"); });
      await t.step("Monthly rent and area, if you know them. Leave a field blank when unknown — it is never treated as zero.", async () => { await fill(t, field(p, "rent"), "900000"); await fill(t, field(p, "area"), "15000"); });
      await t.step("More details (optional): reference, micro-market, floor, unit, dates, area basis, CAM, parking, deposit, term, lock-in and escalation.", async () => {
        await t.moveAndClick(main(p).locator("summary", { hasText: "More details" }).first());
        await fill(t, field(p, "reference"), "TUT-LEASE-NEW"); await fill(t, field(p, "micro_market"), "Kharadi"); await fill(t, field(p, "floor"), "7");
      });
      await t.step("Create lease.", async () => { await submit(t, main(p).getByRole("button", { name: "Create lease" })); await p.waitForURL(/\/leases\/[0-9a-f-]{36}/, { timeout: 30000 }); });
      await t.step("The lease page opens with status Under negotiation. No dates yet — they come from the agreement.", () => soft(t, card(p, "Important dates")));
      await t.step("Documents: give the agreement a title and choose its type and execution state.", async () => {
        const c = card(p, "Documents"); await c.scrollIntoViewIfNeeded();
        await fill(t, c.locator('[name="title"]'), "Lease deed draft"); await choose(t, c.locator('[name="doc_type"]'), "lease agreement"); await choose(t, c.locator('[name="execution_state"]'), "draft");
      });
      await t.step("Paste the text (PDFs and scans go through Capture first). A draft is never treated as executed.", () => fill(t, card(p, "Documents").locator('[name="text"]'),
        "LEASE DEED (DRAFT)\n1.1 The term of the lease shall be 60 months commencing on 1st April 2027 (the Commencement Date).\n1.2 The lease shall expire on 31st March 2032 unless renewed.\n3.1 The lock-in period shall be 24 months from the Commencement Date."));
      await t.step("Attach & extract. Code reads the clauses — no AI is needed for dates.", () => submit(t, card(p, "Documents").getByRole("button", { name: "Attach & extract" })));
      await t.step("Important dates now lists commencement, expiry and lock-in, each with the source clause and page.", () => t.point(card(p, "Important dates").getByRole("heading").first()));
      await t.step("Because the document is a draft, every date is marked Needs review — a person must check it before it counts.", () => soft(t, card(p, "Important dates").getByText(/Needs review/).first()));
      await t.outro("created a lease and attached its agreement so the dates were extracted.", "confirm the critical dates after checking the clause.");
    },
  },

  // ------------------------------------------------------------------ 3. critical dates + human confirmation
  {
    slug: "lease-critical-dates", category: CAT, title: "Critical lease dates: check the clause and confirm",
    learn: "Each lease date shows the source clause, page, calculation method and status (calculated, needs review, conflicting, confirmed). Only a person's confirmation makes it a contractual deadline, which then creates reminders.",
    tryRoute: "/leases",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Critical dates and human confirmation", "Only dates a person has checked become contractual deadlines.");
      await t.step("Open the Lumen Harbour Tech lease from Leases. Its executed deed is already attached.", () => openLease(t, "Lumen Harbour Tech (demo)", "TUT-LEASE-A"));
      await t.step("The note at the top: extracted clauses are shown word for word with page numbers. They are summaries, not legal advice.", () => soft(t, main(p).getByText(/Extracted clauses are shown verbatim/)));
      await t.step("Important dates: execution, commencement, lock-in, escalations, break option, notice deadlines and expiry.", () => showCard(t, "Important dates"));
      await t.step("Confirmed contractual deadline: someone checked it against the signed deed. Commencement and expiry are confirmed here.", () => soft(t, dateRow(p, "Lease commencement").getByText(/Confirmed contractual deadline/)));
      await t.step("Lock-in completion: Calculated — not verified. It shows the method — 36 months from 1 Jan 2024, minus one day.", () => t.point(dateRow(p, "Lock-in completion")));
      await t.step("And the exact clause it came from, with the document and page number.", () => soft(t, dateRow(p, "Lock-in completion").locator("blockquote")));
      await t.step("A warning: lock-in completion alone does not allow termination — the notice clause still applies.", () => soft(t, dateRow(p, "Lock-in completion").getByText(/does not by itself permit termination/)));
      await t.step("Checked it against the deed? Add a review note and press Confirm after review.", async () => {
        const r = dateRow(p, "Lock-in completion");
        await fill(t, r.getByRole("textbox", { name: "Review note" }), "Checked clause 3.1 on page 2");
        await submit(t, r.getByRole("button", { name: "Confirm after review" }));
      });
      await t.step("It is now a Confirmed contractual deadline, with today's date and your note.", () => soft(t, dateRow(p, "Lock-in completion").getByText(/Confirmed/).first()));
      await t.step("Break option says Needs review: its conditions (a break fee) must be checked, so you must pick the date yourself.", () => t.point(dateRow(p, "Break option")));
      await t.step("Reject removes a wrong date; Add or calculate a date lets you enter one by hand or calculate it from a clause.", () => soft(t, main(p).locator("summary", { hasText: "Add or calculate a date" })));
      await t.step("Reminders are created only from confirmed dates — here, ahead of the lock-in completion. They appear in the app; nothing is sent outside.", () => showCard(t, "Reminders"));
      await t.step("The activity timeline records who confirmed what, and when.", () => showCard(t, "Activity timeline"));
      await t.outro("checked a date's source clause and confirmed it as a contractual deadline.", "check rent escalations against what was paid.");
    },
  },

  // ------------------------------------------------------------------ 4. escalation
  {
    slug: "lease-escalation", category: CAT, title: "Rent escalation: expected vs actual",
    learn: "Confirm the terms extracted from the deed, then see the escalation schedule (dates and expected rent, calculated by code) checked against the rent actually recorded.",
    tryRoute: "/leases",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Rent escalation", "When the rent goes up, by how much — and whether what was paid matches.");
      await t.step("Open the Lumen Harbour Tech lease from Leases.", () => openLease(t, "Lumen Harbour Tech (demo)", "TUT-LEASE-A"));
      await t.step("In Important dates, each escalation shows its date and the expected new rent: 15% every 36 months on the last paid rent.", () => soft(t, dateRow(p, /Rent escalation 1/)));
      await t.step("Commercial terms: current values next to the original version 1. Unknown terms are simply not listed.", () => showCard(t, "Commercial terms"));
      await t.step("Version 2 was extracted from the deed and is Proposed: it adds the escalation, the term and the lock-in.", () => soft(t, card(p, "Commercial terms").locator("li").filter({ hasText: /proposed/ }).first()));
      await t.step("Nothing extracted replaces the terms by itself. After checking, press Confirm as current.", () => submit(t, card(p, "Commercial terms").getByRole("button", { name: "Confirm as current" }).first()));
      await t.step("Version 2 is now current; version 1 is kept as history.", () => soft(t, card(p, "Commercial terms").locator("li").filter({ hasText: /v2/ }).first()));
      await t.step("Financials: rent, CAM, parking and other costs a month. Unknown items say unknown — they are not counted as zero.", () => showCard(t, "Financials"));
      await t.step("The escalation table: each step, its effective date, the expected rent, the actual rent recorded and a check.", () => soft(t, card(p, "Financials").locator("table").last()));
      await t.step("Step 1 matches: ₹13.8 lakh was recorded after January 2027. A different amount would show a discrepancy.", () => soft(t, card(p, "Financials").getByText(/match/).first()));
      await t.step("Record a payment or actual value adds rent or CAM paid. Payment status comes only from these records.", () => soft(t, main(p).locator("summary", { hasText: "Record a payment" })));
      await t.step("Record an amendment adds new terms with an effective date — the old terms stay in the history.", () => soft(t, main(p).locator("summary", { hasText: "Record an amendment" })));
      await t.outro("confirmed extracted terms and checked escalations against recorded rent.", "start a renewal review.");
    },
  },

  // ------------------------------------------------------------------ 5. renewals
  {
    slug: "lease-renewals", category: CAT, title: "Renewal pipeline and renew vs relocate",
    learn: "Leases expiring within 12 months appear on Renewals. Start a renewal review on the lease (a task is created), move it through the stages, see alternative spaces from recorded supply, and compare staying with moving in the Deal toolkit.",
    tryRoute: "/leases/renewals",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Renewals", "Expiry is a conversation to start — not proof the tenant will move or renew.");
      await t.step("Open Leases, then the Renewals tab.", async () => { await side(t, "Leases"); await subTab(t, "Renewals"); });
      await t.step("Upcoming renewals: leases that expire within 12 months and have no renewal record yet. Peregrine Loom Studios expires on 30 June 2027.", () => soft(t, card(p, /^Upcoming renewals/)));
      await t.step("Open it.", () => t.moveAndClick(card(p, /^Upcoming renewals/).getByRole("link", { name: /Peregrine Loom/ }).first()));
      await t.step("The renewal notice deadline is 30 December 2026 — six months before expiry, from clause 4.2 on page 3.", () => soft(t, dateRow(p, "Renewal notice deadline")));
      await t.step("In the Renewal section press Start renewal review. A review task is created for you.", () => submit(t, card(p, "Renewal").getByRole("button", { name: "Start renewal review" })));
      await t.step("The review starts at stage upcoming. Record the stage, the tenant's and the landlord's responses and a note.", async () => {
        const c = card(p, "Renewal");
        await choose(t, c.locator('[name="stage"]'), "Discussion");
        await fill(t, c.locator('[name="tenant_response"]'), "Open to renewing if rent stays flat");
        await fill(t, c.locator('[name="note"]'), "Call with facilities head");
      });
      await t.step("Update. Every change is logged with the date.", () => submit(t, card(p, "Renewal").getByRole("button", { name: "Update" })));
      await t.step("When your recorded supply has similar spaces, 'Possible alternatives' appears here too — useful if the client may relocate.", async () => {
        const alt = card(p, "Renewal").getByText("Possible alternatives");
        if (await alt.isVisible().catch(() => false)) await t.point(alt); else await t.point(card(p, "Renewal").getByRole("heading").first());
      });
      await t.step("Back on Renewals, the lease now sits in the Discussion column. Other columns: proposals pending, negotiation, agreed, completed and at risk.", async () => { await subTab(t, "Renewals"); await p.waitForURL(/\/leases\/renewals/, { timeout: 30000 }).catch(() => {}); await sleep(1200); await soft(t, card(p, /^Discussion/)); });
      await t.step("To compare staying with moving, open Deal toolkit → Stay or move: rent, overlap, moving costs and deposits, worked out by fixed formulas.", async () => { await side(t, "Deal toolkit"); await soft(t, main(p).getByRole("link", { name: /Stay or move/ })); });
      await t.outro("started a renewal review, tracked its stage and looked at alternatives.", "record a termination and the handover checklist.");
    },
  },

  // ------------------------------------------------------------------ 6. termination + handover
  {
    slug: "lease-termination", category: CAT, title: "Termination and the handover checklist",
    learn: "Start a termination (reason, notice date, notice period wording, proposed date), update its status, deposit recovered and settlement, then work through the handover checklist — each item needs evidence.",
    tryRoute: "/leases",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Termination and handover", "Record the notice, track the deposit and close out the handover.");
      await t.step("Open the Quillstone Labs lease from Leases. It expires on 31 March 2027.", () => openLease(t, "Quillstone Labs (demo)", "TUT-LEASE-C"));
      await t.step("Scroll to Termination & handover.", () => showCard(t, "Termination & handover"));
      await t.step("Lock-in completion alone does not permit termination — check the notice and termination conditions first.", () => soft(t, card(p, "Termination & handover").getByText(/Lock-in completion alone/)));
      await t.step("Enter the reason, the date notice was served and the notice period exactly as the clause words it.", async () => {
        const c = card(p, "Termination & handover");
        await fill(t, c.locator('[name="reason"]'), "Consolidating into Hinjewadi campus");
        await c.locator('[name="notice_date"]').fill("2026-09-30"); await t.point(c.locator('[name="notice_date"]'));
        await fill(t, c.locator('[name="notice_period"]'), "not less than six (6) months prior");
      });
      await t.step("And the proposed termination date. Press Start termination.", async () => {
        const c = card(p, "Termination & handover");
        await c.locator('[name="proposed_date"]').fill("2027-03-31"); await t.point(c.locator('[name="proposed_date"]'));
        await submit(t, c.getByRole("button", { name: "Start termination" }));
      });
      await t.step("The termination shows the notice and proposed dates. The confirmed date stays 'not confirmed' until you enter it.", () => soft(t, card(p, "Termination & handover").getByText(/not confirmed/)));
      await t.step("Later, record the confirmed date, deposit recovered, status and settlement, then Update.", async () => {
        const c = card(p, "Termination & handover");
        await c.locator('[name="confirmed_date"]').fill("2027-03-31"); await t.point(c.locator('[name="confirmed_date"]'));
        await fill(t, c.locator('[name="deposit_recovered"]'), "5000000");
        await choose(t, c.locator('[name="status"]'), "In settlement");
        await submit(t, c.getByRole("button", { name: "Update" }).first());
      });
      await t.step("Create handover checklist adds the standard items: inspection, repair and restoration, utilities, access cards, keys and more.", () => submit(t, card(p, "Termination & handover").getByRole("button", { name: "Create handover checklist" })));
      await t.step("Each item is pending until you mark it Done with evidence — for example who received the keys.", async () => {
        const c = card(p, "Termination & handover"); const item = c.locator("li").filter({ has: p.getByRole("button", { name: "Done" }) }).first();
        await fill(t, item.locator('[name="evidence"]'), "Keys handed to landlord"); await submit(t, item.getByRole("button", { name: "Done" }));
      });
      await t.step("Add your own checklist item if something is missing.", async () => {
        const c = card(p, "Termination & handover");
        await fill(t, c.locator('[name="label"]'), "Return parking stickers"); await submit(t, c.getByRole("button", { name: "Add", exact: true }).last());
      });
      await t.step("The lease can be marked terminated only when the termination date is confirmed and every handover item is done or not applicable.", () => soft(t, card(p, "Overview").getByRole("button", { name: "Change status" })));
      await t.outro("recorded a termination, the deposit and the handover checklist.", "track obligations across all leases.");
    },
  },

  // ------------------------------------------------------------------ 7. obligations
  {
    slug: "lease-obligations", category: CAT, title: "Lease obligations: who must do what",
    learn: "Obligations are extracted from the agreement with page references (or added by hand) and tracked on the lease and on the Obligations tab, filtered by status and responsible party.",
    tryRoute: "/leases/obligations",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Lease obligations", "Insurance, repairs, reinstatement — who is responsible, by when, and from which clause.");
      await t.step("Open the Lumen Harbour Tech lease from Leases.", () => openLease(t, "Lumen Harbour Tech (demo)", "TUT-LEASE-A"));
      await t.step("Obligations: each one shows the category, the clause text, the responsible party, the deadline, the status and the source page.", () => showCard(t, "Obligations"));
      await t.step("They were read from the deed: insurance, structural repairs, no sub-letting, restoring the premises. Unclear responsibility is shown as unclear.", () => soft(t, card(p, "Obligations").locator("tbody tr").first()));
      await t.step("Mark one Done with the evidence — for example the insurance policy number.", async () => {
        const row = card(p, "Obligations").locator("tbody tr").filter({ hasText: /^\s*insurance/ }).filter({ has: p.getByRole("button", { name: "Done" }) }).first();
        await fill(t, row.locator('[name="evidence"]'), "Policy no. DEMO-123"); await submit(t, row.getByRole("button", { name: "Done" }));
      });
      await t.step("Add an obligation by hand: category, what must be done, who is responsible and the deadline.", async () => {
        const c = card(p, "Obligations");
        await fill(t, c.locator('[name="category"]'), "reporting"); await fill(t, c.locator('[name="description"]'), "Send fire-safety certificate to landlord");
        await choose(t, c.locator('[name="responsible"]'), "Tenant"); await c.locator('[name="deadline"]').fill("2027-01-15");
        await submit(t, c.getByRole("button", { name: "Add", exact: true }));
      });
      await t.step("Now open the Obligations tab: every lease's obligations in one tracker.", () => subTab(t, "Obligations"));
      await t.step("Source-linked summaries — not legal advice. Filter by status and by party: tenant, landlord, shared or unclear.", async () => { await choose(t, field(p, "status"), "Open"); await choose(t, field(p, "responsible"), "Tenant"); });
      await t.step("Filter.", () => submit(t, main(p).getByRole("button", { name: "Filter" })));
      await t.step("The list shows the open tenant obligations, with the lease each belongs to.", () => soft(t, main(p).locator("table, ul").first()));
      await t.outro("tracked lease obligations, marked one done with evidence and added one.", "see every date on the lease calendar.");
    },
  },

  // ------------------------------------------------------------------ 8. calendar
  {
    slug: "lease-calendar", category: CAT, title: "The lease calendar",
    learn: "The Calendar tab lists lease milestones between two dates, filtered by lease, company, property and event type. It shows confirmed dates; tick Include unverified to see the rest, clearly labelled.",
    tryRoute: "/leases/calendar",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Lease calendar", "Every lease date in one list — confirmed first, unverified only when you ask.");
      await t.step("Open Leases, then the Calendar tab.", async () => { await side(t, "Leases"); await subTab(t, "Calendar"); });
      await t.step("The count at the top: milestones in the date range, confirmed only.", () => soft(t, main(p).getByText(/milestones/).first()));
      await t.step("Choose the dates: from and to.", () => t.point(field(p, "from")));
      await t.step("Narrow it to one lease, one company or one property.", () => t.point(field(p, "lease")));
      await t.step("Or one event type — for example lease expiry.", () => choose(t, field(p, "type"), "Lease expiry"));
      await t.step("Show.", () => submit(t, main(p).getByRole("button", { name: "Show" })));
      await t.step("Grouped by month: each date, its type and the lease — here the demo leases' expiries.", () => soft(t, main(p).locator("section li").filter({ hasText: /Quillstone|Peregrine/ }).first()));
      await t.step("Tick Include unverified to add calculated and needs-review dates. They keep their label so you never mistake them for deadlines.", async () => {
        await choose(t, field(p, "type"), "All events"); await t.moveAndClick(main(p).getByText("Include unverified")); await submit(t, main(p).getByRole("button", { name: "Show" }));
      });
      await t.step("Assigned to me shows only leases you look after.", () => soft(t, main(p).getByText("Assigned to me")));
      await t.outro("filtered lease milestones by date, lease and event type.", "see the whole portfolio.");
    },
  },

  // ------------------------------------------------------------------ 9. portfolio
  {
    slug: "lease-portfolio", category: CAT, title: "The lease portfolio",
    learn: "Portfolio totals use only known, compatible values: active leases, leased area, monthly and annual rent, expiries, deadlines and obligations — and list which leases were left out and why.",
    tryRoute: "/leases/portfolio",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Lease portfolio", "Totals from known values only — missing data is listed, never counted as zero.");
      await t.step("Open Leases, then the Portfolio tab.", async () => { await side(t, "Leases"); await subTab(t, "Portfolio"); });
      await t.step("Aggregates use only known, compatible values. Missing data is listed, never treated as zero.", () => soft(t, main(p).getByText(/Aggregates use only known/)));
      await t.step("The tiles: active leases, leased area, monthly and annual rent, expiries, renewal deadlines, escalations, lock-ins, terminations and obligations.", () => soft(t, main(p).getByText("Active leases").first()));
      await t.step("Under each total: how many leases were included and how many excluded.", () => soft(t, main(p).getByText(/included,/).first()));
      await t.step("By status: how many leases are draft, active, expiring and so on.", () => soft(t, main(p).getByRole("heading", { name: "By status" })));
      await t.step("Excluded from totals, and leases with incomplete information: each one says what is missing — for example rent or a confirmed expiry.", () => soft(t, main(p).getByRole("heading", { name: /incomplete information/ })));
      await t.step("Filter by category, micro-market or your own leases.", async () => { await fill(t, field(p, "mm"), "Kharadi"); await submit(t, main(p).getByRole("button", { name: "Filter" })); });
      await t.step("The totals now cover Kharadi leases only.", () => soft(t, main(p).getByText("Active leases").first()));
      await t.outro("read portfolio totals and saw which leases were left out and why.", "open a lease to fill in what is missing.");
    },
  },
];

module.exports = { FLOWS, prepare };
