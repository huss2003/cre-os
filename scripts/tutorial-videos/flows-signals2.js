// Tutorial videos — group "signals2": Module 2 Signal Engine v2 (dashboard views + filters, paste → 12-section signal card,
// counter-evidence, unresolved company, decisions, sources page + research universe).
// Demo data: setup-signals2.ts (run in prepare; needs the companies from setup-leases.ts). Fresh synthetic signals each run:
// Peregrine Loom Studios (demo) new office, Quillstone Labs (demo) expansion + funding, Ottervale Systems (unmatched company).
// Signals are rule-detected (no AI). Captions describe only what is on screen.
const { WS, sql, runSetup, main, field, start, side, soft, card, choose, fill, submit, sleep } = require("./new-modules-common");

const CAT = "Signals, scores & contacts";
const sigId = (titleLike) => sql(`select id from mudar.signal where workspace_id='${WS}' and archived_at is null and title like '${titleLike.replace(/'/g, "''")}' order by created_at desc limit 1`);
/** One of the 12 numbered card sections (a <details>); opened if folded. */
const section = (p, n) => main(p).locator("details").filter({ has: p.locator("summary", { hasText: new RegExp(`^${n}\\. `) }) }).first();
async function openSection(t, n) {
  const d = section(t.page, n);
  await d.scrollIntoViewIfNeeded().catch(() => {});
  if (await d.evaluate((el) => el.open).catch(() => false)) await t.point(d.locator("summary").first()); else await t.moveAndClick(d.locator("summary").first());
  await sleep(300);
  return d;
}
/** Open a signal by searching for it on /signals (falls back to its URL). */
async function openSignal(t, search, titleLike) {
  const p = t.page;
  await side(t, "Signals");
  await fill(t, main(p).getByRole("textbox", { name: "Search signals" }), search);
  await submit(t, main(p).getByRole("button", { name: "Search", exact: true }));
  const link = main(p).getByRole("link", { name: new RegExp(titleLike.replace(/%/g, ".*").replace(/[()]/g, "\\$&")) }).first();
  if (await link.isVisible().catch(() => false)) await t.moveAndClick(link); else await t.goto(`/signals/${sigId(titleLike)}`);
  await p.waitForURL(/\/signals\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {});
}
const paste = async (t, company, text) => {
  const p = t.page;
  const d = main(p).locator("details").filter({ has: p.locator("summary", { hasText: "Paste news or a note" }) }).first();
  if (!(await d.evaluate((el) => el.open).catch(() => false))) await t.moveAndClick(d.locator("summary"));
  if (company) await fill(t, d.locator('[name="company"]'), company);
  await fill(t, d.locator('[name="text"]'), text);
  return d;
};

function prepare() { console.log(" setup-signals2:", runSetup("setup-signals2.ts")); }

