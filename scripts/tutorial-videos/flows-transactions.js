// Tutorial videos — group "transactions": Module 16 Transaction Execution & Negotiation (/transactions).
// Demo data: setup-transactions.ts (run in prepare): "Lumen Harbour Tech — Kharadi 20k SF (tutorial)", mid-negotiation, synthetic.
// Every run archives earlier "(tutorial)" transactions and rebuilds the demo one. All maths is code (Deal toolkit formulas);
// nothing is sent externally — messages are drafts. Captions describe only what is on screen.
const { WS, sql, runSetup, main, field, start, side, soft, choose, fill, submit, sleep } = require("./new-modules-common");

const CAT = "Deal toolkit";
const TX_NAME = "Lumen Harbour Tech — Kharadi 20k SF (tutorial)";
const txId = () => sql(`select id from mudar.tx_transaction where workspace_id='${WS}' and name='${TX_NAME}' and archived_at is null order by created_at desc limit 1`);
const sec = (p, id) => main(p).locator(`section#${id}`);
/** Jump to a workspace section with the chip bar at the top of the transaction page. */
async function jump(t, id, label) {
  const p = t.page;
  const chip = main(p).getByRole("navigation", { name: "Workspace sections" }).getByRole("link", { name: new RegExp(label) }).first();
  if (await chip.isVisible().catch(() => false)) { await chip.scrollIntoViewIfNeeded().catch(() => {}); await t.moveAndClick(chip); await sleep(500); }
  const h = sec(p, id).getByRole("heading").first(); await h.scrollIntoViewIfNeeded().catch(() => {}); await t.point(h);
}
/** Open the demo transaction from the Transactions list. */
async function openTx(t) {
  const p = t.page;
  await side(t, "Transactions");
  const link = main(p).getByRole("link", { name: new RegExp(TX_NAME.replace(/[—()]/g, ".")) }).first();
  if (await link.isVisible().catch(() => false)) await t.moveAndClick(link); else await t.goto(`/transactions/${txId()}`);
  await p.waitForURL(/\/transactions\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {});
}
async function openMore(t, scope, label) {
  const s = scope.locator("summary", { hasText: label }).first();
  const open = await s.evaluate((el) => el.parentElement.open).catch(() => false);
  if (open) await t.point(s); else await t.moveAndClick(s);
  await sleep(400);
}
const sel = (scope, name) => scope.locator(`[name="${name}"]`).filter({ visible: true }).first();

