// Tutorial videos — group "input": Module 10 Input Engine (capture a note, voice/Hindi/Hinglish, business cards, quotes with page
// references and a revised price, reviewing extracted items, spreadsheet mapping + validation, re-uploads, batch uploads, provenance).
// Captions describe only what is on screen (practice/mock AI mode: no speech-to-text, no photo OCR, rule-based extraction).
// Demo data + files: setup-input.ts (run in prepare; demo workspace only, synthetic; files in /tmp/tutorial-input).
// Videos depend on each other in this order (the review video works on the note from the first one).
const path = require("path");
const { execFileSync } = require("child_process");
const { sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const WS = "de000000-0000-4000-8000-000000000001";
const DIR = process.env.TUT_INPUT_DIR || "/tmp/tutorial-input";
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", q], { stdio: "pipe" }).toString().trim();
const tsx = (...a) => execFileSync("npx", ["tsx", "--require", "./scripts/assistant-evals.preload.cjs", "--env-file=.env.local", "scripts/tutorial-videos/setup-input.ts", ...a],
  { cwd: ROOT, stdio: "pipe", timeout: 300000 }).toString();

const CAT = "Records & data"; // closest existing topic for "Capture & imports"
const ANIL_NOTE = "Spoke to Anil. They need around 20,000 feet in Kharadi by September. Budget is 85. Send options Friday.";
const HINGLISH = "Marigold ke Anil se baat hui. Unko Karadi mein bees hazaar sq ft chahiye, March tak. Friday ko options bhejna hai.";
const HINDI = "मरीगोल्ड के अनिल से बात हुई। खराडी में बीस हज़ार sq ft चाहिए।";
const CARD_MEERA = ["Meera Joshi", "Head - Leasing", "Riverside Realty LLP", "M: +91 98220 45678", "Ph: 020 6612 3400", "meera.joshi@riversiderealty.example",
  "www.riverside-realty.example", "Tower B, EON Free Zone, Kharadi, Pune 411014"].join("\n");
const CARD_ANIL = ["Anil Deshmukh", "Head of Workplace", "Marigold Loop Technologies Pvt Ltd", "M: +91 99230 11223", "anil.deshmukh@marigoldloop.example", "Baner Road, Pune 411045"].join("\n");
const REQ_LABEL = "Marigold Loop — 20,000 sf in Kharadi (demo)";

const nav = (p) => p.getByRole("navigation", { name: "Main" }).first();
const main = (p) => p.locator("main");
const acceptDialogs = (p) => p.on("dialog", (d) => d.accept().catch(() => {}));

/** Always record in the synthetic demo workspace (the owner may belong to other workspaces too). */
async function start(t) {
  acceptDialogs(t.page);
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A card heading (headings carry a "?" help button, so match the start of the text). */
const card = (p, title) => main(p).getByText(new RegExp(`^${esc(title)}`)).first();
/** One extracted item (observation) by its field label. */
const obs = (p, label) => main(p).locator("li").filter({ has: p.getByText(label, { exact: true }) }).filter({ has: p.locator("summary") }).first();
async function openObs(t, label) {
  const o = obs(t.page, label); const d = o.locator("details").first();
  if (await d.evaluate((el) => el.open).catch(() => false)) await t.point(o.locator("summary")); else await t.moveAndClick(o.locator("summary"));
  await sleep(400); return o;
}
/** Upload through the Capture drop zone and open the result. */
async function dropFile(t, file) {
  const p = t.page;
  await t.point(main(p).getByRole("button", { name: "Choose files" }));
  await main(p).locator("input[type=file][multiple]").setInputFiles(path.join(DIR, file));
  const open = main(p).locator("li").filter({ hasText: file }).getByRole("link", { name: "Open" }).first();
  await open.waitFor({ timeout: 120000 });
  return open;
}
/** True when the photo could not be read (OCR failed) — only then type the card text. */
const notRead = (p) => main(p).getByText(/photo text not read/).first().isVisible().catch(() => false);
async function moreLinks(t) { await t.moveAndClick(main(t.page).getByText(/Link to a record/).last()); await sleep(300); }

function prepare() { console.log(tsx()); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. the Anil note
  {
    slug: "capture-quick-note", category: CAT, title: "Capture a quick note (the Anil example)",
    learn: "Type one line after a call. CRE OS shows a receipt of what it understood, asks ONE question about the unclear budget, sets the Friday follow-up task and changes no record until you press Reviewed.",
    tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Capture a quick note", "\"Spoke to Anil… Budget is 85. Send options Friday.\" — and what CRE OS does with it.");
      await t.step("Open Capture in the sidebar. This is where everything you hear, read or receive comes in.", () => side(t, "Capture"));
      await t.step("The Capture dashboard: type a note, record a voice note, upload a card or document, upload a spreadsheet, pending reviews and history.", () => t.point(card(p, "Capture dashboard")));
      await t.step("Choose Type — write or paste a note.", () => t.moveAndClick(main(p).getByRole("radio", { name: /Type/ })));
      await t.step("Write what happened in plain words, like a message to yourself.", () => t.type(main(p).getByPlaceholder("English, Hindi or Hinglish is fine"), ANIL_NOTE, 28));
      await t.step("More options lets you set when it happened and the language. Defaults are fine.", () => t.moveAndClick(main(p).getByText("More options").first()));
      await t.step("Press Save capture.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Save capture" })); await p.waitForURL(/\/capture\/[0-9a-f-]{36}$/, { timeout: 90000 }); });
      await t.step("The review page. 'rule extractor' means practice mode: rules, not AI, read the note.", () => t.point(main(p).locator("h1").first()));
      await t.step("The Receipt says, in plain words, what CRE OS did with your note.", () => t.point(card(p, "Receipt")));
      await t.step("Saved: the note itself, with the items it understood.", () => t.point(main(p).getByText(/Note saved/).first()));
      await t.step("Matched: 'Anil' is probably Anil Deshmukh — a medium-confidence match, so it waits for you to confirm.", () => t.point(main(p).getByText(/Contact Anil: medium-confidence/).first()));
      await t.step("Kharadi fits several buildings, so they are only suggestions — nothing is linked.", () => soft(t, main(p).getByText(/Building "Kharadi"/)));
      await t.step("Questioned: 'Budget is 85' has no unit, so CRE OS asks one question instead of guessing.", () => t.point(main(p).getByText(/Clarification pending/).first()));
      await t.step("Scheduled: 'Send options Friday' became a task due this Friday.", () => t.point(main(p).getByText(/Task "Send options/).first()));
      await t.step("What the note is about: a new property requirement, a meeting note and a follow-up task.", () => t.point(main(p).getByText("New property requirement").first()));
      await t.step("Extracted information: each item with the exact words it came from.", async () => { await t.point(main(p).getByText(/^Extracted information/).first()); });
      await t.step("Area: '20,000 feet' → 20,000 sq ft, an estimate. Carpet or chargeable is unknown, and stays unknown.", () => t.point(obs(p, "Area needed")));
      await t.step("Budget: 85, but unit, pricing basis and CAM are unknown — not assumed.", () => t.point(obs(p, "Budget")));
      await t.step("'By September' is an informal target; the year is left unknown.", () => t.point(obs(p, "Move-in target")));
      await t.step("Here is the one question: does 85 mean ₹85 per sq ft per month, and is CAM extra?", () => t.point(main(p).getByText(/Budget "85" — does that mean/).last()));
      await t.step("Pick the answer you heard: ₹85 per sq ft per month, CAM extra.", () => t.moveAndClick(main(p).getByText("Yes — ₹85/sq ft/month, CAM extra").first()));
      await t.step("Save answers.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Save answers" })); await sleep(2500); });
      await t.step("Who and where: Anil → Anil Deshmukh. No company was named, so his only current employer is used — and flagged.", () => soft(t, main(p).getByText(/No company was named/)));
      await t.step("This list is everything that will be added when you press Reviewed. Nothing is saved to records yet.", () => t.point(main(p).getByText("What will be added when you press Reviewed").first()));
      await t.step("Press Reviewed — add to records.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: /Reviewed — add to records/ })); await sleep(3000); });
      await t.step("Requirement facts become proposals for approval — CRE OS never changes a requirement by itself.", () => soft(t, main(p).getByText("Facts for approval")));
      await t.step("The task 'Send options to Anil' is due Friday. It is also on your Tasks page.", async () => { await t.scroll(600); await soft(t, card(p, "Tasks")); });
      await t.outro("captured the Anil note, answered the budget question and filed a Friday task.", "voice notes in English, Hindi or Hinglish.");
    },
  },
  // ------------------------------------------------------------------ 2. voice + languages
  {
    slug: "capture-voice-languages", category: CAT, title: "Voice notes in English, Hindi or Hinglish",
    learn: "Speak or upload a voice note (English, Hindi or Hinglish), check the transcript, fix a misheard word and re-extract. Corrections are kept in the history; Hindi notes keep the original script.",
    tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Voice notes in English, Hindi or Hinglish", "Record, check the transcript, fix a word.");
      await t.step("Open Capture.", () => side(t, "Capture"));
      await t.step("Speak turns your words into text as you talk, in the browser. You check the text before saving.", () => t.moveAndClick(main(p).getByRole("radio", { name: /Speak/ })));
      await t.step("Choose the language: English, Hindi / Hinglish or Marathi.", () => soft(t, main(p).locator("select").first()));
      await t.step("Already have a recording? Use Add files. Open 'Link to a record' to set the language and consent.", async () => { await t.scroll(500); await moreLinks(t); });
      await t.step("Recording language: Hinglish.", async () => { const s = main(p).locator("select[name=language_hint]").last(); await t.point(s); await s.selectOption("hinglish"); });
      await t.step("Recording consent: who agreed to the recording.", () => t.type(main(p).getByPlaceholder("e.g. Raj agreed at start of call"), "Anil agreed at the start of the call", 20));
      await t.step("Choose the voice note file.", async () => { const o = await dropFile(t, "voice-note-marigold-call.wav"); await t.point(o); });
      await t.step("It is recognised as a Recording. Open it.", async () => { await t.moveAndClick(main(p).locator("li").filter({ hasText: "voice-note" }).getByRole("link", { name: "Open" }).first()); await p.waitForURL(/capture\/documents/); });
      await t.step("In practice mode there is no speech-to-text, so CRE OS asks you to type what was said. The audio is kept.", () => soft(t, main(p).getByText(/type|Type/).first()));
      await t.step("Type the notes. Here the word Kharadi was heard as 'Karadi'.", async () => {
        await t.scroll(2000); const ta = main(p).locator("textarea[name=typed_text]"); await t.point(ta); await ta.fill(""); await t.type(ta, HINGLISH, 18);
      });
      await t.step("Process again.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Process again" })); await sleep(5000); await p.reload(); await sleep(1000); });
      await t.step("The transcript is shown. Speakers are not identified, so who said what stays uncertain.", () => soft(t, card(p, "Transcript")));
      await t.step("Hinglish was understood: 'bees hazaar sq ft' → 20,000 sq ft, 'March tak' → by March.", () => t.point(obs(p, "Area needed")));
      await t.step("'Friday ko options bhejna hai' became a Friday task.", () => soft(t, obs(p, "Task")));
      await t.step("Open the capture review to correct the transcript.", async () => { await t.scroll(-3000); await t.moveAndClick(main(p).getByRole("link", { name: "Open the capture review" })); await p.waitForURL(/\/capture\/[0-9a-f-]{36}$/); });
      await t.step("Open 'Correct the note / transcript'.", () => t.moveAndClick(main(p).getByText("Correct the note / transcript")));
      await t.step("Fix the misheard word: Karadi → Kharadi.", async () => {
        const ta = main(p).getByRole("textbox", { name: "Capture text" }); await t.point(ta);
        await ta.fill(HINGLISH.replace("Karadi", "Kharadi")); await sleep(600);
      });
      await t.step("Save and re-extract. Everything is read again from the corrected text — nothing is duplicated.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Save and re-extract" })); await sleep(5000); await p.reload(); await sleep(800); });
      await t.step("Correction history keeps what it was and what you changed it to.", () => soft(t, main(p).getByText("Correction history")));
      await t.step("Now a note in Hindi script. Back to Capture.", () => side(t, "Capture"));
      await t.step("Type, then write in Hindi (Devanagari).", async () => { await t.moveAndClick(main(p).getByRole("radio", { name: /Type/ })); await t.type(main(p).getByPlaceholder("English, Hindi or Hinglish is fine"), HINDI, 25); });
      await t.step("Save capture.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Save capture" })); await p.waitForURL(/\/capture\/[0-9a-f-]{36}$/, { timeout: 90000 }); });
      await t.step("The note is read in a romanised copy; the receipt shows the same kind of matches.", () => t.point(card(p, "Note")));
      await t.step("'Original (Hindi)' keeps the text exactly as you wrote it.", () => soft(t, main(p).getByText("Original (Hindi)")));
      await t.outro("uploaded a Hinglish voice note, fixed a misheard word and saved a Hindi note.", "scan a business card.");
    },
  },
  // ------------------------------------------------------------------ 3. business cards
  {
    slug: "capture-business-card-v2", category: CAT, title: "Scan a business card",
    learn: "Upload a card photo. CRE OS lists name, title, company, emails, phones (typed mobile/direct/switchboard), website and address, flags uncertain fields, and either matches an existing contact or proposes a new one for approval.",
    tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Scan a business card", "Fields, new or existing contact, and what to double-check.");
      await t.step("Open Capture and scroll to Add files.", async () => { await side(t, "Capture"); await t.scroll(700); });
      await t.step("Open 'Link to a record' and set 'What is it?' to Business card (or leave Detect).", async () => {
        await moreLinks(t); const s = main(p).locator("select[name=doc_type]").last(); await t.point(s); await s.selectOption("business_card");
      });
      await t.step("Choose the photo of Meera Joshi's card.", async () => { const o = await dropFile(t, "card-meera-joshi.png"); await t.point(o); });
      await t.step("Open it.", async () => { await t.moveAndClick(main(p).locator("li").filter({ hasText: "card-meera" }).getByRole("link", { name: "Open" }).first()); await p.waitForURL(/capture\/documents/); });
      await t.step("The card was read on the server by local OCR — no AI call.", () => t.point(card(p, "What CRE OS found")));
      if (await notRead(p)) {
        await t.step("Photo unreadable? Type the card text into 'Text (if the file couldn't be read)' and Process again.", async () => {
          await t.scroll(2000); const ta = main(p).locator("textarea[name=typed_text]"); await t.point(ta); await ta.fill(CARD_MEERA); await sleep(800);
          await t.moveAndClick(main(p).getByRole("button", { name: "Process again" })); await sleep(5000); await p.reload(); await sleep(800);
        });
      }
      await t.step("The fields: name, title, company, email, phones, website and address — copied exactly as on the card.", () => t.point(card(p, "What CRE OS found")));
      await t.step("Phones are typed: mobile from 'M:'. The 'Ph:' number could be direct or switchboard, so it is marked unknown.", () => t.point(main(p).getByText(/\(mobile\)/).first()));
      await t.step("Check these: uncertain fields — the unlabelled phone, and an email domain that differs from the website.", () => t.point(main(p).getByText(/^Check /).first()));
      await t.step("No existing contact matches, so a new contact is suggested.", () => t.point(main(p).getByText(/no existing contact/i).first()));
      await t.step("Proposals: a new person and a new company — they wait for your approval in Review.", () => t.point(main(p).getByText(/Proposals \(/).first()));
      await t.step("After you approve the person, press Process again to propose the emails and phones.", () => soft(t, main(p).getByText(/Approve the new person/)));
      await t.step("Now a card for someone you already know: Anil Deshmukh. Back to Capture.", async () => { await side(t, "Capture"); await t.scroll(700); });
      await t.step("Business card again, and choose Anil's card.", async () => {
        await moreLinks(t); await main(p).locator("select[name=doc_type]").last().selectOption("business_card");
        await t.moveAndClick(await dropFile(t, "card-anil-deshmukh.png")); await p.waitForURL(/capture\/documents/);
      });
      if (await notRead(p)) {
        await t.step("Photo unreadable? Type the card text and Process again.", async () => {
          await t.scroll(2000); const ta = main(p).locator("textarea[name=typed_text]"); await t.point(ta); await ta.fill(CARD_ANIL);
          await t.moveAndClick(main(p).getByRole("button", { name: "Process again" })); await sleep(5000); await p.reload(); await sleep(800);
        });
      }
      await t.step("High-confidence match: the same email already belongs to Anil Deshmukh, so no new person is created.", () => t.point(main(p).getByText(/high confidence match/i).first()));
      await t.step("Only the new mobile number is proposed for his record. Same name alone would be a suggestion, never a merge.", () => t.point(main(p).getByText(/Proposals \(/).first()));
      await t.step("The company on the card looks like Marigold Loop Technologies — pick it in the link picker if it is the same.", () => soft(t, main(p).getByText(/Possible existing company/)));
      await t.outro("scanned two cards: one new contact and one matched to an existing contact.", "upload a quote, brochure or lease.");
    },
  },
  // ------------------------------------------------------------------ 4. quotes / documents
  {
    slug: "capture-quote-document", category: CAT, title: "Upload a quote, brochure or lease document",
    learn: "Upload a quotation, brochure, LOI or lease. Each term comes with its page and the exact words; areas and CAM are never converted or assumed. A revised quote with a new price becomes version 2 — the earlier value is kept.",
    tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Upload a quote, brochure or lease", "Terms with page references — and what happens when the price changes from ₹85 to ₹95.");
      await t.step("Open Capture and scroll to Add files.", async () => { await side(t, "Capture"); await t.scroll(700); });
      await t.step("PDF and Word quotations, brochures, LOIs, leases, notes, cards, photos and voice notes are all accepted here.", () => t.point(main(p).getByText("Drop files here")));
      await t.step("Open 'Link to a record' and pick the requirement this quote is for: Marigold Loop, 20,000 sf in Kharadi.", async () => {
        await moreLinks(t); const s = main(p).locator("select[name=requirement_id]").last(); await t.point(s); await s.selectOption({ label: REQ_LABEL });
      });
      await t.step("'Quotation from' says who sent it — landlord, managed-office operator or fit-out partner.", () => t.point(main(p).locator("select[name=party_kind]").last()));
      await t.step("Choose the March quotation PDF.", async () => { await t.point(await dropFile(t, "marigold-quote-march.pdf")); });
      await t.step("Recognised as a Quotation. Open it.", async () => { await t.moveAndClick(main(p).locator("li").filter({ hasText: "marigold-quote-march" }).getByRole("link", { name: "Open" }).first()); await p.waitForURL(/capture\/documents/); });
      await t.step("The type was worked out from the file and its keywords. 'Pattern matching — check every value' means practice mode.", () => t.point(card(p, "What CRE OS found")));
      await t.step("Original file opens the PDF exactly as uploaded — it is always kept.", () => soft(t, main(p).getByRole("link", { name: "Original file" })));
      await t.step("Rent: 'Rs. 85 per sq ft per month' → ₹85 per sq ft per month, CAM extra — found on page 1.", () => t.point(obs(p, "Rent per sq ft")));
      await t.step("Chargeable area 20,000 sq ft stays chargeable — carpet, chargeable and super built-up are never converted.", () => t.point(obs(p, "Chargeable area")));
      await t.step("Lock-in, deposit and escalation come from page 2. Every value keeps its page and wording.", async () => { await t.scroll(400); await soft(t, obs(p, "Lock-in")); });
      await t.step("Proposals: create a quote on the requirement — approve it in Review.", async () => { await t.scroll(500); await t.point(main(p).getByText(/Proposals \(/).first()); });
      await t.step("Now the landlord sends a revised quote. Back to Capture.", async () => { await side(t, "Capture"); await t.scroll(700); });
      await t.step("Same requirement, and choose the revised quotation.", async () => {
        await moreLinks(t); await main(p).locator("select[name=requirement_id]").last().selectOption({ label: REQ_LABEL });
        await t.point(await dropFile(t, "marigold-quote-revised.pdf"));
      });
      await t.step("Open it.", async () => { await t.moveAndClick(main(p).locator("li").filter({ hasText: "marigold-quote-revised" }).getByRole("link", { name: "Open" }).first()); await p.waitForURL(/capture\/documents/); });
      await t.step("Rent is now ₹95. 'Differs from the saved value' — this is version 2.", () => t.point(obs(p, "Rent per sq ft")));
      await t.step("The ₹85 from the first quote is kept, not overwritten. The change waits in the Review queue.", () => t.point(main(p).getByText(/the earlier value is kept/).first()));
      await t.step("Recent files on Capture list both quotes, their type and whether they wait for you.", async () => { await side(t, "Capture"); await soft(t, main(p).getByText("Recent files")); });
      await t.outro("uploaded a quote with page references and a revised quote that kept the old price.", "review what was extracted.");
    },
  },
  // ------------------------------------------------------------------ 5. review extracted items
  {
    slug: "capture-review-items", category: CAT, title: "Review what was extracted",
    learn: "Each extracted item can be confirmed, edited, rejected, linked to a record, turned into a new record (for approval) or sent back as a question. The Review queue groups what needs a person by reason.",
    tryRoute: "/capture/review",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Review what was extracted", "Confirm, edit, reject, link, create or ask — item by item.");
      await t.step("Open Capture and the Anil note under Recent captures.", async () => {
        await side(t, "Capture"); await t.moveAndClick(main(p).getByRole("link").filter({ hasText: "Spoke to Anil" }).first()); await p.waitForURL(/\/capture\/[0-9a-f-]{36}$/);
      });
      await t.step("Scroll to Extracted information. Each item has a status: For review, Saved, Confirmed, Corrected or Rejected.", async () => { await t.scroll(500); await t.point(main(p).getByText(/^Extracted information/).first()); });
      await t.step("Open 'Confirm, edit, reject…' on Preferred location.", () => openObs(t, "Preferred location"));
      await t.step("Kharadi is right — Confirm.", async () => { await t.moveAndClick(obs(p, "Preferred location").getByRole("button", { name: "Confirm" })); await sleep(2000); });
      await t.step("It now shows Confirmed.", () => soft(t, obs(p, "Preferred location").getByText("Confirmed")));
      await t.step("Edit: Anil meant 20,000 sq ft carpet. Open the Area item.", () => openObs(t, "Area needed"));
      await t.step("Type the value and choose Area basis: Carpet.", async () => {
        const o = obs(p, "Area needed"); await t.type(o.getByPlaceholder("Correct value"), "20000", 40);
        const s = o.locator("select[name=area_basis]"); await t.point(s); await s.selectOption("carpet");
      });
      await t.step("Save correction. The original words stay; the item is marked Corrected and logged.", async () => { await t.moveAndClick(obs(p, "Area needed").getByRole("button", { name: "Save correction" })); await sleep(2000); });
      await t.step("Link: attach the area to Marigold Loop Technologies.", async () => {
        await openObs(t, "Area needed"); const s = obs(p, "Area needed").locator("select[name=target]"); await t.point(s); await s.selectOption({ label: "Company · Marigold Loop Technologies" });
      });
      await t.step("Link to record. It is linked, never merged.", async () => { await t.moveAndClick(obs(p, "Area needed").getByRole("button", { name: "Link to record" })); await sleep(2000); });
      await t.step("Ask: the year of 'by September' is unknown. Open Move-in target.", () => openObs(t, "Move-in target"));
      await t.step("Type the question for the client and press Request clarification — it becomes a task for you.", async () => {
        const o = obs(p, "Move-in target"); await t.type(o.getByPlaceholder("Question to ask the client"), "Is it September 2026 or 2027?", 25);
        await t.moveAndClick(o.getByRole("button", { name: "Request clarification" })); await sleep(2000);
      });
      await t.step("Create: when a person or company is not in CRE OS yet, 'Create (for approval)' proposes a new one.", async () => { await openObs(t, "Area needed"); await t.point(obs(p, "Area needed").getByRole("button", { name: "Create (for approval)" })); });
      await t.step("Correction history lists every change you made here.", () => soft(t, main(p).getByText("Correction history")));
      await t.step("Now the Review queue: Capture → Pending reviews.", async () => { await side(t, "Capture"); await t.moveAndClick(main(p).getByRole("link", { name: /Pending reviews/ })); });
      await t.step("Only what needs a person, grouped by reason.", () => t.point(main(p).locator("h1").first()));
      await t.step("Categories: uncertain company or contact matches, potential duplicates, conflicting values, missing units or dates, unverified lease details, material changes.", () => soft(t, main(p).getByText(/^Uncertain contact matches|^Uncertain company matches/)));
      await t.step("Conflicting commercial values: the revised ₹95 quote and the Hinglish 'Unko Kharadi' location are here.", () => soft(t, main(p).getByText(/^Conflicting commercial values/)));
      await t.step("Reject: 'Unko Kharadi' is a misreading. Open it.", async () => { const o = main(p).locator("li").filter({ hasText: "Unko Kharadi" }).filter({ has: p.locator("summary") }).first(); await t.moveAndClick(o.locator("summary")); });
      await t.step("Reject. Nothing on any record changes; the item is just marked Rejected.", async () => {
        await t.moveAndClick(main(p).locator("li").filter({ hasText: "Unko Kharadi" }).filter({ has: p.locator("summary") }).first().getByRole("button", { name: "Reject" })); await sleep(2500);
      });
      await t.step("Material changes requiring approval link to Review, where record changes are approved.", async () => { await t.scroll(1200); await soft(t, main(p).getByText(/^Material database changes/)); });
      await t.outro("confirmed, corrected, linked, questioned and rejected extracted items.", "import a spreadsheet.");
    },
  },
  // ------------------------------------------------------------------ 6. spreadsheet v1
  {
    slug: "import-mapping-validation", category: CAT, title: "Import a spreadsheet: column mapping and validation",
    learn: "Upload an .xlsx or .csv. CRE OS suggests what each column means (with confidence), lets an admin correct the mapping once, and reports invalid emails, phones, ambiguous dates and areas without units — nothing is guessed.",
    tryRoute: "/imports",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Import a spreadsheet", "Automatic column mapping, correcting one mapping, and the validation report.");
      await t.step("Open More → Imports (Capture's 'Upload a spreadsheet' goes to the same place).", () => side(t, "Imports"));
      await t.step("Upload: choose files, an as-of date and the source. Formulas and macros are never run.", () => t.point(main(p).locator("[data-tour=imports-upload]")));
      await t.step("Choose 'Pune contacts.xlsx' — companies, contacts, areas, locations and lease expiries.", async () => { const f = main(p).locator("input[type=file]"); await t.point(f); await f.setInputFiles(path.join(DIR, "Pune contacts.xlsx")); });
      await t.step("Upload and reconcile.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Upload and reconcile" })); await p.waitForURL(/imports\/[0-9a-f-]{36}/, { timeout: 120000 }); await sleep(1500); });
      await t.step("Version 1, its fingerprint and the detected kind: Contacts & requirements.", () => t.point(main(p).locator("h1").first()));
      await t.step("Three steps: 1 already added (companies you had, new people), 2 needs your OK, 3 could not be imported.", () => t.point(main(p).getByText(/This file had/).first()));
      await t.step("Safe rows can be added in one click by an owner or admin. The rest you decide yourself.", () => soft(t, main(p).getByText(/rows are safe to add/)));
      await t.step("Column mapping: each column with the field it was matched to, and how sure CRE OS is.", async () => { await t.point(main(p).getByText(/^Column mapping — /).first()); });
      await t.step("'Area Reqd → Required Area 65%' is a guess to confirm. Unmatched columns are kept as custom values.", () => t.point(main(p).getByText("→ Required Area 65%").first()));
      await t.step("Remarks was mapped to Notes. To keep it as its own column, open 'Correct this mapping'.", () => t.moveAndClick(main(p).getByText("Correct this mapping")));
      await t.step("Column I, Remarks: choose 'Keep as custom'.", async () => { const s = main(p).getByRole("combobox", { name: "Field for column I" }); await t.point(s); await s.selectOption("custom"); });
      await t.step("Approve mapping and re-process. It is remembered for this layout and future files.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Approve mapping and re-process" })); await sleep(5000); await p.reload(); await sleep(1000); });
      await t.step("The mapping card now uses your approved mapping.", () => soft(t, main(p).getByText(/approved mapping/)));
      await t.step("Validation report: rows checked, blocking findings, findings to review and notes.", () => t.point(main(p).getByText("Validation report", { exact: true })));
      await t.step("Open 'Invalid email addresses': cell D3 has a double @ — kept raw, never saved as a contact method.", async () => { const d = main(p).getByText("Invalid email addresses").first(); await t.moveAndClick(d); });
      await t.step("Invalid phone, an area without a unit (not assumed to be sq ft) and a date that could be 4 May or 5 April.", async () => {
        for (const n of ["Invalid telephone numbers", "Areas without a unit", "Ambiguous dates (day/month order)"]) { const d = main(p).getByText(n).first(); if (await d.isVisible().catch(() => false)) { await d.click(); await sleep(300); } }
        await t.point(main(p).getByText("Ambiguous dates (day/month order)").first());
      });
      await t.step("Notes: area basis not stated, dates without a day — kept unknown, not invented.", () => soft(t, main(p).getByText("Area basis not stated")));
      await t.step("Rows with a problem: each finding with its cell and the reason.", async () => { await t.scroll(500); await soft(t, main(p).getByText(/^Rows with a problem/)); });
      await t.step("New people from this file are only proposed — Rahul Khanna has no valid email or phone.", async () => { await t.scroll(900); await soft(t, main(p).getByText(/^New people from this file/)); });
      await t.outro("imported a spreadsheet, corrected one column mapping and read the validation report.", "re-upload an updated version.");
    },
  },
  // ------------------------------------------------------------------ 7. spreadsheet v2
  {
    slug: "import-reupload", category: CAT, title: "Re-upload an updated spreadsheet",
    learn: "Upload a newer file with the same name: it becomes version 2. CRE OS lists changed, added and removed rows and moved columns; rows missing from the new file are never deleted, and every value links back to its source cell.",
    tryRoute: "/imports",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Re-upload an updated spreadsheet", "What changed, why nothing is deleted, and where each value came from.");
      await t.step("Open More → Imports.", () => side(t, "Imports"));
      await t.step("Choose the updated 'Pune contacts.xlsx' — same name, new content.", async () => { const f = main(p).locator("input[type=file]"); await t.point(f); await f.setInputFiles(path.join(DIR, "v2", "Pune contacts.xlsx")); });
      await t.step("Upload and reconcile.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Upload and reconcile" })); await p.waitForURL(/imports\/[0-9a-f-]{36}/, { timeout: 120000 }); await sleep(1500); });
      await t.step("It is version 2 of the same source. Uploading the identical file again would change nothing.", () => t.point(main(p).getByText(/^v2 ·/).first()));
      await t.step("Changes summary: companies and people you already had are linked, not duplicated.", () => t.point(main(p).getByText(/This file had/).first()));
      await t.step("Column layout changed: a Budget column was added, and Mobile and Email swapped places.", async () => { await t.scroll(700); await t.point(main(p).getByText("Column layout changed since the previous version")); });
      await t.step("Columns are matched by header, not position, so the swap breaks nothing.", () => t.point(main(p).getByText(/Columns are matched by their headers/)));
      await t.step("Rows missing from the new version are reported only — no record is deleted or archived.", () => t.point(main(p).getByText(/no record is deleted or archived/).first()));
      await t.step("Open Technical details for the row-by-row comparison.", () => t.moveAndClick(main(p).getByText(/^Technical details/)));
      await t.step("Changes vs previous version: changed, added and removed rows, field by field.", async () => { await t.scroll(500); await t.point(main(p).getByText("Changes vs previous version").first()); });
      await t.step("Kavita Nair's area went from 15,000 to 18,000 sq ft. The earlier observation is kept.", () => soft(t, main(p).getByText(/"15,000 sq ft" → "18,000 sq ft"/)));
      await t.step("Values that differ from your records are never overwritten — they are proposed for approval.", async () => { await t.scroll(900); await soft(t, main(p).getByText(/^Values that differ from your records/)); });
      await t.step("All imports lists both versions with their fingerprints.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: "All imports" }).first()); await soft(t, main(p).getByText("Pune contacts.xlsx")); });
      await t.step("Source cell links: open a company from the file — Pebblewick Software.", async () => {
        const id = sql(`select id from mudar.organisation where workspace_id='${WS}' and display_name='Pebblewick Software' and archived_at is null limit 1`);
        await t.goto(`/companies/${id}`); await t.point(main(p).locator("h1").first());
      });
      await t.step("'Source (spreadsheet rows)' shows the file, version, sheet and cell behind each value.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: /^Source \(/ })); await sleep(800); await t.point(main(p).getByText(/Pune contacts.xlsx · v/).first()); });
      await t.outro("re-uploaded a spreadsheet, read what changed and saw nothing was deleted.", "upload many files at once.");
    },
  },
  // ------------------------------------------------------------------ 8. batch
  {
    slug: "import-batch-files", category: CAT, title: "Upload many files at once",
    learn: "Pick several files — spreadsheets, PDFs, Word, CSV. They are processed one by one in the background with a progress bar; the completion report counts files and records, and temporary failures can be retried.",
    tryRoute: "/imports",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Upload many files at once", "Batch progress, the completion report and retrying a failed file.");
      await t.step("Open More → Imports.", () => side(t, "Imports"));
      await t.step("Choose five files at once: a brochure PDF, site-visit notes in Word, two contact lists and an old 2019 .xls tracker.", async () => {
        const f = main(p).locator("input[type=file]"); await t.point(f);
        await f.setInputFiles(["Hinjewadi brochure.pdf", "Site visit notes - Kharadi.docx", "Wakad contacts.csv", "Baner availability.xlsx", "Old tracker 2019.xls"].map((x) => path.join(DIR, "batch", x)));
      });
      await t.step("Upload and reconcile.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: "Upload and reconcile" })); await p.waitForURL(/imports\/runs\//, { timeout: 120000 }); await sleep(1500); });
      await t.step("The batch page. Files are processed in the background — you can keep working; this page updates by itself.", () => t.point(main(p).getByText(/Processing in the background/)));
      await t.step("The old .xls failed straight away: old format. Save it as .xlsx and add it again — the original is kept.", () => t.point(main(p).locator("li").filter({ hasText: "Old tracker 2019.xls" }).first()));
      await t.step("Progress: files are read one by one…", async () => { tsx("jobs", "--fail-first", "Baner availability.xlsx", "--max", "2"); await sleep(5000); await t.point(main(p).getByText(/% ·/).first()); });
      await t.step("Documents go to capture for extraction; spreadsheets to the import engine.", async () => { tsx("jobs", "--fail-first", "Baner availability.xlsx"); await sleep(5000); await p.reload(); await sleep(800); await t.point(main(p).getByText("Files", { exact: true }).first()); });
      await t.step("Completion report: files received, processed, partly processed, failed; records identified, created and linked; duplicates, conflicts and items to review.", () => t.point(main(p).getByText("Completion report")));
      await t.step("'Partly processed' means a document has items waiting for your review — open its extraction review.", () => soft(t, main(p).locator("li").filter({ hasText: "Site visit notes" }).getByRole("link", { name: /Open extraction review/ })));
      await t.step("Baner availability.xlsx failed for a temporary reason (a timeout), so it can be retried.", () => t.point(main(p).locator("li").filter({ hasText: "Baner availability.xlsx" }).first()));
      await t.step("One failed file never undoes another file's results.", () => soft(t, main(p).getByText(/one failing file never undoes/)));
      await t.step("Press 'Retry 1 failed file'. Only failed files are tried again.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: /Retry 1 failed file/ })); await sleep(1500); });
      await t.step("After the retry it is processed; reload to see the new status.", async () => { tsx("jobs"); await sleep(1500); await p.reload(); await sleep(1000); await t.point(main(p).locator("li").filter({ hasText: "Baner availability.xlsx" }).first()); });
      await t.step("'Open import report' shows that file's own mapping, validation and rows.", () => soft(t, main(p).locator("li").filter({ hasText: "Baner availability.xlsx" }).getByRole("link", { name: /Open import report/ })));
      await t.step("All imports keeps every batch with its report.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: "All imports" }).first()); await soft(t, main(p).getByText("Batch uploads")); });
      await t.outro("uploaded five files at once, read the completion report and retried a failed file.", "find where a value came from.");
    },
  },
  // ------------------------------------------------------------------ 9. provenance
  {
    slug: "find-value-source", category: CAT, title: "Find where a value came from",
    learn: "Company, person and building pages link to their evidence: 'Source' shows the spreadsheet file, version, sheet and cell of each value; 'From capture' opens the note or document it was read from. Capture history lists everything captured.",
    tryRoute: "/capture/history",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Find where a value came from", "Spreadsheet cells, captured notes and documents — and the full capture history.");
      const peb = sql(`select id from mudar.organisation where workspace_id='${WS}' and display_name='Pebblewick Software' and archived_at is null limit 1`);
      const mar = sql(`select id from mudar.organisation where workspace_id='${WS}' and display_name='Marigold Loop Technologies' and archived_at is null limit 1`);
      await t.step("Open Companies and a company that came from a spreadsheet: Pebblewick Software.", async () => { await side(t, "Companies"); await t.goto(`/companies/${peb}`); await t.point(main(p).locator("h1").first()); });
      await t.step("Under the name: 'Source (n spreadsheet rows)'. People and buildings have the same link.", () => t.point(main(p).getByRole("link", { name: /^Source \(/ })));
      await t.step("Open it.", () => t.moveAndClick(main(p).getByRole("link", { name: /^Source \(/ })));
      await t.step("One card per spreadsheet row behind this record: file name, version and the sheet!row.", () => t.point(main(p).getByText(/Pune contacts.xlsx · v/).first()));
      await t.step("Each field with its exact cell (for example Contacts!F2) and the value as it was in the file.", () => t.point(main(p).locator("table").first()));
      await t.step("Open original downloads that version of the file; 'import report' opens the import.", () => soft(t, main(p).getByRole("link", { name: "Open original" })));
      await t.step("Value history: imported values that disagreed with the record. Imports never overwrite a saved value.", async () => { await t.scroll(800); await t.point(main(p).getByText("Value history")); });
      await t.step("Now a company with captured evidence: Marigold Loop Technologies.", async () => { await t.goto(`/companies/${mar}`); await t.point(main(p).locator("h1").first()); });
      await t.step("'From capture' counts the extracted items linked to this company.", () => t.point(main(p).getByRole("link", { name: /^From capture/ })));
      await t.step("Open it: the note it came from, with the receipt, the original words and your corrections.", async () => { await t.moveAndClick(main(p).getByRole("link", { name: /^From capture/ })); await p.waitForURL(/\/capture\//); await sleep(800); await t.point(card(p, "Note")); });
      await t.step("Each extracted item says its source: the note or file, page, when it was observed and how it was verified.", async () => { await t.scroll(500); await soft(t, main(p).getByText(/^Source: /)); });
      await t.step("Capture history lists everything ever captured: Capture → Capture history.", async () => { await side(t, "Capture"); await t.moveAndClick(main(p).getByRole("link", { name: "Capture history" })); });
      await t.step("Each entry: type, status, date, how many items were extracted, your corrections and linked records.", () => t.point(main(p).locator("li").first()));
      await t.step("Click any entry to open the original note or file and its extracted items.", () => t.point(main(p).locator("li a").first()));
      await t.outro("traced values to their spreadsheet cell and to the capture they came from.", "open Ask AI and search your captures.");
    },
  },
];

module.exports = { FLOWS, prepare };
