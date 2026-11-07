// E2E smoke: log in as seeded owner, visit every nav route at phone + desktop width, fail on error pages/console errors.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const routes = ["/today","/capture","/approvals","/tasks","/calendar","/drafts","/search","/companies","/people","/buildings","/leases",
  "/requirements","/deals","/finance","/documents","/fees","/research","/network","/market","/legal","/content","/insights",
  "/database","/geography","/imports","/settings","/settings/connections","/settings/security","/admin","/platform",
  "/approvals/conflicts","/approvals/stale","/content/calendar","/fees/reconcile","/finance/compare","/imports/sources","/research/sources","/drafts?tab=sequences"];
const browser = await chromium.launch();
const results = [];
for (const vp of [{ width: 390, height: 844, name: "phone" }, { width: 1366, height: 900, name: "desktop" }]) {
  const page = await browser.newPage({ viewport: vp });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', "owner@cre-os.local");
  await page.fill('input[name="password"]', "password123");
  await Promise.all([page.waitForURL(/\/today/, { timeout: 60000 }), page.click('button:has-text("Sign in")')]);
  // Optional: run the pass inside another workspace the user belongs to (e.g. the real-data test workspace).
  if (process.env.SMOKE_WS) await page.context().addCookies([{ name: "cre_ws", value: process.env.SMOKE_WS, url: BASE }]);
  for (const r of routes) {
    errors.length = 0;
    const res = await page.goto(BASE + r, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => ({ status: () => "ERR " + e.message }));
    const status = res?.status?.();
    const text = await page.locator("body").innerText().catch(() => "");
    const bad = status !== 200 || /Application error|Unhandled Runtime Error|This page could not be found/i.test(text) || errors.length > 0;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2).catch(() => false);
    results.push({ vp: vp.name, route: r, status, bad, overflow, errors: errors.slice(0, 2) });
    if (vp.name === "phone" && ["/today","/capture","/approvals","/search"].includes(r)) await page.screenshot({ path: `/tmp/shot-${r.replaceAll("/","_")}.png` });
  }
  await page.close();
}
await browser.close();
for (const r of results) console.log(`${r.bad ? "FAIL" : "ok  "} ${r.vp.padEnd(7)} ${String(r.status).padEnd(4)} ${r.route}${r.overflow ? "  [horizontal overflow]" : ""} ${r.errors.join(" | ")}`);
process.exit(results.some((r) => r.bad) ? 1 : 0);
