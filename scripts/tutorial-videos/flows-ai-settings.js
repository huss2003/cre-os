// Tutorial videos — group "ai-settings": Settings → AI use (per-feature Off / Backup / On, docs/ai-policy.md) and reading a
// business-card photo with local OCR (tesseract, no AI call).
// Demo data: setup-ai-settings.ts: prepare sets only "Reading text from images & scans" to Off (the demo owner cannot save this page
// without two-step sign-in, so the videos never save it), finish resets all AI modes to defaults. It also writes a synthetic
// card photo to /tmp/tutorial-ai/card-rhea-kulkarni.png. Captions describe only what is on screen.
const path = require("path");
const { runSetup, main, start, side, soft, card, fill, submit, sleep } = require("./new-modules-common");

const CAT = "Review & settings";
const DIR = process.env.TUT_AI_DIR || "/tmp/tutorial-ai";
const CARD = path.join(DIR, "card-rhea-kulkarni.png");
const group = (p, label) => main(p).locator(`fieldset[aria-label="${label}: AI use"]`);
const featureRow = (p, label) => main(p).locator("li").filter({ has: p.locator(`fieldset[aria-label="${label}: AI use"]`) }).first(); // `has` must be a relative locator
async function openAiSettings(t) {
  const p = t.page;
  // Settings sits in the sidebar footer, outside the "Main" navigation landmark.
  await t.moveAndClick(p.getByRole("link", { name: "Settings", exact: true }).first());
  await t.moveAndClick(main(p).getByRole("link", { name: "AI use", exact: true }).first());
  await p.waitForURL(/\/settings\/ai/, { timeout: 30000 }).catch(() => {});
}

function prepare() { console.log(" setup-ai-settings:", runSetup("setup-ai-settings.ts", "--ocr-off")); }
function finish() { try { runSetup("setup-ai-settings.ts"); } catch (e) { console.log(" (could not reset AI modes)", e.message); } }

