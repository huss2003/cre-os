// Shared helpers for the module 2 v2 / 14 / 15 / 16 / AI-policy tutorial flows (flows-signals2, flows-leases,
// flows-transactions, flows-supply, flows-ai-settings). Not a flow module itself (record.js only loads flows*.js).
const path = require("path");
const { execFileSync } = require("child_process");
const { sleep } = require("./harness");

const ROOT = path.resolve(__dirname, "../..");
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const WS = "de000000-0000-4000-8000-000000000001";
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-Atc", q], { stdio: "pipe" }).toString().trim();
/** Run a setup-<group>.ts script (demo workspace only). Prints its last line (ids) for debugging. */
const runSetup = (file, ...args) => {
  const out = execFileSync("npx", ["tsx", "--require", "./scripts/assistant-evals.preload.cjs", "--env-file=.env.local", `scripts/tutorial-videos/${file}`, ...args],
    { cwd: ROOT, stdio: "pipe", timeout: 600000 }).toString().trim();
  return out.split("\n").pop();
};

const nav = (p) => p.getByRole("navigation", { name: "Main" }).first();
const main = (p) => p.locator("main");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const field = (p, name) => main(p).locator(`[name="${name}"]`).filter({ visible: true }).first();

/** Always record in the synthetic demo workspace. */
async function start(t, route = "/today") {
  t.page.on("dialog", (d) => d.accept().catch(() => {}));
  await t.page.context().addCookies([{ name: "cre_ws", value: WS, url: t.BASE }]);
  await t.goto(route);
}
/** Click a sidebar link, opening the folded "More" group first when needed. */
async function side(t, name) {
  const p = t.page;
  const link = nav(p).getByRole("link", { name: new RegExp(`^${esc(name)}`) });
  if (!(await link.first().isVisible().catch(() => false))) { await t.moveAndClick(nav(p).getByRole("button", { name: /More/ })); await sleep(400); }
  await t.moveAndClick(link);
}
/** Point at something if it is on screen; otherwise scroll on (optional details never fail a video). */
async function soft(t, loc, timeout = 5000) {
  try { await loc.first().waitFor({ state: "visible", timeout }); await t.point(loc); return true; } catch {
    if (process.env.SOFT_LOG) console.log(`\n   [soft miss] ${String(loc).slice(0, 200)}`);
    await t.scroll(250); return false;
  }
}
/** A <Card title=…> (section with an h2). */
const card = (p, title) => main(p).getByRole("heading", { name: title instanceof RegExp ? title : new RegExp(`^${esc(title)}`) }).first().locator("xpath=ancestor::section[1]");
/** Bring a heading/card into view and ring it. */
async function showCard(t, title) { const c = card(t.page, title); await c.scrollIntoViewIfNeeded().catch(() => {}); await t.point(c.getByRole("heading").first()); return c; }
/** A sub-tab link at the top of a section (e.g. Leases → Calendar). */
async function subTab(t, name) { await t.moveAndClick(main(t.page).getByRole("link", { name, exact: true }).first()); }
/** Choose a <select> option by its visible label, pointing at the control first. */
async function choose(t, loc, label) { await t.point(loc); await loc.selectOption({ label }); await sleep(300); }
/** Fill a field visibly (types short text, fills long text). */
async function fill(t, loc, text) {
  await t.point(loc);
  if (String(text).length > 60) { await loc.fill(String(text)); } else { await loc.click(); await loc.fill(""); await loc.pressSequentially(String(text), { delay: 25 }); }
}
/** Submit a server-action form button and wait for the page to settle. */
async function submit(t, btn) { await t.moveAndClick(btn); await t.page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}); await sleep(800); }

module.exports = { ROOT, DB, WS, sql, runSetup, nav, main, esc, field, start, side, soft, card, showCard, subTab, choose, fill, submit, sleep };
