// Tutorial videos — group "ai": Ask AI & automation + Review & settings. Captions describe only what is on screen (mock AI).
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { BASE, sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const WS = "de000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000001";
const ZENTRIX_ID = "db898560-1396-5fc1-b121-4bec23da7315", ANANYA_ID = "dc09713c-84ef-5bc7-b214-2e3b3529738f", VIKRAM_ID = "1fc4a8c7-1432-5694-b87d-a48d6e142297";
const FILES = "/tmp/ai-tut";
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", q], { stdio: "pipe" }).toString();
const leaseChain = (mode) => execFileSync("npx", ["tsx", "--require", "./scripts/assistant-evals.preload.cjs", "--env-file=.env.local",
  "scripts/tutorial-videos/workflow-demo.ts", mode], { cwd: ROOT, stdio: "pipe", timeout: 120000 });

const ZENTRIX = "Zentrix Analytics";
const nav = (p) => p.getByRole("navigation", { name: "Main" }).first();
const navLink = (p, name) => nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
const main = (p) => p.locator("main");
/** Section tab above the page (e.g. Ask AI → Memory). */
/** Point at something if it is on screen; otherwise just let the caption play. */
async function optPoint(t, loc) { const l = loc.filter({ visible: true }).first(); if (await l.isVisible().catch(() => false)) await t.point(l); else console.log("    [miss] optional pointer"); }
const tab = (p, name) => p.getByRole("link", { name, exact: true });

/** Demo memories (reset every run so correct / verify / restrict / forget always have something to act on). */
function resetDemoState() {
  const ents = `'${ZENTRIX_ID}','${ANANYA_ID}','${VIKRAM_ID}'`;
  sql(`update mudar.assistant_memory set supersedes_id=null, superseded_by_id=null where workspace_id='${WS}' and entity_id in (${ents});
       delete from mudar.assistant_memory where workspace_id='${WS}' and entity_id in (${ents});`);
  const mem = (n, cat, et, eid, content, stated, conf, daysAgo) =>
    `('a1000000-0000-4000-8000-00000000000${n}','${WS}','${OWNER}','${cat}','${et}','${eid}','${ZENTRIX_ID}',$$${content}$$,'user','{"scope":"general"}',${stated},${conf},now()-interval '${daysAgo} days',(now()+interval '120 days')::date)`;
  sql(`insert into mudar.assistant_memory (id,workspace_id,owner_user_id,category,entity_type,entity_id,org_context_id,content,source,source_ref,stated,confidence,captured_at,review_at) values
    ${mem(1, "person", "person", ANANYA_ID, "Ananya prefers short emails with at most three options.", true, 0.8, 40)},
    ${mem(2, "company", "organisation", ZENTRIX_ID, "Zentrix needs CFO sign-off before signing any lease.", true, 0.8, 25)},
    ${mem(3, "person", "person", VIKRAM_ID, "Vikram may be leaving Zentrix next year.", false, 0.5, 10)},
    ${mem(4, "requirement", "organisation", ZENTRIX_ID, "Zentrix asked for buildings near the Kharadi metro station.", true, 0.8, 200)}`);
  // Saved command + morning brief start switched off
  sql(`delete from mudar.assistant_command where workspace_id='${WS}' and name='Review my priority accounts';
       update mudar.assistant_brief_setting set enabled=false, opted_in_at=null, next_run_at=null where workspace_id='${WS}' and owner_user_id='${OWNER}';`);
  sql(`delete from mudar.assistant_morning_brief where workspace_id='${WS}' and brief_date=(now() at time zone 'Asia/Kolkata')::date`);
  sql(`update mudar.assistant_setting set budget_inr=3000 where workspace_id='${WS}'`); // may not exist; caught below
}

/** Synthetic files used on screen (unique each run: capture de-duplicates identical uploads). */
async function makeFiles(browser) {
  fs.mkdirSync(FILES, { recursive: true });
  const ref = Date.now();
  const page = await browser.newPage();
  const pg = (n, body) => `<div style="page-break-after:always;font:15px serif;padding:40px"><h3>Page ${n}</h3>${body}</div>`;
  await page.setContent(`<html><body>
${pg(1, "<h2>LEAVE AND LICENSE AGREEMENT (DEMO — SYNTHETIC)</h2><p>This agreement is made at Pune between Kharadi Tech Park Developers (Licensor) and Zentrix Analytics Pvt Ltd (Licensee).</p><p>Premises: Level 5, Tower B, Kharadi Tech Park (demo), Kharadi, Pune.</p><p>Chargeable area: 18,500 sq ft.</p>")}
${pg(2, "<p>Term: 5 years.</p><p>Commencement date: 7 September 2022.</p><p>Expiry date: 7 September 2027.</p><p>Monthly rent: INR 85 per sq ft per month on chargeable area.</p><p>Escalation: 15% every 3 years.</p><p>Lock-in period: 36 months from commencement.</p><p>Notice period: 6 months written notice.</p>")}
${pg(3, `<p>Security deposit: 6 months' rent, interest free.</p><p>Car parking: 20 covered slots.</p><p>Renewal option: one further term of 5 years at the Licensee's option.</p><p>Ref: L-${ref}</p>`)}
</body></html>`);
  await page.pdf({ path: `${FILES}/zentrix-lease.pdf`, format: "A4" });
  await page.setContent(`<div style="font:15px sans-serif;padding:40px"><h2>Commercial quotation (DEMO — synthetic)</h2><p>Building: Kharadi Riverside Towers (demo), Kharadi, Pune</p><p>Landlord: Riverside Realty (demo)</p><p>Available: Floor 7, 26,000 sq ft chargeable, warm shell</p><p>Quoted rent: INR 92 per sq ft per month</p><p>CAM: INR 14 per sq ft per month</p><p>Security deposit: 6 months</p><p>Available from: 1 February 2027</p><p>Quote valid until: 31 December 2026</p><p>Ref: Q-${ref}</p></div>`);
  await page.pdf({ path: `${FILES}/riverside-quote.pdf`, format: "A4" });
  await page.setViewportSize({ width: 900, height: 560 });
  await page.setContent(`<div style="width:860px;height:520px;background:linear-gradient(#cfe3f7,#eef3f8);font:22px sans-serif;display:flex;align-items:flex-end;padding:30px;box-sizing:border-box"><div style="background:#8a9bb0;width:300px;height:380px;margin-right:30px"></div><div style="background:#6f8297;width:220px;height:300px"></div><span style="margin-left:20px;color:#333">Kharadi Riverside Towers (demo) · ${ref}</span></div>`);
  await page.screenshot({ path: `${FILES}/riverside-photo.png` });
  await page.close();
}

async function prepare(browser) {
  try { resetDemoState(); } catch (e) { /* assistant_setting may be absent — the rest already ran */ }
  await makeFiles(browser);
}

/** Restore tutorial records (lease / requirement) other videos rely on, and remove the automation run. */
function finish() {
  try { leaseChain("cleanup"); } catch {}
  execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/tutorial-videos/setup-demo.ts"], { cwd: ROOT, stdio: "pipe", timeout: 300000 });
}

/** Type a question in the chat box (page or side panel) and wait for the answer to finish. */
async function ask(t, root, q, waitFor) {
  await t.type(root.getByPlaceholder(/Ask about your accounts/), q, 30);
  await t.moveAndClick(root.getByRole("button", { name: "Ask", exact: true }));
  await root.getByText(waitFor).first().waitFor({ timeout: 120000 });
  await sleep(1200);
}

const FLOWS = [
  // ------------------------------------------------------------------ Ask AI & automation
  {
    slug: "ai-on-record", category: "Ask AI & automation", title: "Ask AI about the record you're looking at",
    learn: "Open Ask AI from any company page: the side panel already knows which record you are on, answers from it and shows its sources.", tryRoute: "/companies",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Ask AI about the record on screen", "The Ask AI side panel knows which company, person or deal you are looking at.");
      await t.step("Open Companies from the sidebar.", () => t.moveAndClick(navLink(p, "Companies")));
      await t.step("Search for the company — here, Zentrix Analytics.", async () => {
        await t.type(main(p).getByRole("searchbox").or(main(p).getByPlaceholder(/search|name/i)).first(), "Zentrix"); await p.keyboard.press("Enter");
      });
      await t.step("Open its company page.", () => t.moveAndClick(main(p).getByRole("link", { name: ZENTRIX })));
      await t.step("Ask AI sits in the top bar on every page (shortcut Ctrl+J).", () => t.moveAndClick(p.getByRole("button", { name: /Ask AI/ }).first()));
      const panel = p.getByRole("dialog");
      await t.step("The panel opens on the right. 'Viewing' shows the record it will use: Company · Zentrix Analytics.", () => t.point(panel.getByText(/^Viewing/)));
      await t.step("Suggested questions are tailored to this record — or type your own.", () => t.point(panel.getByRole("button").filter({ hasText: /\w{6,}/ }).nth(1)));
      await t.step("Ask about 'this company' — no need to type its name.", () => ask(t, panel, "Tell me about this company", /Answered from|Done \(/));
      await t.step("The answer is built only from your records: profile, leases, contacts.", () => t.point(panel.getByText("Company overview")));
      await t.step("Unknown facts stay 'Unknown' — the assistant never guesses them.", () => t.point(panel.getByText("Leases").first()));
      await t.step("Sources show where each part came from and how sure it is (Reported, Confirmed…).", () => t.point(panel.getByText("Sources").first()));
      await t.step("'Missing / not verified' lists the gaps, e.g. no identified decision-maker.", () => t.point(panel.getByText("Missing / not verified")));
      await t.step("Turn the answer into a deck, Word doc or PDF, or copy it. Thumbs up/down teach it what helped.", () => t.point(panel.getByRole("button", { name: "Make deck" })));
      await t.step("'Open full chat' continues the same conversation on the big Ask AI page.", () => t.point(panel.getByRole("link", { name: "Open full chat" })));
      await t.step("Close the panel — you're still on the company page.", () => t.moveAndClick(panel.getByRole("button", { name: "Close assistant" }).last()));
      await t.outro("asked AI about the company on screen and read its sources and gaps.", "extract terms from a lease document.");
    },
  },
  {
    slug: "ai-lease-extract", category: "Ask AI & automation", title: "Extract lease terms from a PDF and attach them to a lease",
    learn: "Attach a lease or LOI to Ask AI: it lists each term with page number and exact quote, then prepares an approval card to update the lease record.", tryRoute: "/assistant",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Extract lease terms → attach to a lease", "Every term comes with its page number and the exact words from the document.");
      await t.step("Open Ask AI from the sidebar.", () => t.moveAndClick(navLink(p, "Ask AI")));
      await t.step("Start a new conversation.", () => t.moveAndClick(main(p).getByRole("button", { name: "New", exact: true }).first()));
      await t.step("Press the paper-clip to attach a file: PDF, Word, TXT, CSV or MD, up to 15 MB.", async () => {
        await t.point(main(p).getByRole("button", { name: /Attach a file/ }));
        await main(p).locator("input[type=file]").setInputFiles(`${FILES}/zentrix-lease.pdf`);
      });
      await t.step("The lease PDF is attached (× removes it).", () => t.point(main(p).getByLabel("Attachments")));
      await t.step("Ask it to extract the lease terms.", () => ask(t, main(p), "Extract the lease terms from this document", "Attach these terms to a lease record"));
      await t.step("A table of terms: value, page number, the exact quote and a check mark.", () => t.point(main(p).getByText(/terms found with page-verified snippets/).first()));
      await t.step("Area, rent and dates are parsed by code from the quote — not invented by the AI.", () => t.point(main(p).getByRole("cell", { name: /per sf per month/ }).first()));
      await t.step("'verified on page' means the quote really is on that page.", () => t.point(main(p).getByRole("cell", { name: "verified on page" }).first()));
      await t.step("Terms not in the document stay 'unknown' — e.g. CAM and fit-out.", () => t.point(main(p).getByRole("cell", { name: "not found" }).first()));
      await t.step("Now attach the terms to a lease record. Search by tenant name.", async () => {
        await t.type(main(p).getByPlaceholder(/lease by tenant name/), "Zentrix"); await t.moveAndClick(main(p).getByRole("button", { name: "Search", exact: true }));
      });
      await t.step("Pick Zentrix's lease at Kharadi Tech Park.", () => t.moveAndClick(main(p).getByLabel(/Zentrix Analytics · Kharadi Tech Park/)));
      await t.step("Tick to also store the PDF on the lease.", () => t.point(main(p).getByText(/Also store/)));
      await t.step("Press Attach to lease record. Nothing is saved yet.", () => t.moveAndClick(main(p).getByRole("button", { name: "Attach to lease record" })));
      const card = main(p).locator("section[aria-label^='Approval needed']").last();
      await t.step("An approval card shows every field: what it is now, what it would become, and the page it came from.", () => t.point(card));
      await t.step("Here the area changes from 18,000 to 18,500 sq ft (page 1).", () => t.point(card.getByRole("row", { name: /Area/ })));
      await t.step("Approve change. Material lease fields go on to Review for a second check.", () => t.moveAndClick(card.getByRole("button", { name: "Approve change" })));
      await t.step("Done — the proposal now waits in Review.", async () => { await sleep(2500); await t.point(main(p).getByText(/Review|proposal/i).last()); });
      await t.outro("extracted lease terms with page numbers and sent them to the lease record for approval.", "approve or reject an AI change card.");
    },
  },
  {
    slug: "ai-approval", category: "Ask AI & automation", title: "When AI wants to change something: approve or reject the card",
    learn: "The assistant never changes records or sends anything by itself. It shows an approval card with the exact change; you approve or reject.", tryRoute: "/outreach",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Approve or reject an AI change", "Anything that changes a record or prepares a send waits for your OK on a card.");
      await t.step("Open Outreach from the sidebar.", () => t.moveAndClick(navLink(p, "Outreach")));
      const draft = sql(`select id from mudar.outreach_item where workspace_id='${WS}' and person_id='${ANANYA_ID}' and channel='email' and archived_at is null order by created_at desc limit 1`).trim();
      await t.step("Open an outreach draft — here, the email to Ananya Rao.", async () => { await t.goto(`/outreach/${draft}`); await t.point(main(p).getByText(/Ananya Rao/).first()); });
      await t.step("Open Ask AI. It knows you're viewing this outreach draft.", () => t.moveAndClick(p.getByRole("button", { name: /Ask AI/ }).first()));
      const panel = p.getByRole("dialog");
      await t.step("Ask it to send the proposal email.", () => ask(t, panel, "Send this proposal email", "Approve change"));
      const card = panel.locator("section[aria-label^='Approval needed']").last();
      await t.step("It doesn't send. It shows an approval card: 'Nothing has been sent or changed'.", () => t.point(panel.getByText(/Nothing has been sent or changed/)));
      await t.step("'Waiting for you' — the request is paused until you decide.", () => t.point(card.getByText("Waiting for you")));
      await t.step("The table shows exactly what would change: recipient, subject and the full text.", () => t.point(card.getByRole("table")));
      await t.step("Approve binds to this exact text and recipient — then it opens your mail app; you press send yourself.", () => t.point(card.getByRole("button", { name: "Approve change" })));
      await t.step("Not ready? Press Reject.", () => t.moveAndClick(card.getByRole("button", { name: "Reject" })));
      await t.step("Rejected — nothing was changed, nothing was sent.", async () => { await panel.getByText(/Rejected/).first().waitFor({ timeout: 30000 }); await t.point(panel.getByText(/Rejected/).first()); });
      await t.outro("saw an AI approval card and rejected it — nothing changed.", "see what the assistant remembers.");
    },
  },
  {
    slug: "ai-memory", category: "Ask AI & automation", title: "What the assistant remembers — correct, verify, restrict, forget",
    learn: "Every remembered fact shows its source, date and confidence. Correct it (old version kept), mark it verified, restrict it or forget it.", tryRoute: "/assistant/memory",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("What the assistant remembers", "Check, correct, verify, restrict or forget each remembered fact.");
      await t.step("Open Ask AI, then the Memory tab.", async () => { await t.moveAndClick(navLink(p, "Ask AI")); await t.moveAndClick(tab(p, "Memory")); });
      await t.step("Inferred items are never treated as confirmed; items older than 180 days are flagged.", () => t.point(main(p).getByRole("heading", { name: "Memory" })));
      await t.step("Your writing style: learnt only from messages you sent or approved. Rebuild or turn it off.", () => t.point(main(p).getByText("Your writing style")));
      await t.step("Filter by category (person, company, requirement, relationship) and status.", () => t.point(main(p).locator("select[name=category]")));
      await t.step("Statuses: Active, Restricted, Outdated (old versions), Forgotten.", () => t.point(main(p).locator("select[name=status]")));
      const card = (txt) => main(p).locator("li").filter({ hasText: txt }).first();
      await t.step("Each memory: who it's about, where it came from, when captured, verified or not, review date.", () => t.point(card("Ananya prefers short emails")));
      await t.step("Chips show confidence and warnings like 'Needs review' for old items.", () => t.point(card("Kharadi metro").getByText("Needs review")));
      await t.step("Correct: Ananya's preference changed. Open Correct.", () => t.moveAndClick(card("Ananya prefers short emails").getByText("Correct", { exact: true })));
      await t.step("Write the new version and who told you.", async () => {
        const c = card("Ananya prefers short emails");
        const ta = c.getByLabel("Corrected memory"); await ta.fill("");
        await t.type(ta, "Ananya prefers WhatsApp for quick updates; email only for proposals.", 22);
        await t.type(c.getByLabel("Provided by"), "Ananya Rao", 30);
      });
      await t.step("Save correction. The old version is kept as history.", () => t.moveAndClick(card("Ananya prefers").getByRole("button", { name: "Save correction" })));
      await t.step("'Earlier versions' shows what it used to say.", () => t.moveAndClick(card("WhatsApp").getByText(/Earlier versions/)));
      await t.step("Mark verified: you've checked Zentrix still needs CFO sign-off.", () => t.moveAndClick(card("CFO sign-off").getByRole("button", { name: "Mark verified" })));
      await t.step("Restrict: a sensitive guess about Vikram. Restricted items are kept but used carefully.", () => t.moveAndClick(card("Vikram may be leaving").getByRole("button", { name: "Restrict" })));
      await t.step("Forget: the metro request is out of date. Tick 'Erase permanently' and press Forget.", async () => {
        const c = card("Kharadi metro"); await t.moveAndClick(c.getByText("Forget", { exact: true }).first());
        await t.moveAndClick(c.getByLabel(/Erase this memory permanently/)); await t.moveAndClick(c.getByRole("button", { name: "Forget" }));
      });
      await t.step("Switch the status filter to All to see restricted and forgotten items too.", async () => {
        await main(p).locator("select[name=status]").selectOption("all"); await t.moveAndClick(main(p).getByRole("button", { name: "Filter" }));
      });
      await t.outro("corrected, verified, restricted and forgot memories.", "save a command and schedule it.");
    },
  },
  {
    slug: "saved-commands", category: "Ask AI & automation", title: "Save a command and schedule it",
    learn: "Save a request you run often, run it on demand, and switch on a schedule only by ticking the authorisation box.", tryRoute: "/assistant/commands",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Save a command and schedule it", "Requests you run often, saved once. Scheduling is off until you authorise it.");
      await t.step("Open Ask AI, then Saved commands.", async () => { await t.moveAndClick(navLink(p, "Ask AI")); await t.moveAndClick(tab(p, "Saved commands")); });
      await t.step("Ready-made commands: morning briefing, priority accounts, meeting briefs, reports…", () => t.point(main(p).getByText("Ready-made commands")));
      await t.step("Add 'Review my priority accounts'.", () => t.moveAndClick(main(p).locator("li,div").filter({ hasText: /^Review my priority accounts/ }).getByRole("button", { name: "Add" }).first()));
      await t.step("It's now in Your commands. Open it.", () => t.moveAndClick(main(p).getByRole("link", { name: /Review my priority accounts/ }).first()));
      await t.step("Edit its name, description, the question it asks, inputs and output format.", () => t.point(main(p).getByText("What to ask").first()));
      await t.step("Saving an edit creates a new version, so earlier runs stay explained.", () => t.point(main(p).getByRole("button", { name: /Save \(becomes version/ })));
      await t.step("Schedule: 'Not scheduled' — it only runs when you press Run now.", () => t.point(main(p).getByText(/Not scheduled/)));
      await t.step("Pick a time (IST) and days: Mon–Fri, every day or Mondays.", async () => {
        const time = main(p).locator("input[name=time]"); await t.point(time); await time.fill("08:30");
        const d = main(p).locator("select[name=days]"); await t.point(d); await d.selectOption("weekdays");
      });
      await t.step("Explicit opt-in: tick 'I authorise…'. It only reads data and prepares drafts — nothing is sent.", () => t.moveAndClick(main(p).locator("input[name=confirm]")));
      await t.step("Turn on schedule.", () => t.moveAndClick(main(p).getByRole("button", { name: "Turn on schedule" })));
      await t.step("Now it shows when it runs next and when you authorised it. The list marks it 'Scheduled'.", () => t.point(main(p).getByText(/Runs automatically/)));
      await t.step("Run now any time — the result opens in Ask AI, and History lists each run.", () => t.point(main(p).getByRole("link", { name: "Run now" }).first()));
      await t.outro("saved a ready-made command and scheduled it with explicit authorisation.", "switch on the morning brief.");
    },
  },
  {
    slug: "morning-brief", category: "Ask AI & automation", title: "Switch on the 8 am morning brief and build it now",
    learn: "Opt in to a weekday morning brief (meetings, follow-ups, signals, lease windows, approvals) and build today's on demand.", tryRoute: "/home",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Your morning brief", "Meetings, follow-ups, signals, lease windows and approvals — one page each weekday.");
      await t.step("Open Today, then its Overview tab.", async () => { await t.moveAndClick(navLink(p, "Today")); await t.moveAndClick(tab(p, "Overview")); });
      await t.step("The Morning brief card. It appears here and as a pinned Ask AI chat — nothing is emailed.", () => t.point(main(p).getByRole("heading", { name: "Morning brief" })));
      await t.step("Opt in: tick 'Send me a brief every weekday at'.", () => t.moveAndClick(main(p).locator("input[name=enabled]")));
      await t.step("Keep 08:00 IST, or pick another time.", () => t.point(main(p).getByLabel("Brief time")));
      await t.step("Save.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save", exact: true })));
      await t.step("Now it says when it arrives: weekdays at 08:00.", () => t.point(main(p).getByText(/Arrives weekdays at/)));
      await t.step("Don't want to wait? Build today's brief now.", () => t.moveAndClick(main(p).getByRole("button", { name: /Build today.s brief now/ })));
      await t.step("The counts: meetings, follow-ups, signals, lease windows, approvals. A failed source is named, never hidden.", async () => {
        await main(p).getByText(/Open today.s brief/).waitFor({ timeout: 90000 }).catch(async () => { await t.goto("/home"); });
        await t.point(main(p).getByText(/meetings ·/).first());
      });
      await t.step("Open today's brief.", () => t.moveAndClick(main(p).getByRole("link", { name: /Open today.s brief/ })));
      await t.step("It opens as a conversation in Ask AI — ask follow-up questions right below it.", () => t.point(main(p).getByPlaceholder(/Ask about your accounts/)));
      await t.outro("switched on the weekday 8 am brief and built today's.", "turn pasted notes into record changes.");
    },
  },
  {
    slug: "notes-to-changes-v2", category: "Ask AI & automation", title: "Paste or speak notes → tick changes → approve",
    learn: "Paste call notes (or speak them). CRE OS lists each record change and task with the words it came from; tick the ones you want and approve.", tryRoute: "/assistant/notes",
    async run(t) {
      const p = t.page;
      await p.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
      await t.goto("/today");
      await t.title("Notes → changes you approve", "Paste or speak call notes. Tick the updates you want; nothing is saved until you approve.");
      await t.step("Open Ask AI, then the Notes tab.", async () => { await t.moveAndClick(navLink(p, "Ask AI")); await t.moveAndClick(tab(p, "Notes")); });
      await t.step("Speak notes uses your microphone; here we paste them.", () => t.point(main(p).getByRole("button", { name: "Speak notes" })));
      await t.step("Paste what was said on the call.", () => t.type(main(p).locator("textarea[name=notes]"),
        "Call with Ananya Rao at Zentrix Analytics. They now need 30,000 sq ft in Kharadi and the budget is Rs 90 per sq ft. Move-in by June 2027. Send revised options by Friday.", 14));
      await t.step("Open 'Link to a meeting, company or requirement' — it is optional, but links the changes to the right record.", () => t.moveAndClick(main(p).getByRole("button", { name: /Link to a meeting, company or requirement/ })));
      await t.step("Pick the company: type 'Zentrix' and choose it.", async () => {
        const box = main(p).getByRole("combobox").nth(1);
        await t.type(box, "Zentrix", 60);
        await t.moveAndClick(p.getByRole("option", { name: /^Zentrix Analytics/ }).first());
      });
      await t.step("The requirement box now offers Zentrix's open requirements. Choose the 25,000 sf Kharadi one.", async () => {
        const box = main(p).getByRole("combobox").nth(2);
        await t.moveAndClick(box); await box.pressSequentially("Kharadi", { delay: 60 });
        await t.moveAndClick(p.getByRole("option", { name: /25,000 sf in Kharadi/ }).first());
      });
      await t.step("Press Find updates.", () => t.moveAndClick(main(p).getByRole("button", { name: "Find updates" })));
      await t.step("'Left unknown' lists what it would not guess.", async () => { await p.waitForURL(/notes\?id=/, { timeout: 60000 }); await t.point(main(p).getByText(/Left unknown/)); });
      await t.step("Each change shows old → new value and the exact words it came from.", () => t.point(main(p).getByText("Max budget")));
      await t.step("'Needs approval' — critical values like area, budget and dates also go to Review.", () => t.point(main(p).getByText("Needs approval").first()));
      await t.step("Untick what's wrong. Here we keep the area at 25,000 for now.", () => t.moveAndClick(main(p).locator("input[type=checkbox]").first()));
      await t.step("Tasks: your promises from the call. Unclear dates are flagged — which Friday?", () => t.point(main(p).getByText(/Due date unclear/)));
      await t.step("Press Approve selected. Unticked items are discarded; nothing is sent to anyone.", () => t.moveAndClick(main(p).getByRole("button", { name: "Approve selected" })));
      await t.step("Tasks are saved now; record changes wait in Review.", () => t.point(main(p).getByText(/updates applied/)));
      await t.step("Open Review to finish the record changes.", () => t.moveAndClick(navLink(p, "Review")));
      await t.outro("turned call notes into ticked changes and tasks.", "approve them in Review.");
    },
  },
  {
    slug: "ai-usage", category: "Ask AI & automation", title: "AI usage and the monthly budget",
    learn: "See what AI costs today, this month and projected; set a monthly cap in rupees; see cost by question type, feature and person.", tryRoute: "/assistant/usage",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("AI usage and monthly budget", "What AI costs, who used it, and a cap you control.");
      await t.step("Open Ask AI, then the Usage tab.", async () => { await t.moveAndClick(navLink(p, "Ask AI")); await t.moveAndClick(tab(p, "Usage")); });
      await t.step("Today, this month, projected month-end. Test mode without an AI key costs ₹0.", () => t.point(main(p).getByText("This month").first()));
      await t.step("Budget used: share of the monthly cap. Warnings appear as you approach it; at 100% AI features pause.", () => t.point(main(p).getByText("Budget used")));
      await t.step("Last 30 days: spend per day.", () => t.point(main(p).getByText("Last 30 days")));
      await t.step("Set the monthly budget in rupees (0 = no cap).", async () => {
        const b = main(p).locator("input[name=budget]"); await t.point(b); await b.fill(""); await t.type(b, "5000");
      });
      await t.step("Save budget.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save budget" })));
      await t.step("Breakdowns: by question type, by route (fast or deep model), by person.", async () => { await t.point(main(p).getByText("By question type")); });
      await t.step("By feature: Ask AI, captures, meeting briefs, outreach drafts, search…", () => t.point(main(p).getByText(/By feature/)));
      await t.step("Tokens this month, and how much the cache saved.", () => t.point(main(p).getByText("Tokens this month")));
      await t.step("Most expensive questions — click one to open that conversation.", () => t.point(main(p).getByText("Most expensive questions this month")));
      await t.step("Put the budget back to ₹3,000.", async () => {
        const b = main(p).locator("input[name=budget]"); await b.fill(""); await t.type(b, "3000"); await t.moveAndClick(main(p).getByRole("button", { name: "Save budget" }));
      });
      await t.outro("read AI usage and set the monthly budget.", "see what each automation does.");
    },
  },
  {
    slug: "automation-chains", category: "Ask AI & automation", title: "Automation → Chains — what each chain does, on/off, a run's steps",
    learn: "Six chains run by themselves every few minutes. Read what each does, switch any off, and open a run to see each step and why.", tryRoute: "/workflows",
    async run(t) {
      const p = t.page;
      leaseChain("prepare");
      await t.goto("/today");
      await t.title("Automation → Chains", "Chains that run on their own every few minutes. Each step shows what happened and why.");
      await t.step("Open More, then Automation.", async () => { await t.moveAndClick(nav(p).getByRole("button", { name: /More/ })); await t.moveAndClick(navLink(p, "Automation")); });
      await t.step("Open the Chains tab at the top.", () => t.moveAndClick(p.getByRole("link", { name: "Chains", exact: true })));
      await t.step("Signal → action: a new signal matches the company, finds decision-makers, rescores, maybe prepares one draft.", () => t.point(main(p).getByText(/^Signal → action/)));
      await t.step("Lease → renewal / relocation: a lease near expiry gets a proposed requirement, options and a task.", () => t.point(main(p).getByText(/^Lease → renewal/)));
      await t.step("Reply → meeting: a reply asking to meet links the meeting (no time is guessed) and pauses follow-ups.", () => t.point(main(p).getByText(/^Reply → meeting/)));
      await t.step("Job change → re-engagement: a contact moves company; history is kept and the new employer rescored.", () => t.point(main(p).getByText(/^Job change/)));
      await t.step("Visit feedback → comparison: site-visit feedback re-runs the saved building comparison.", () => t.point(main(p).getByText(/^Visit feedback/)));
      await t.step("Meeting completed → follow-ups: rescore and show the tasks and draft it created.", () => t.point(main(p).getByText(/^Meeting completed/)));
      await t.step("Each shows On or Off. 'Turn off' stops that chain; 'Turn on' restarts it.", () => t.point(main(p).getByRole("button", { name: "Turn off" }).first()));
      await t.step("Check now runs all chains immediately instead of waiting.", () => t.point(main(p).getByRole("button", { name: "Check now" })));
      await t.step("Below: runs. This one is for Zentrix's lease — 'Waiting for approval'.", async () => { await t.scroll(500); await t.point(main(p).getByText("Waiting for approval").first()); });
      await t.step("Each step is listed with what it did and why.", () => t.point(main(p).getByText(/Lease → renewal \/ relocation/).last()));
      await t.step("Material steps (like a new requirement) stop and wait for you. 'Approval' opens it.", () => t.point(main(p).getByRole("link", { name: "Approval" }).first()));
      await t.outro("read what each automation does, its switch, and one run's steps.", "check what waits for you in Review.");
    },
  },
  // ------------------------------------------------------------------ Review & settings
  {
    slug: "review-queues-v3", category: "Review & settings", title: "Review — what waits for you, approve, reject, ask for more info",
    learn: "Review holds everything waiting for your OK: unverified contacts, captures, record changes, merges, drafts, documents. Approve, reject, edit or request more info.", tryRoute: "/approvals",
    async run(t) {
      const p = t.page;
      // Not filmed: earlier tutorial runs left identical open proposals (same record, same change). Keep only the newest of each.
      sql(`update mudar.change_proposal c set archived_at = now() where c.workspace_id = '${WS}' and c.archived_at is null and c.state in ('proposed','clarify')
           and exists (select 1 from mudar.change_proposal d where d.workspace_id = c.workspace_id and d.archived_at is null and d.state in ('proposed','clarify')
             and d.state = c.state and d.target_type = c.target_type and coalesce(d.target_id::text,'') = coalesce(c.target_id::text,'') and d.patch::text = c.patch::text and d.created_at > c.created_at)`);
      await p.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
      await t.goto("/today");
      await t.title("Review — what waits for you", "Nothing material changes your records until you approve it here.");
      await t.step("Open Review. The badge counts what's waiting.", () => t.moveAndClick(navLink(p, "Review")));
      await t.step("At the top: quick counts — files needing input, needs more info, unverified contact details, outreach drafts and failed jobs.", () => t.point(main(p).getByRole("link", { name: /Unverified contact details/ }).first()));
      await t.step("New sections above the tabs: transaction approvals waiting for you…", () => optPoint(t, main(p).getByText(/Transaction approvals waiting for you/)));
      await t.step("…lease dates needing review and lease terms to confirm — decisions from Transactions and Leases also wait here.", () => optPoint(t, main(p).getByText(/Lease dates needing review|Lease terms to confirm/)));
      await t.step("Imports to review: spreadsheet rows waiting for your check.", () => optPoint(t, main(p).getByText(/Imports to review/)));
      await t.step("Unverified contact details: emails and phones nobody has checked yet. Open the person to verify.", () => t.point(main(p).getByText(/Unverified contact details \(/)));
      await t.step("Captures to review: notes and files from Capture. Open one, check it, press Reviewed.", () => t.point(main(p).getByText(/Captures to review/)));
      await t.step("Tabs split the rest. Record changes first.", () => t.moveAndClick(main(p).getByRole("link", { name: "Record changes" })));
      p.on("dialog", (d) => d.accept().catch(() => {}));
      const req = main(p).locator("article").filter({ hasText: "Max budget" }).first();
      const lease = main(p).locator("article").filter({ hasText: /^lease:|Area/ }).filter({ hasText: "18500" }).filter({ has: p.getByText("proposed", { exact: true }) }).first();
      await t.step("Each card: the record, 'Material' tag, now vs proposed, and the evidence quote.", () => t.point(main(p).getByText("Max budget").first()));
      await t.step("'why do we believe this?' opens the source behind the proposal.", () => t.point(main(p).getByText("why do we believe this?").first()));
      await t.step("Buttons: Approve & apply, Approve only (apply later), Ask to clarify, Reject; or Edit proposed values.", () => t.point(req.getByRole("button", { name: "Approve only" })));
      const more = lease.locator("xpath=following-sibling::details[1]");
      await t.step("The lease proposal from the PDF (area 18,000 → 18,500). Something to check first? Request more info.", async () => {
        await t.point(lease); await t.moveAndClick(more.getByText("Request more info"));
      });
      await t.step("Say what's missing and press Ask — it moves to 'Needs more info' and adds a linked task.", async () => {
        await t.type(more.getByPlaceholder(/What's missing/), "Need the signed lease page with the area", 25);
        await t.moveAndClick(more.getByRole("button", { name: "Ask", exact: true }));
      });
      await t.step("The notes change (budget ₹90, move-in June 2027) looks right: Approve & apply.", () => t.moveAndClick(main(p).locator("article").filter({ hasText: "Max budget" }).first().getByRole("button", { name: "Approve & apply" })));
      await t.step("Applied — it leaves the queue and appears in History & undo.", () => t.point(main(p).getByRole("link", { name: "History & undo" })));
      await t.step("Identity merges: duplicate companies, people or buildings — never merged silently.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: "Identity merges" })); await sleep(800); await t.point(main(p).getByRole("link", { name: "Identity merges" })); await t.scroll(250); });
      await t.step("External drafts: outreach drafts waiting to be checked and sent by you.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: "External drafts" })); await sleep(800); await t.point(main(p).getByRole("link", { name: "External drafts" })); await t.scroll(250); });
      await t.step("Documents: generated documents still in draft.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: "Documents" })); await sleep(800); await t.point(main(p).getByRole("link", { name: "Documents" })); await t.scroll(250); });
      await t.step("Conflicts: two sources disagree on a value — you choose.", () => t.moveAndClick(main(p).getByRole("link", { name: "Conflicts" })));
      await t.step("Stale records: data too old to trust until rechecked.", () => t.moveAndClick(main(p).getByRole("link", { name: "Stale records" })));
      await t.outro("worked through Review: approved one change and asked for more info on another.", "undo an applied change.");
    },
  },
  {
    slug: "review-undo", category: "Review & settings", title: "Undo an applied change from Review history",
    learn: "History & undo lists every applied change with its evidence. Undo one, or tick several and undo them together.", tryRoute: "/approvals?tab=history",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Undo an applied change", "Every applied change can be reversed from Review history.");
      p.on("dialog", (d) => d.accept().catch(() => {}));
      await t.step("Open Review.", () => t.moveAndClick(navLink(p, "Review")));
      await t.step("Open the History & undo tab.", () => t.moveAndClick(main(p).getByRole("link", { name: "History & undo" })));
      await t.step("Newest first: each applied change, its fields and where it came from.", () => t.point(main(p).getByText("Max budget").first()));
      await t.step("Tags show how it arrived — e.g. 'AI extracted' — and that it was applied.", () => t.point(main(p).getByText("AI extracted").first()));
      await t.step("To undo several, tick them and press Undo selected. Later edits are kept and reported.", () => t.point(main(p).getByRole("button", { name: "Undo selected" })));
      await t.step("Here: undo the budget / move-in change from the notes. Press Undo on its card and confirm.", () =>
        t.moveAndClick(main(p).locator("article").filter({ hasText: "Max budget" }).first().getByRole("button", { name: "Undo", exact: true })));
      await t.step("The record is back to what it was, and the undo itself is logged.", async () => { await sleep(1500); await t.point(main(p).getByText(/revers|undone|Undo/i).first()); });
      await t.step("Undo can't unsend messages or reverse promises made outside CRE OS.", () => t.point(main(p).getByText(/Undo cannot unsend/).first()));
      await t.outro("reversed an applied change from Review history.", "capture a file.");
    },
  },
  {
    slug: "capture-files-v3", category: "Review & settings", title: "Capture any file — quote, business card, photo → proposals",
    learn: "Drop quotes, leases, notes, cards, photos or spreadsheets into Capture. CRE OS says what it found, page by page, and turns it into proposals you review.", tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Capture a file → proposals", "Quotes, leases, business cards, photos, layouts, spreadsheets, voice notes.");
      await t.step("Open Capture.", () => t.moveAndClick(navLink(p, "Capture")));
      await t.step("'Add files' takes almost anything, up to 25 MB each.", () => t.point(main(p).getByText("Drop files here")));
      await t.step("Optional: link it to a record first — company, person, building, requirement, meeting, lease or transaction.", () => t.moveAndClick(main(p).getByText(/Link to a record/).last()));
      await t.step("This quote is for Zentrix's requirement.", async () => {
        const s = main(p).locator("select[name=requirement_id]").last(); await t.point(s); await s.selectOption({ label: "Zentrix Analytics — 25,000 sf in Kharadi" });
      });
      await t.step("'What is it?' — leave on Detect, or pick: quotation, lease, LOI, notes, business card, photo, layout…", () => t.point(main(p).locator("select[name=doc_type]").last()));
      await t.step("Choose the landlord's quotation PDF.", async () => {
        await t.point(main(p).getByRole("button", { name: "Choose files" }));
        await main(p).locator("input[type=file][multiple]").first().setInputFiles(`${FILES}/riverside-quote.pdf`);
      });
      await t.step("It's recognised as a Quotation. Open it.", async () => { await main(p).getByRole("link", { name: "Open" }).first().waitFor({ timeout: 60000 }); await t.moveAndClick(main(p).getByRole("link", { name: "Open" }).first()); });
      await t.step("What CRE OS found: type, confidence, and each value with its page and quote.", async () => { await p.waitForURL(/capture\/documents/); await t.point(main(p).getByText("What CRE OS found")); });
      await t.step("Without an AI key it uses pattern matching — 'check every value'.", () => t.point(main(p).getByText(/pattern matching/).first()));
      await t.step("Proposals: here, create a quote. Review opens it for your approval.", () => t.point(main(p).getByText(/Proposals \(/)));
      await t.step("Wrong guess? 'Fix and process again' changes the type or linked records.", () => t.point(main(p).getByText("Fix and process again")));
      await t.step("Back to Capture for a building photo.", () => t.moveAndClick(navLink(p, "Capture")));
      await t.step("Upload the photo.", async () => { await sleep(2000); await t.point(main(p).getByRole("button", { name: "Choose files" })); await main(p).locator("input[type=file][multiple]").first().setInputFiles(`${FILES}/riverside-photo.png`); });
      await t.step("A photo needs a building or visit — open it to choose.", async () => { await main(p).getByRole("link", { name: "Open" }).first().waitFor({ timeout: 60000 }); await t.moveAndClick(main(p).getByRole("link", { name: "Open" }).first()); });
      await t.step("Pick the building, then Process again. Business cards work the same way: type 'Business card'.", async () => {
        await p.waitForURL(/capture\/documents/); const s = main(p).locator("select[name=asset_id]").last(); await t.point(s);
        await s.selectOption({ label: "Kharadi Riverside Towers (demo)" }); await t.moveAndClick(main(p).getByRole("button", { name: "Process again" }));
      });
      await t.step("Recent files on Capture list every file and whether it needs your input.", async () => { await t.goto("/capture"); await t.point(main(p).getByText("Recent files")); });
      await t.outro("captured a quote and a building photo and saw what CRE OS proposed.", "check settings and connections.");
    },
  },
  {
    slug: "settings-connections", category: "Review & settings", title: "Settings & connections — read-only mail and calendar",
    learn: "Connect Gmail/Outlook and calendar read-only. CRE OS cannot send email, change your calendar or delete anything; urgent alerts are private and off by default.", tryRoute: "/settings/connections",
    async run(t) {
      const p = t.page;
      await t.goto("/today");
      await t.title("Settings & connections", "Mail and calendar are read-only. CRE OS never sends anything for you.");
      await t.step("Settings is at the bottom of the sidebar (owners and admins).", () => t.moveAndClick(p.getByRole("link", { name: /^Settings/ }).first()));
      await t.step("Owners must set up an authenticator app before admin pages — CRE OS never sends codes by SMS or email.", () => t.point(main(p).getByText(/Authenticator app/).first()));
      await t.step("Tabs: General, Members, Partners, Templates, Licensed sources, Data lanes, Retention, Security.", () => t.point(main(p).getByRole("link", { name: "Members" })));
      await t.step("Open Connections.", () => t.moveAndClick(main(p).getByRole("link", { name: "Connections" })));
      await t.step("Read-only: CRE OS cannot send email, change your calendar or delete anything.", () => t.point(main(p).getByText(/Read-only access/)));
      await t.step("Microsoft 365: reads mail and calendar with Mail.Read and Calendars.Read only.", () => t.point(main(p).getByText(/Microsoft 365/)));
      await t.step("'Permissions requested' lists exactly what it asks for.", () => t.moveAndClick(main(p).getByText("Permissions requested").first()));
      await t.step("Google (Gmail & Calendar): same read-only rules. Until set up, import threads by hand in Drafts → Inbox triage.", () => t.point(main(p).getByText(/Google \(Gmail/)));
      await t.step("'Use mock data' lets you try it without connecting a real account.", () => t.point(main(p).getByRole("button", { name: "Use mock data" }).first()));
      await t.step("Urgent alerts: private notes to you only, for verified senders. Off by default.", () => t.point(main(p).getByText("Urgent alerts")));
      await t.step("Choose which events alert you, and a do-not-disturb window.", () => t.point(main(p).locator("input[name=dnd_start]")));
      await t.step("Nothing is ever sent to a client automatically — drafts only, you send them yourself.", () => t.point(main(p).getByText(/Nothing is ever sent/)));
      await t.outro("saw Settings, the read-only connections and what is never sent.", "back to Today.");
    },
  },
];

module.exports = { FLOWS, prepare, finish };