const FLOWS = [
  // ------------------------------------------------------------------ 1. dashboard views + filters
  {
    slug: "signals-dashboard-v2", category: CAT, title: "Signals: views, the 12-month strip and every filter",
    learn: "Open Signals: open and act-now counts, Sources and Scan now, the next-12-months strip, the views (all, high priority, expansion, restructuring, lease, commercial, leadership, infrastructure, unverified, dismissed & snoozed), search and the full filter panel.",
    tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("The signals dashboard", "News and events about companies you track — with the evidence behind each one.");
      await t.step("Open Signals from the sidebar, under Work.", () => side(t, "Signals"));
      await t.step("The header counts open signals and how many to act on now.", () => t.point(main(p).getByRole("heading", { level: 1, name: /^Signals/ })));
      await t.step("Sources shows where signals come from. Scan now checks your own records — leases, occupancy, availability — for new signals.", () => t.point(main(p).getByRole("button", { name: "Scan now" })));
      await t.step("Next 12 months: each dot is a dated event, coloured by category. Click a dot to open it.", () => soft(t, main(p).getByRole("heading", { name: /^Next 12 months/ })));
      await t.step("Views on the left: All, High priority, Expansion, Restructuring, Lease events, Commercial, Leadership, Infrastructure, Unverified, Dismissed & snoozed. The number is how many are open.", () => t.point(main(p).getByRole("navigation", { name: "Signal views" })));
      await t.step("Open the Expansion view.", () => t.moveAndClick(main(p).getByRole("navigation", { name: "Signal views" }).getByRole("link", { name: /^Expansion/ })));
      await t.step("Each card: category and type, the company, place, priority, evidence strength bars and status.", () => soft(t, main(p).getByRole("link", { name: /Peregrine Loom/ }).first()));
      await t.step("Search finds a company, a place or words in the evidence.", async () => { await fill(t, main(p).getByRole("textbox", { name: "Search signals" }), "Pune"); await submit(t, main(p).getByRole("button", { name: "Search", exact: true })); });
      await t.step("Open Filters for the full set.", () => t.moveAndClick(main(p).locator("summary", { hasText: /^Filters/ }).first()));
      await t.step("Company, industry, micro-market, category and type, and the source.", () => t.point(field(p, "orgId")));
      await t.step("Event dates, detected dates and freshness — for example evidence from the last 30 days.", () => choose(t, field(p, "freshDays"), "Last 30 days"));
      await t.step("Confidence (strong, moderate, weak), urgency (act now, this month, watch), status and who it is assigned to.", () => choose(t, field(p, "urgency"), "Watch"));
      await t.step("Sort by priority, newest detected or soonest event. Apply filters.", async () => { await choose(t, field(p, "sort"), "Newest detected"); await submit(t, main(p).getByRole("button", { name: "Apply filters" })); });
      await t.step("The badge shows how many filters are on; Clear removes them. The link can be shared — the filters are in the address.", () => soft(t, main(p).locator("summary", { hasText: /^Filters/ }).getByRole("link", { name: "Clear" })));
      await t.step("At the bottom: the bars show evidence strength, and the colour key for categories.", async () => { const l = main(p).getByText(/^Bars show how strong/); await l.scrollIntoViewIfNeeded().catch(() => {}); await soft(t, l); });
      await t.outro("used views, search and filters to find the signals that matter.", "paste news and read a signal card.");
    },
  },

  // ------------------------------------------------------------------ 2. paste → 12-section card
  {
    slug: "signal-card-v2", category: CAT, title: "Paste news and read the 12-section signal card",
    learn: "Paste an announcement: rules find the event, match the company and create a signal. The card shows what happened, why it matters, evidence for and against, company records, offices, occupancy, lease events, contacts, requirements, counter-evidence, missing information and next steps — each labelled fact, inference, hypothesis or unknown.",
    tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("From pasted news to a signal", "Every claim on the card says whether it is a fact, an inference, a hypothesis or unknown.");
      await t.step("Open Signals and press Paste news or a note.", async () => { await side(t, "Signals"); await t.moveAndClick(main(p).locator("summary", { hasText: "Paste news or a note" })); });
      await t.step("Name the company (optional — it is taken from the text when left blank) and paste the announcement.", () => paste(t, "Lumen Harbour Tech (demo)",
        "Lumen Harbour Tech (demo) plans to open a second office in Kharadi, Pune, adding 300 seats by Q2 2027."));
      await t.step("The text is only scanned for events — instructions inside it are ignored. Press Find signals.", () => submit(t, main(p).getByRole("button", { name: "Find signals" })));
      await t.step("The result: how many signals were found and how many are new.", () => soft(t, main(p).getByText(/signal\(s\) found/).first()));
      await t.step("Open the new Lumen Harbour Tech signal.", async () => { await fill(t, main(p).getByRole("textbox", { name: "Search signals" }), "Lumen Harbour"); await submit(t, main(p).getByRole("button", { name: "Search", exact: true }));
        await t.moveAndClick(main(p).getByRole("link", { name: /Lumen Harbour Tech/ }).first()); });
      await t.step("The header: category and type, company and place, detected and event dates, evidence sources, priority out of 100, evidence strength, verification and status.", () => t.point(main(p).getByRole("heading", { level: 1 }).first()));
      await t.step("1. What happened — labelled HYPOTHESIS: rule-detected from the text, to verify before relying on it.", () => openSection(t, 1));
      await t.step("2. Why it matters — an INFERENCE: expansion can create a space need; it is not proof.", () => openSection(t, 2));
      await t.step("3. Supporting evidence: FOR and AGAINST, with source, date and reliability, plus how many independent sources.", () => openSection(t, 3));
      await t.step("4. Related company records, 5. Known office locations and 6. Existing occupancy — facts from your records.", async () => { await openSection(t, 4); await openSection(t, 5); await openSection(t, 6); });
      await t.step("7. Relevant lease events: the company's lease with Leases — expiry, renewal and notice dates.", () => openSection(t, 7));
      await t.step("8. Related contacts and 9. Existing requirements.", async () => { await openSection(t, 8); await openSection(t, 9); });
      await t.step("10. Counter-evidence and 11. Missing information — what is unknown is said, never filled in.", async () => { await openSection(t, 10); await openSection(t, 11); });
      await t.step("12. Suggested next steps.", () => openSection(t, 12));
      await t.step("On the right: the same points sorted into Fact, Inference, Hypothesis and Unknown, and Priority — why, with each point added or taken away.", () => soft(t, card(p, "Priority — why")));
      await t.step("History records every decision and re-assessment.", () => soft(t, card(p, "History")));
      await t.outro("pasted news and read every section of the signal card.", "add counter-evidence.");
    },
  },

  // ------------------------------------------------------------------ 3. counter-evidence
  {
    slug: "signal-counter-evidence", category: CAT, title: "Counter-evidence lowers a signal's priority",
    learn: "Paste news that contradicts an open signal (\"hires will work remotely\", \"no additional office space\"): it is attached as AGAINST evidence and the signal is re-assessed. You can also add supporting or counter-evidence on the card.",
    tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Counter-evidence", "News that says the opposite counts too — and lowers the priority.");
      await t.step("Open the Quillstone Labs expansion signal from Signals.", () => openSignal(t, "Quillstone", "Quillstone Labs (demo): possible focus-city office expansion"));
      await t.step("Note its priority now.", () => soft(t, main(p).getByText(/\/100/).first()));
      await t.step("Section 3 shows one source FOR the expansion.", () => openSection(t, 3));
      await t.step("Back on Signals, paste a later report that contradicts it.", async () => {
        await side(t, "Signals");
        await paste(t, "Quillstone Labs (demo)", "Quillstone Labs (demo) said the new engineers will work remotely and it needs no additional office space in Pune.");
      });
      await t.step("Find signals. The message says the text was attached as counter-evidence to the open signal.", () => submit(t, main(p).getByRole("button", { name: "Find signals" })));
      await t.step("The result message.", () => soft(t, main(p).getByText(/counter|against/i).first()));
      await t.step("Open the Quillstone Labs expansion signal again.", async () => { await t.goto(`/signals/${sigId("Quillstone Labs (demo): possible focus-city office expansion")}`); });
      await t.step("The priority has dropped.", () => soft(t, main(p).getByText(/\/100/).first()));
      await t.step("Section 3 now has the report under AGAINST.", () => openSection(t, 3));
      await t.step("And section 10, Counter-evidence, lists it.", () => openSection(t, 10));
      await t.step("You can also add evidence by hand: what the source says, its name and link, then Add supporting or Add counter-evidence.", async () => { const c = card(p, "Add evidence"); await c.scrollIntoViewIfNeeded().catch(() => {}); await t.point(c.getByRole("button", { name: "Add counter-evidence" })); });
      await t.step("History shows the re-assessment.", () => soft(t, card(p, "History")));
      await t.outro("attached counter-evidence and saw the priority drop.", "match a signal to the right company.");
    },
  },

  // ------------------------------------------------------------------ 4. unresolved company
  {
    slug: "signal-unresolved-company", category: CAT, title: "When the company isn't matched",
    learn: "If the company named in the news is not matched exactly, the signal asks \"Which company is this?\": weak fuzzy matches are listed with the reason and never linked without you. Pick one, add it as a new company, or correct the company later.",
    tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Unmatched companies", "Similar names are never merged automatically — you decide.");
      await t.step("Open Signals and the Ottervale Systems signal.", () => openSignal(t, "Ottervale", "Ottervale Systems: possible new office announcement"));
      await t.step("The header says Company not matched (Ottervale Systems).", () => soft(t, main(p).getByText(/Company not matched/).first()));
      await t.step("Which company is this? Fuzzy matches are never linked without you.", () => t.point(card(p, "Which company is this?").getByRole("heading").first()));
      await t.step("Each suggestion gives the reason — here they only share the common word “systems”, a weak match. This is it would link it.", () => soft(t, card(p, "Which company is this?").getByText(/weak match/).first()));
      await t.step("Ottervale is not on record yet, so add it as a new company.", () => submit(t, card(p, "Which company is this?").getByRole("button", { name: /Add Ottervale Systems as a new company/ })));
      await t.step("The signal is now linked to the new company record. The change is kept in the history and audit log.", () => soft(t, main(p).getByRole("link", { name: "Ottervale Systems" }).first()));
      await t.step("Linked the wrong company? Correct company lets you pick another; the change is kept in history.", async () => { const c = card(p, "Correct company"); await c.scrollIntoViewIfNeeded().catch(() => {}); await soft(t, c.getByRole("button", { name: "Save company" })); });
      await t.step("People are never matched by name alone.", () => soft(t, card(p, "History")));
      await t.outro("linked a signal to the right company.", "decide what to do with a signal.");
    },
  },

  // ------------------------------------------------------------------ 5. actions
  {
    slug: "signal-actions", category: CAT, title: "Decide: approve, task, snooze, dismiss, override",
    learn: "On a signal: Approve + task, Investigate, Assign to me, Already known, Re-assess; Dismiss or Reject with a reason; Snooze until a date; create a task, link or propose an opportunity (via Review); override the priority with a reason and review date.",
    tryRoute: "/signals",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Acting on a signal", "Every decision is recorded with who, when and why.");
      await t.step("Open the Peregrine Loom Studios signal from Signals.", () => openSignal(t, "Peregrine", "Peregrine Loom Studios (demo): possible new office announcement"));
      await t.step("Decide: Approve + task, Investigate, Assign to me, Already known and Re-assess.", () => t.point(card(p, "Decide").getByRole("heading").first()));
      await t.step("Approve + task: the signal is approved and a follow-up task is created in Tasks.", () => submit(t, card(p, "Decide").getByRole("button", { name: "Approve + task" })));
      await t.step("The status changes and History records the decision and the new follow-up task.", () => soft(t, card(p, "History").locator("li").first()));
      await t.step("Task: create another task with your own title. Opportunity: link an existing deal, or propose a new one — it goes to Review for approval.", () => soft(t, card(p, "Opportunity").getByRole("button", { name: "Propose opportunity" })));
      await t.step("Now the Quillstone Labs funding signal. Funding alone is not an office requirement, so it is ranked low.", () => openSignal(t, "Quillstone", "Quillstone Labs (demo): possible funding%"));
      await t.step("Override priority: choose Medium, give the reason and a date to review it.", async () => {
        const c = card(p, "Override priority"); await c.scrollIntoViewIfNeeded();
        await choose(t, c.locator('[name="band"]'), "Medium — this month"); await fill(t, c.locator('[name="reason"]'), "CFO told us they are scouting Kharadi");
      });
      await t.step("Save override. The priority shows it was overridden, and Clear override undoes it.", () => submit(t, card(p, "Override priority").getByRole("button", { name: "Save override" })));
      await t.step("Snooze until a date — it comes back on its own then.", async () => {
        const f = card(p, "Decide").locator("form").filter({ has: p.locator('[name="until"]') }).first();
        const d = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        await f.locator('[name="until"]').fill(d); await t.point(f.locator('[name="until"]')); await submit(t, f.getByRole("button", { name: "Snooze" }));
      });
      await t.step("Dismiss or Reject needs a reason. Dismiss the Quillstone expansion: the hires are remote.", async () => {
        await t.goto(`/signals/${sigId("Quillstone Labs (demo): possible focus-city office expansion")}`);
        const f = card(p, "Decide").locator("form").filter({ has: p.getByRole("button", { name: "Dismiss" }) }).first();
        await fill(t, f.locator('[name="reason"]'), "Hires will work remotely"); await submit(t, f.getByRole("button", { name: "Dismiss" }));
      });
      await t.step("Dismissed and snoozed signals move to their own view — nothing is deleted. Reopen brings one back.", async () => {
        await side(t, "Signals"); await t.moveAndClick(main(p).getByRole("navigation", { name: "Signal views" }).getByRole("link", { name: /^Dismissed/ }));
      });
      await t.outro("approved a signal with a task, overrode a priority, snoozed and dismissed.", "check where signals come from.");
    },
  },

  // ------------------------------------------------------------------ 6. sources + research universe
  {
    slug: "signals-sources", category: CAT, title: "Signal sources and the research universe",
    learn: "Signals → Sources lists each source (news feeds, your records, manual paste, uploaded documents) with permission, connection status, last sync, refresh interval and use; pause, resume, reconnect or refresh now; see recent runs and failed items (retry); and set how many companies are kept up to date.",
    tryRoute: "/signals/sources",
    async run(t) {
      const p = t.page;
      await start(t);
      await t.title("Sources and research universe", "Where signals come from, whether each source works, and how many companies are watched.");
      await t.step("Open Signals, then Sources.", async () => { await side(t, "Signals"); await t.moveAndClick(main(p).getByRole("link", { name: "Sources", exact: true })); });
      await t.step("Source registry: each source with what it is for, its connection status, permission, last sync, refresh interval and how often it was used.", () => t.point(main(p).getByRole("heading", { name: "Source registry" })));
      await t.step("News / RSS feeds are Unavailable — needs access: no licensed feed is set up, so paste articles by hand instead. A failed source is always labelled — never shown as 'no news'.", () => soft(t, main(p).getByText(/Unavailable — needs access/).first()));
      await t.step("Your CRE OS records — leases, occupancy, availability — are connected and scanned daily.", () => soft(t, main(p).getByText(/CRE OS records/).first()));
      await t.step("Manual paste and uploaded documents are on-demand sources.", () => soft(t, main(p).getByText(/Manual paste/).first()));
      await t.step("Pause stops a source; Resume starts it again; Reconnect retries one that needs access.", () => t.point(main(p).getByRole("button", { name: "Pause" }).first()));
      await t.step("Refresh now runs the scheduled refresh for companies that are due.", () => t.point(main(p).getByRole("button", { name: "Refresh now" })));
      await t.step("Recent runs: when each source ran and how many new items it found.", () => soft(t, card(p, "Recent runs")));
      await t.step("Failed items and jobs: anything that failed, with the error and a Retry button.", () => soft(t, card(p, "Failed items and jobs")));
      await t.step("Research universe: how many companies are actively kept up to date, and how often each tier is refreshed — weekly, monthly or quarterly.", () => soft(t, card(p, "Research universe")));
      await t.step("Change the universe size (50 to 8,000 companies) and Save.", async () => { const c = card(p, "Research universe"); await fill(t, c.locator('[name="cap"]'), "1200"); await submit(t, c.getByRole("button", { name: "Save" })); });
      await t.outro("checked every signal source and set the research universe.", "go back to Signals and review what is new.");
    },
  },
];

module.exports = { FLOWS, prepare };