const FLOWS = [
  // ------------------------------------------------------------------ 1. AI use settings
  {
    slug: "ai-use-settings", category: CAT, title: "Settings → AI use: Off, Backup or On per feature",
    learn: "Choose for each feature whether CRE OS uses code only (Off), code first with AI as a backup (Backup), or AI first with code as the fallback (On). Features are grouped into runs on code, code first, and needs AI. Off means no AI call at all. The owner needs two-step sign-in to save changes.",
    tryRoute: "/settings/ai",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("AI use, feature by feature", "Code is the default. You decide where AI is allowed.");
      await t.step("Open Settings at the bottom of the sidebar, then the AI use tab.", () => openAiSettings(t));
      await t.step("The summary: how many features use AI, how many run on code only, and how many AI calls were avoided this month.", () => soft(t, main(p).getByText(/AI is used for/)));
      await t.step("Off = code only. Backup = code first, AI only when code can't read the input. On = AI first, code if AI fails. Nothing is lost when a feature is Off.", () => soft(t, main(p).getByText(/^Off = code only/)));
      await t.step("Runs on code: rules and templates do these well — morning brief, daily plan, score explanations, outreach drafts and more. AI is off by default.", () => t.point(main(p).getByRole("heading", { name: "Runs on code" })));
      await t.step("Each feature says what it does and whether it is on its default.", () => t.point(featureRow(p, "Morning brief")));
      await t.step("Code first, AI as backup: capture fields, lease terms, quotes, legal clauses and reading text from photos. Code tries first.", async () => { const h = main(p).getByRole("heading", { name: "Code first, AI as backup" }); await h.scrollIntoViewIfNeeded(); await t.point(h); });
      await t.step("Needs AI: voice transcription, web research, signal discovery and open writing — code can't do these well.", async () => { const h = main(p).getByRole("heading", { name: "Needs AI" }); await h.scrollIntoViewIfNeeded(); await t.point(h); });
      await t.step("Each switch has three positions. Off, Backup or On — hover a position to see what it means.", () => t.point(group(p, "Web research")));
      await t.step("A changed feature says so, with its default. Here 'Reading text from images & scans' is set to Off — code only.", () => soft(t, featureRow(p, "Reading text from images & scans").getByText(/changed/)));
      await t.step("To change a switch: pick the position, then press Save at the bottom. Reset to defaults puts every feature back (you confirm first).", async () => {
        const b = main(p).getByRole("button", { name: "Save", exact: true }); await b.scrollIntoViewIfNeeded().catch(() => {}); await t.point(b);
      });
      await t.step("For the workspace owner, saving needs two-step sign-in first. The note links to Settings → Security, where you turn it on.", () => soft(t, main(p).getByText(/two-step sign-in/).first()));
      await t.step("Open Security & MFA to see the two-step sign-in set-up.", () => t.moveAndClick(main(p).getByRole("link", { name: "Security & MFA", exact: true }).first()));
      await t.step("After setting it up, come back to AI use: the switches can be changed and saved. When a feature is Off, CRE OS makes no AI call at all.", () => t.point(main(p).getByRole("heading", { level: 1 }).first()));
      await t.outro("saw how each feature can be set to Off, Backup or On, and what saving needs.", "read a business card with local OCR — no AI.");
    },
  },

  // ------------------------------------------------------------------ 2. local OCR business card
  {
    slug: "local-ocr-business-card", category: CAT, title: "Read a business card without AI (local OCR)",
    learn: "With 'Reading text from images & scans' set to Off, a business-card photo is still read — by local OCR on the server, with no AI call. The card's name, title, company, email and phone become observations, and a new contact is proposed for your approval in Review.",
    tryRoute: "/capture",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Business cards without AI", "Text in photos is read locally — no AI call, nothing sent out.");
      await t.step("Open Settings → AI use.", () => openAiSettings(t));
      await t.step("Reading text from images & scans: by default Backup — local text reading first, AI vision only if that finds nothing.", () => t.point(featureRow(p, "Reading text from images & scans")));
      await t.step("In this workspace it is set to Off — code only. So no AI is allowed to read photos.", () => t.point(group(p, "Reading text from images & scans").getByText("Off", { exact: true })));
      await t.step("Now open Capture from the sidebar.", () => side(t, "Capture"));
      await t.step("Choose Photo — for visiting cards and whiteboards.", () => t.moveAndClick(main(p).getByRole("radio", { name: /^Photo/ }).first()));
      await t.step("Pick the photo of Rhea Kulkarni's card.", async () => { const f = main(p).locator('input[type=file][name="file"]').first(); await f.setInputFiles(CARD); await t.point(main(p).getByText("Photo", { exact: true }).first()); });
      await t.step("Say what it is.", () => fill(t, main(p).getByPlaceholder(/Visiting card of the landlord/), "Visiting card from Quillstone site visit"));
      await t.step("Save capture. The photo is stored and read straight away.", async () => { await submit(t, main(p).getByRole("button", { name: "Save capture" })); await p.waitForURL(/\/capture\/[0-9a-f-]{36}/, { timeout: 120000 }); });
      await t.step("The review screen. The photo's text was read on the server by local OCR — no AI call. It is context, never proof of terms.", () => soft(t, main(p).getByText(/Photo text read/).first(), 15000));
      await t.step("The text from the card: name, title, company, email and phone.", () => soft(t, main(p).getByText(/rhea\.kulkarni@quillstone\.example/i).first(), 10000));
      await t.step("What was found becomes observations, and a new contact is proposed. It waits for your approval in Review — nothing is changed without you.", () => soft(t, main(p).getByText(/Rhea Kulkarni/).first()));
      await t.step("Nothing was sent out to read the card. Approve the proposed contact in Review when you have checked it.", () => t.point(p.getByRole("link", { name: /^Review/ }).first()));
      await t.outro("read a business card with local OCR while AI was off.", "approve the proposed contact in Review.");
    },
  },
];

module.exports = { FLOWS, prepare, finish };
