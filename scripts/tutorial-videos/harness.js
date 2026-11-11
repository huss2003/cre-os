// Tutorial video harness: drives the real app with playwright-core and records each flow to a WebM.
const fs = require("fs");
const path = require("path");
const PW = process.env.PLAYWRIGHT_CORE || "/tmp/pw/node_modules/playwright-core";
const { chromium } = require(PW);

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const OVERLAY = fs.readFileSync(path.join(__dirname, "overlay.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEW = { width: 1280, height: 800 };

async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

async function login(browser, statePath) {
  const ctx = await browser.newContext({ viewport: VIEW });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.fill("input[name=email]", process.env.TUT_EMAIL || "owner@cre-os.local");
  await p.fill("input[name=password]", process.env.TUT_PASSWORD || "password123");
  await Promise.all([p.waitForURL((u) => !u.toString().includes("/login"), { timeout: 90000 }), p.press("input[name=password]", "Enter")]);
  await ctx.storageState({ path: statePath });
  await ctx.close();
}

/** Record one flow. Returns { webm, steps: [{caption, ms}], trimMs, durationMs }. */
async function recordFlow(browser, statePath, flow, outDir, opts = {}) {
  const ctx = await browser.newContext({
    viewport: VIEW, deviceScaleFactor: 1, storageState: statePath, reducedMotion: "no-preference",
    ...(opts.noVideo ? {} : { recordVideo: { dir: outDir, size: VIEW } }),
  });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const t0 = Date.now();
  let trimMs = 0, n = 0;
  const steps = [];
  const ev = (fn, ...a) => page.evaluate(([f, args]) => window.__tut && window.__tut[f](...args), [fn, a]).catch(() => {});

  const settle = async () => { await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await sleep(300); };
  const t = {
    page, sleep, BASE,
    async goto(route) { await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 90000 }); await settle(); },
    /** Intro card. Video is trimmed so it starts on this card. */
    async title(text, sub, list) {
      await ev("card", "CRE OS tutorial", text, sub, list || []);
      await sleep(150);
      trimMs = Date.now() - t0;
      await sleep(opts.titleMs || 3200);
      await ev("card", null, null);
      await sleep(400);
    },
    async outro(did, next) {
      await ev("caption", null, null);
      await ev("ring", null);
      await ev("card", "Done", `You did: ${did}`, next ? `Next: ${next}` : "", []);
      await sleep(3200);
    },
    async step(caption, fn) {
      n += 1;
      steps.push({ caption, ms: Math.max(0, Date.now() - t0 - trimMs) });
      await ev("ring", null);
      await ev("caption", n, caption);
      await sleep(700);
      if (fn) await fn();
      await settle();
      await sleep(opts.pauseMs || 1300);
    },
    async point(locator) {
      const loc = locator.filter({ visible: true }).first();
      await loc.waitFor({ state: "visible", timeout: 30000 });
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(250);
      const b = await loc.boundingBox();
      if (!b) throw new Error("no bounding box");
      const x = Math.round(b.x + Math.min(b.width / 2, 60)), y = Math.round(b.y + b.height / 2);
      await ev("move", x, y);
      await sleep(560);
      await ev("ring", { x: b.x, y: b.y, width: b.width, height: b.height });
      return { loc, x, y };
    },
    async moveAndClick(locator, clickOpts) {
      const { loc, x, y } = await t.point(locator);
      await sleep(350);
      await ev("ripple", x, y);
      await loc.click(clickOpts);
      await sleep(250);
    },
    async type(locator, text, delay = 38) {
      const { loc } = await t.point(locator);
      await loc.click();
      await loc.pressSequentially(text, { delay });
    },
    /** Smoothly scroll the page (or main scroller) by dy pixels. */
    async scroll(dy) {
      await page.mouse.move(700, 450);
      const parts = 12;
      for (let i = 0; i < parts; i++) { await page.mouse.wheel(0, dy / parts); await sleep(40); }
      await sleep(400);
    },
  };

  let error = null;
  try { await flow.run(t); } catch (e) { error = e; await page.screenshot({ path: path.join(outDir, `${flow.slug}-FAILED.png`) }).catch(() => {}); }
  const durationMs = Date.now() - t0 - trimMs;
  const video = page.video();
  await ctx.close();
  const webm = video ? await video.path() : null;
  if (error) { error.webm = webm; throw error; }
  return { webm, steps, trimMs, durationMs };
}

module.exports = { launch, login, recordFlow, BASE, sleep };