function prepare() { console.log(" setup-transactions:", runSetup("setup-transactions.ts")); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. create + stage plan
  {
    slug: "tx-create", category: CAT, title: "Create a transaction and its stage plan",
    learn: "Create a transaction for a confirmed requirement: name, type (conventional, managed office, coworking, renewal, relocation, build-to-suit, investment), requirement, deal, properties, expected completion, priority and template. It gets a unique code and a stage plan for its type.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Create a transaction", "When a client's requirement is confirmed, a transaction runs it through to handover.");
      await t.step("Open Transactions from the sidebar, under Work.", () => side(t, "Transactions"));
      await t.step("The list: each transaction's name, code, type, status, priority and current stage.", () => soft(t, main(p).getByText(/TX-\d{6}-/).first()));
      await t.step("New transaction: give it a name.", () => fill(t, field(p, "name"), "Quillstone — Hinjewadi 12k SF (tutorial)"));
      await t.step("Choose the type. Each type has its own stage plan — renewal starts with an existing-lease review, investment includes due diligence.", () => choose(t, field(p, "tx_type"), "Relocation"));
      await t.step("Link the confirmed requirement and the deal, so client positions and matching properties come along.", async () => {
        await choose(t, field(p, "requirement_id"), "Nimbus Ledger — Pune office (demo) (client_confirmed)"); await choose(t, field(p, "opportunity_id"), "Nimbus Ledger — Pune office (demo)");
      });
      await t.step("Properties under consideration, separated by commas, and the expected completion date.", async () => {
        await fill(t, field(p, "properties"), "Hinjewadi Phase 2 Business Centre (demo)"); await field(p, "expected_completion").fill("2027-03-31"); await t.point(field(p, "expected_completion"));
      });
      await t.step("More details: priority and a workflow template if you made your own.", async () => { await t.moveAndClick(main(p).locator("summary", { hasText: "More details" }).first()); await choose(t, field(p, "priority"), "high"); });
      await t.step("Create transaction.", async () => { await submit(t, main(p).getByRole("button", { name: "Create transaction" })); await p.waitForURL(/\/transactions\/[0-9a-f-]{36}/, { timeout: 30000 }); });
      await t.step("It gets a unique code (TX-…), its type, status and current stage.", () => t.point(main(p).getByRole("heading", { level: 1 }).first()));
      await t.step("The chips jump to each of the 16 sections: overview, requirements, property, offers, negotiation, inspections, issues, stakeholders, approvals, LOI, legal, deposits, execution, possession, handover and closure.", () => t.point(main(p).getByRole("navigation", { name: "Workspace sections" })));
      await t.step("Transaction overview: the stage plan for a relocation. The first stage is in progress; press start or mark done as work moves on.", () => jump(t, "overview", "1\\. Transaction overview"));
      await t.step("Mark the first stage done — the next one becomes current.", () => submit(t, sec(p, "overview").getByRole("button", { name: "mark done" }).first()));
      await t.step("Client requirements were copied from the client-confirmed requirement — only confirmed fields, nothing guessed.", () => jump(t, "requirements", "2\\. Client requirements"));
      await t.step("Back on the list, Workflow templates let you change the stages for a type, or add a new type. Existing transactions keep their stages.", async () => { await side(t, "Transactions"); await soft(t, main(p).getByRole("heading", { name: /^Workflow templates/ })); });
      await t.outro("created a transaction with its own code and stage plan.", "record offers and counteroffers.");
    },
  },

  // ------------------------------------------------------------------ 2. offers + comparison
  {
    slug: "tx-offers", category: CAT, title: "Offers and counteroffers: versions and package comparison",
    learn: "Every offer and counteroffer is a new version linked to the one it answers, with a reason; nothing is overwritten. See the changes between versions and compare any two as complete packages (rent, CAM, rent-free, deposit) with fixed formulas.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Offers and counteroffers", "Every version kept, every change explained — compare whole packages, not just rent.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 4, Offers and counteroffers.", () => jump(t, "offers", "4\\. Offers"));
      await t.step("v1 came from the landlord; v2 is the client's counter with its reason; v3 is the landlord's counter. Each version answers the one before.", () => t.point(sec(p, "offers").locator("table").first()));
      await t.step("Responses: v1 and v2 are countered; v3 is pending. An offer past its valid-until date is marked expired.", () => soft(t, sec(p, "offers").getByText("pending").first()));
      await t.step("Changes between versions: what got better or worse from one version to the next.", () => openMore(t, sec(p, "offers"), "Changes between versions"));
      await t.step("Compare two versions as whole packages: choose v1 as A and v3 as B.", async () => { await choose(t, sel(sec(p, "offers"), "a"), "v1"); await choose(t, sel(sec(p, "offers"), "b"), "v3"); });
      await t.step("Compare packages.", () => submit(t, sec(p, "offers").getByRole("button", { name: "Compare packages" })));
      await t.step("The verdict. Lower headline rent alone never wins — if inputs like commencement or a discount rate are missing, it says it cannot determine.", () => soft(t, sec(p, "offers").locator("div.rounded").filter({ hasText: /Better in B|cannot|Missing/ }).first()));
      await t.step("Better in B, worse in B, what is missing, the assumptions and what is not modelled.", () => soft(t, sec(p, "offers").getByText(/^Missing:/).first()));
      await t.step("Record the client's answer: open Record offer / counteroffer.", () => openMore(t, sec(p, "offers"), "Record offer / counteroffer"));
      await t.step("Counter to v3, from the client, with the reason for the change.", async () => {
        const s = sec(p, "offers"); await choose(t, sel(s, "parent"), "v3"); await choose(t, sel(s, "offering_party"), "client"); await fill(t, sel(s, "reason"), "Accept ₹95 if CAM stays at ₹15");
      });
      await t.step("Enter the terms that change. Blank stays unknown — never zero.", async () => { const s = sec(p, "offers"); await fill(t, sel(s, "t_rentPerSf"), "95"); await fill(t, sel(s, "t_camPerSf"), "15"); await fill(t, sel(s, "t_areaSf"), "20000"); });
      await t.step("Save new version. v4 appears; v3 becomes countered.", () => submit(t, sec(p, "offers").getByRole("button", { name: "Save new version" })));
      await t.step("Intake: paste a proposal, LOI or report. Terms are extracted for your review before anything becomes a record.", () => soft(t, sec(p, "offers").locator("summary", { hasText: "Intake a proposal" })));
      await t.outro("compared offer versions as packages and recorded a counteroffer.", "keep client, adviser and landlord positions apart.");
    },
  },

  // ------------------------------------------------------------------ 3. three positions + points
  {
    slug: "tx-positions", category: CAT, title: "Three positions: client, adviser and counterparty",
    learn: "What the client requires, what you recommend and what the landlord proposes are kept in separate columns and never merged. Agreed values come only from the point tracker, with evidence.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Three positions", "Client requirement, adviser recommendation and counterparty proposal — never mixed up.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 2 compares the three positions for each term.", () => jump(t, "requirements", "2\\. Client requirements"));
      await t.step("Rent: the client requires ₹92, you recommend ₹94, the landlord proposes ₹95. Agreed stays blank — a proposal is never an agreed term.", () => soft(t, sec(p, "requirements").locator("tr").filter({ hasText: "Rent ₹/SF/month" }).first()));
      await t.step("Area, lock-in and duration are agreed — they were confirmed with evidence.", () => soft(t, sec(p, "requirements").locator("tr").filter({ hasText: "Lock-in" }).first()));
      await t.step("Record a position: choose whose position it is and the term.", async () => { const s = sec(p, "requirements"); await choose(t, sel(s, "kind"), "adviser recommendation"); await choose(t, sel(s, "term"), "CAM ₹/SF/month"); });
      await t.step("The value, and the source — every position needs one.", async () => { const s = sec(p, "requirements"); await fill(t, sel(s, "value"), "16"); await fill(t, sel(s, "source"), "Adviser view — CAM benchmarks"); });
      await t.step("Record.", () => submit(t, sec(p, "requirements").getByRole("button", { name: "Record" })));
      await t.step("Section 5, the point tracker: each term's value and status — proposed, under negotiation, agreed, documented, verified.", () => jump(t, "negotiation", "5\\. Commercial negotiations"));
      await t.step("Agreed is not the same as documented or verified against the executed agreement. Agreeing needs evidence.", () => soft(t, sec(p, "negotiation").locator("tbody tr").filter({ hasText: "Lock-in" }).first()));
      await t.step("Mark rent-free as Agreed, with the evidence.", async () => {
        const row = sec(p, "negotiation").locator("tr").filter({ hasText: "Rent-free" }).first();
        await choose(t, row.locator('[name="status"]'), "Agreed"); await fill(t, row.locator('[name="evidence"]'), "Landlord email confirming 2 months");
        await submit(t, row.getByRole("button", { name: "Save" }));
      });
      await t.step("Rent-free is now agreed. An agreed value is never overwritten — a change creates a new version.", () => soft(t, sec(p, "negotiation").locator("tr").filter({ hasText: "Rent-free" }).first()));
      await t.outro("kept the three positions apart and agreed a term with evidence.", "track issues and their dependencies.");
    },
  },

  // ------------------------------------------------------------------ 4. issues + dependencies
  {
    slug: "tx-issues", category: CAT, title: "Open issues, owners and dependencies",
    learn: "Every unresolved issue has an owner, a next action and a due date (or a reason for none). Blocking and overdue issues show at the top; dependencies show what waits on what; a task is created for each issue.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Issues and dependencies", "Who owns each problem, what happens next, and what is waiting on it.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("At the top: open issues — one overdue and one blocking — and a red line naming what is blocking progress.", () => soft(t, main(p).getByText(/^Blocking:/).first()));
      await t.step("Section 7, Open issues.", () => jump(t, "issues", "7\\. Open issues"));
      await t.step("CAM increase unexplained: blocking, owned by you, the landlord's rep is responsible, next action and due date — overdue.", () => soft(t, sec(p, "issues").locator("tr").filter({ hasText: "CAM increase" }).first()));
      await t.step("Signage rights depends on the CAM issue, and records why it has no due date.", () => soft(t, sec(p, "issues").locator("tr").filter({ hasText: "Signage" }).first()));
      await t.step("Raise a new issue: title, category and the next action.", async () => {
        await openMore(t, sec(p, "issues"), "Raise issue"); const s = sec(p, "issues");
        await fill(t, sel(s, "title"), "Parking count short by 5"); await choose(t, sel(s, "category"), "technical"); await fill(t, sel(s, "next_action"), "Ask landlord for 5 more car parks");
      });
      await t.step("A due date — or a reason why there is none — plus who is responsible and whether it blocks progress.", async () => {
        const s = sec(p, "issues"); await sel(s, "due_date").fill("2026-11-25"); await t.point(sel(s, "due_date")); await fill(t, sel(s, "responsible"), "Landlord PM");
        await t.moveAndClick(s.getByText("blocks progress"));
      });
      await t.step("It can depend on other open issues. Raise.", async () => { const s = sec(p, "issues"); await sel(s, "depends_on").selectOption({ label: "CAM increase unexplained" }); await submit(t, s.getByRole("button", { name: "Raise" })); });
      await t.step("Update an issue's status. Resolving needs a resolution note.", async () => {
        const row = sec(p, "issues").locator("tr").filter({ hasText: "CAM increase" }).first();
        await choose(t, row.locator('[name="status"]'), "resolved"); await fill(t, row.locator('[name="resolution"]'), "CAM breakup received; ₹18 agreed");
        await submit(t, row.getByRole("button", { name: "Save" }));
      });
      await t.step("Next actions & route to completion: the list updates — blocking and overdue items first.", async () => { await main(p).getByRole("heading", { name: /^Next actions/ }).scrollIntoViewIfNeeded(); await t.point(main(p).getByRole("heading", { name: /^Next actions/ })); });
      await t.outro("raised an issue with a dependency and resolved another.", "record inspections and document requests.");
    },
  },

  // ------------------------------------------------------------------ 5. inspections + document requests
  {
    slug: "tx-inspections-docs", category: CAT, title: "Inspections, clarifications and document requests",
    learn: "Record site inspections with findings and concerns, ask the landlord clarifications that are checked against the client's requirement (discrepancies flagged), and request documents — received is not the same as verified.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Inspections and documents", "What you saw on site, what you asked, and which papers are still missing.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 6, Technical inspections & clarifications.", () => jump(t, "inspections", "6\\. Technical inspections"));
      await t.step("The MEP walk-through: date, findings and the concern still open — the fire NOC copy.", () => soft(t, sec(p, "inspections").getByText(/MEP walk-through/)));
      await t.step("Clarifications are checked against the client's requirement: 150 kVA was needed, 120 kVA offered — a discrepancy.", () => soft(t, sec(p, "inspections").getByText("discrepancy").first()));
      await t.step("Answer the parking question: the landlord says 40 car parks.", async () => {
        const row = sec(p, "inspections").locator("tr").filter({ hasText: "car parks" }).first();
        const inp = row.locator("input:not([type=hidden])").filter({ visible: true });
        await fill(t, inp.first(), "40"); if (await inp.count() > 1) await inp.nth(1).fill("40");
        await submit(t, row.getByRole("button", { name: "Save" }));
      });
      await t.step("40 matches the requirement, so it is accepted.", () => soft(t, sec(p, "inspections").locator("tr").filter({ hasText: "car parks" }).first()));
      await t.step("Record inspection / request clarification holds both forms.", () => openMore(t, sec(p, "inspections"), "Record inspection"));
      await t.step("Section 11 lists document requests. The occupancy certificate is requested from the landlord.", () => jump(t, "legal", "11\\. Legal documents"));
      await t.step("When it arrives, enter the file or link and press Received.", async () => {
        const li = sec(p, "legal").locator("li").filter({ hasText: "Occupancy certificate" }).first();
        await fill(t, li.locator('[name="file_ref"]'), "Email from landlord PM — OC.pdf"); await submit(t, li.getByRole("button", { name: "Received" }));
      });
      await t.step("Received is not verified. After checking the original, say how you verified it and press Verify.", async () => {
        const li = sec(p, "legal").locator("li").filter({ hasText: "Occupancy certificate" }).first();
        await fill(t, li.locator('[name="note"]'), "Original sighted at landlord office"); await submit(t, li.getByRole("button", { name: "Verify" }));
      });
      await t.step("Request another document: type, title, who is responsible and when it is due.", async () => {
        const s = sec(p, "legal"); await fill(t, sel(s, "doc_type"), "title"); await fill(t, s.locator('[name="title"]').filter({ visible: true }).last(), "Title deed extract");
      });
      await t.outro("recorded clarifications and moved a document from requested to verified.", "manage the stakeholders.");
    },
  },

  // ------------------------------------------------------------------ 6. stakeholders
  {
    slug: "tx-stakeholders", category: CAT, title: "Stakeholders and their pending actions",
    learn: "List everyone involved — internal and external — with their role, decision authority, pending actions, issues and approvals, and whether they are blocking. Assign actions as tasks; external people are never messaged automatically.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Stakeholders", "Who is involved, who decides, and who we are waiting on.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 8, Stakeholders.", () => jump(t, "stakeholders", "8\\. Stakeholders"));
      await t.step("Each person: organisation, internal or external, role, decision authority, pending actions, issues, approvals and whether they block.", () => t.point(sec(p, "stakeholders").locator("table").first()));
      await t.step("Rohan, the landlord's leasing representative, is blocking: he owns an overdue issue and has an action pending.", () => soft(t, sec(p, "stakeholders").locator("tr").filter({ hasText: "Rohan" }).first()));
      await t.step("Add a stakeholder: name, category — here the client's decision maker — and organisation.", async () => {
        await openMore(t, sec(p, "stakeholders"), "Add stakeholder"); const s = sec(p, "stakeholders");
        await fill(t, sel(s, "name"), "Arjun Rao (demo)"); await choose(t, sel(s, "category"), "client decision maker");
        await fill(t, sel(s, "organisation"), "Lumen Harbour Tech (demo)");
      });
      await t.step("Add it.", () => submit(t, sec(p, "stakeholders").locator("form").filter({ has: p.locator('[name="name"]') }).getByRole("button").first()));
      await t.step("Assign an action to a stakeholder. It becomes a task for you to chase — nothing is sent to them.", async () => {
        await openMore(t, sec(p, "stakeholders"), "Add stakeholder"); const f = sec(p, "stakeholders").locator("form").filter({ has: p.locator('[name="stakeholder"]') }).first();
        await choose(t, f.locator('[name="stakeholder"]'), "Neha Iyer (demo)"); await fill(t, f.locator('[name="title"]'), "Approve deposit release"); await submit(t, f.getByRole("button").first());
      });
      await t.step("Neha now shows one pending action. External messages are drafts only — you send them yourself.", () => soft(t, sec(p, "stakeholders").locator("tr").filter({ hasText: "Neha" }).first()));
      await t.outro("added a stakeholder and assigned a pending action.", "agree terms in the LOI and term sheet.");
    },
  },

  // ------------------------------------------------------------------ 7. LOI / term sheet / commercial points
  {
    slug: "tx-loi-points", category: CAT, title: "LOI, term sheet and agreed commercial points",
    learn: "Add LOI and term-sheet versions (numbered clauses). Each version is checked against the agreed points and differences are listed. Move document status from draft to agreed and signed.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("LOI and term sheet", "Each version is checked against the terms you actually agreed.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 10, LOI and term sheet. LOI v1 is a draft, unsigned.", () => jump(t, "loi", "10\\. LOI"));
      await t.step("It is checked against the agreed terms: lease duration was agreed at 60 months but is not in the LOI.", () => soft(t, sec(p, "loi").getByText(/Differs from agreed terms/).first()));
      await t.step("Add a version: an updated LOI with the duration clause.", async () => {
        await openMore(t, sec(p, "loi"), "Add a version"); const s = sec(p, "loi");
        await choose(t, sel(s, "doc_kind"), "loi"); await fill(t, sel(s, "title"), "LOI");
        await fill(t, sel(s, "body"), "1. Premises: 20,000 sq ft chargeable on Floor 6.\n2. Rent: base rent of ₹ 95 per sq ft per month.\n3. Security deposit of 5 months.\n4. Lock-in of 36 months.\n5. Term of 60 months.");
      });
      await t.step("Save version. The same title makes it version 2 of the same document; v1 is kept.", () => submit(t, sec(p, "loi").getByRole("button", { name: "Save version" })));
      await t.step("LOI v2 is compared with v1 — clauses added, removed or changed — and with the agreed terms.", () => soft(t, sec(p, "loi").getByText(/vs previous/).first()));
      await t.step("Move its status along: draft, submitted, client review, counterparty review, agreed, signed, executed.", async () => {
        const row = sec(p, "loi").locator("div.border-b").filter({ hasText: "LOI v2" }).first(); await choose(t, row.locator('[name="status"]'), "client_review"); await submit(t, row.getByRole("button").last());
      });
      await t.step("A term sheet is added the same way — choose term sheet as the type.", () => soft(t, sec(p, "loi").locator("summary", { hasText: "Add a version" })));
      await t.step("The point tracker (section 5) holds the agreed values these documents are checked against.", () => jump(t, "negotiation", "5\\. Commercial negotiations"));
      await t.outro("added an LOI version and checked it against agreed terms.", "compare agreement versions and approve.");
    },
  },

  // ------------------------------------------------------------------ 8. agreement compare + approvals
  {
    slug: "tx-agreement-approvals", category: CAT, title: "Agreement versions, clause changes and approvals",
    learn: "Agreement versions get a clause-by-clause diff and a check against agreed terms. Approvals are tied to the exact version: a new version invalidates the old approval and opens a reassessment. Only the assigned reviewer decides; legal approval only by the legal reviewer.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Agreement versions and approvals", "What changed between drafts — and approvals that stick to the exact version.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 11: the Leave & licence agreement has two versions.", () => jump(t, "legal", "11\\. Legal documents"));
      await t.step("v2 against v1: one clause added, one removed, one modified — and financial terms changed.", () => soft(t, sec(p, "legal").getByText(/vs previous/).first()));
      await t.step("Differs from agreed terms: rent is ₹100 in the document, though nothing at ₹100 was agreed; lock-in is missing.", () => soft(t, sec(p, "legal").getByText(/Differs from agreed terms/).first()));
      await t.step("Clause changes shows each clause before (red) and after.", () => openMore(t, sec(p, "legal"), "Clause changes"));
      await t.step("Section 9, Approvals. The legal approval of v1 was invalidated when v2 arrived — it no longer counts.", () => jump(t, "approvals", "9\\. Approvals"));
      await t.step("A reassessment was opened on v2, assigned to you as legal reviewer. Each approval stores the version's fingerprint.", () => soft(t, sec(p, "approvals").locator("tr").filter({ hasText: "pending" }).first()));
      await t.step("Decide: ask for changes, with a comment.", async () => {
        const row = sec(p, "approvals").locator("tr").filter({ hasText: "pending" }).first();
        await choose(t, row.locator('[name="decision"]'), "changes requested"); await fill(t, row.locator('[name="comments"]'), "Rent must be ₹95; restore the lock-in clause");
        await submit(t, row.getByRole("button", { name: "Decide" }));
      });
      await t.step("Request another approval: choose its category — client commercial, financial, legal, landlord and more — and what it covers.", async () => {
        await openMore(t, sec(p, "approvals"), "Request approval"); await t.point(sel(sec(p, "approvals"), "category"));
      });
      await t.step("Messages stating commercial terms need a live client approval of the current position. They are saved as drafts — you send them.", () => soft(t, sec(p, "approvals").getByText(/Messages stating commercial terms/)));
      await t.outro("compared agreement versions and decided a version-bound approval.", "record deposits, execution and handover.");
    },
  },

  // ------------------------------------------------------------------ 9. deposits / execution / possession / handover
  {
    slug: "tx-execution-handover", category: CAT, title: "Deposits, execution, possession and handover",
    learn: "Track each deposit stage separately (approved, due, paid with evidence, acknowledged with a receipt). Record execution milestones — agreed, legally approved, signed, executed, possession, occupied and handover are separate facts with evidence — then fit-out and the handover checklist.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Deposits, execution and handover", "Due is not paid, signed is not executed, possession is not handover.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Section 12, deposits: the security deposit is approved and due, but not paid.", () => jump(t, "financial", "12\\. Financial information"));
      await t.step("Record payment: stage paid, the date and the evidence — the bank reference. Paid without evidence is refused.", async () => {
        const row = sec(p, "financial").locator("tbody tr").first();
        await choose(t, row.locator('[name="stage"]'), "paid"); await row.locator('[name="date"]').fill("2026-11-12"); await fill(t, row.locator('[name="evidence"]'), "UTR HDFC0001234 (demo)");
        await submit(t, row.getByRole("button").last());
      });
      await t.step("Paid — acknowledgement still needs the landlord's receipt.", () => soft(t, sec(p, "financial").locator("tbody tr").first()));
      await t.step("Section 13, Execution milestones: each one has its own date and evidence. Nothing is inferred from another.", () => jump(t, "execution", "13\\. Execution milestones"));
      await t.step("Record 'commercially agreed' with today's date and the evidence.", async () => {
        const row = sec(p, "execution").locator("tbody tr").first();
        await row.locator('[name="achieved_on"]').fill("2026-11-12"); await t.point(row.locator('[name="achieved_on"]'));
        await fill(t, row.locator('[name="evidence"]'), "Client CFO email approving terms"); await submit(t, row.getByRole("button").last());
      });
      await t.step("Executed needs an executed agreement document. When it is recorded, the lease is handed to Leases automatically.", () => soft(t, sec(p, "execution").locator("tr").filter({ hasText: /Executed/ }).first()));
      await t.step("Section 14, Possession and fit-out: scope, contractor, dates, progress and approvals.", async () => {
        await jump(t, "possession", "14\\. Possession"); const s = sec(p, "possession");
        await fill(t, sel(s, "scope"), "Full fit-out, 180 seats"); await fill(t, sel(s, "contractor"), "BuildCo (demo)"); await submit(t, s.getByRole("button").last());
      });
      await t.step("Section 15, Handover: generate the checklist when possession approaches.", async () => { await jump(t, "handover", "15\\. Handover"); await submit(t, sec(p, "handover").getByRole("button", { name: "Generate checklist" })); });
      await t.step("Each item is open until closed with evidence. Add defects too — seepage near the pantry, for the landlord to fix.", async () => {
        const s = sec(p, "handover"); await choose(t, sel(s, "kind"), "defect"); await fill(t, sel(s, "description"), "Seepage near pantry"); await fill(t, sel(s, "responsible"), "landlord");
        await submit(t, s.locator("form").filter({ has: p.locator('[name="kind"]') }).getByRole("button").first());
      });
      await t.step("Close an item with its evidence and who acknowledged it.", async () => {
        const li = sec(p, "handover").locator("li").filter({ has: p.getByRole("button", { name: "Done" }) }).first();
        await fill(t, li.locator('[name="evidence"]'), "Photo + PM sign-off"); await fill(t, li.locator('[name="ack"]'), "Landlord PM"); await submit(t, li.getByRole("button", { name: "Done" }));
      });
      await t.outro("tracked the deposit, a milestone, fit-out and the handover checklist.", "generate the closure pack.");
    },
  },

  // ------------------------------------------------------------------ 10. closure pack + lease hand-off
  {
    slug: "tx-closure", category: CAT, title: "Closure pack, completion and the lease hand-off",
    learn: "Generate the closure pack (Word) at any time. Completion stays blocked while issues, approvals, documents, deposits or handover items are open. When the agreement is executed, the lease is handed to Leases so its dates are tracked.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Closure pack and completion", "Close the transaction only when everything is really done.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("Closure blockers at the top counts what still stops completion.", () => soft(t, main(p).getByText("Closure blockers").first()));
      await t.step("Section 16, Closure pack. 'Completion blocked' lists every reason: open issues, pending approvals, unverified documents, unpaid deposits, handover not completed.", () => jump(t, "closure", "16\\. Closure pack"));
      await t.step("Mark transaction complete stays disabled until the list is empty.", () => soft(t, sec(p, "closure").getByRole("button", { name: "Mark transaction complete" })));
      await t.step("Generate closure pack (.docx): terms, milestones, approvals, documents and open items, as they stand.", () => submit(t, sec(p, "closure").getByRole("button", { name: /Generate closure pack/ })));
      await t.step("The pack appears as a link with its version and date. Generate again later for a new version — old ones are kept.", () => soft(t, sec(p, "closure").getByRole("link", { name: /Closure pack v/ }).first()));
      await t.step("Execution milestones show the Lease Lifecycle hand-off once the executed agreement is recorded — the lease then appears under Leases.", () => jump(t, "execution", "13\\. Execution milestones"));
      await t.step("The timeline at the bottom is append-only: every offer, change, approval and milestone with its time.", async () => { const h = main(p).getByRole("heading", { name: /^Timeline/ }); await h.scrollIntoViewIfNeeded(); await t.point(h); });
      await t.outro("generated the closure pack and saw what blocks completion.", "check the command view each morning.");
    },
  },

  // ------------------------------------------------------------------ 11. command view
  {
    slug: "tx-command-view", category: CAT, title: "The transaction command view",
    learn: "The top of a transaction: agreed and disputed terms, open, overdue and blocking issues, pending approvals, outstanding documents and closure blockers; next actions with reasons and due dates; the route to completion, dependencies and upcoming deadlines.",
    tryRoute: "/transactions",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("The command view", "Where this transaction stands and what to do next — in one screen.");
      await t.step("Open Transactions and the Lumen Harbour Tech transaction.", () => openTx(t));
      await t.step("The header: name, code, type, status, current stage and links to the deal and requirement.", () => t.point(main(p).getByRole("heading", { level: 1 }).first()));
      await t.step("Agreed terms, with how many are still disputed.", () => soft(t, main(p).getByText("Agreed terms").first()));
      await t.step("Open issues, with how many are overdue and blocking.", () => soft(t, main(p).getByText("Open issues").first()));
      await t.step("Pending approvals, outstanding documents and closure blockers.", () => soft(t, main(p).getByText("Pending approvals").first()));
      await t.step("The red line names what is blocking right now.", () => soft(t, main(p).getByText(/^Blocking:/).first()));
      await t.step("Next actions: blocking and overdue first, each with why and when it is due.", () => t.point(main(p).getByRole("heading", { name: /^Next actions/ })));
      await t.step("Open Route to completion: every remaining step, the dependencies between items and the upcoming deadlines.", () => openMore(t, main(p), "Route to completion"));
      await t.step("Each of the 16 sections below holds the detail; the timeline keeps the full history.", () => t.point(main(p).getByRole("navigation", { name: "Workspace sections" })));
      await t.step("You can also ask Ask AI, for example: what is the latest agreed rent? Answers come from these records.", () => soft(t, main(p).getByRole("heading", { name: /^Next actions/ })));
      await t.outro("read the command view: status, blockers, next actions and route.", "work through the sections from offers to closure.");
    },
  },
];

module.exports = { FLOWS, prepare };
