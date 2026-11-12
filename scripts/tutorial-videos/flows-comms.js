// Tutorial videos — group "comms" (Outreach & meetings). Same flow shape as flows.js.
// Setup that must not be filmed (creating a draft or a meeting to work on) runs BEFORE t.title(): the video is trimmed to start at the title card.
const fs = require("fs");
const { BASE, sleep } = require("./harness");

const CAT = "Outreach & meetings";
const ZENTRIX = "Zentrix Analytics";
const nav = (p) => p.getByRole("navigation", { name: "Main" }).first();
const navLink = (p, name) => nav(p).getByRole("link", { name: new RegExp(`^${name}`) });
const main = (p) => p.locator("main");
/** Section tabs shown above the page (e.g. Today · Overview · Tasks · Calendar). */
const tab = (p, name) => p.getByRole("link", { name, exact: true }).filter({ visible: true }).first();
const idle = (p) => p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
const isoDay = (offset = 0) => { const d = new Date(Date.now() + 5.5 * 3600e3 + offset * 864e5); return d.toISOString().slice(0, 10); };

/** Off-camera: create an outreach email draft for a person and return its URL. */
async function newOutreach(p, person, scenario) {
  await p.goto(`${BASE}/outreach/new`, { waitUntil: "networkidle", timeout: 90000 });
  await main(p).locator("select").first().selectOption({ label: person });
  await main(p).getByRole("button", { name: "Continue" }).click();
  await p.waitForURL(/person=/, { timeout: 30000 }); await idle(p);
  if (scenario) await main(p).locator("select[name=scenario]").selectOption({ label: scenario });
  await main(p).getByRole("button", { name: "Prepare drafts" }).click();
  await p.waitForURL(/\/outreach\/[0-9a-f-]{36}/, { timeout: 60000 }); await idle(p);
  return p.url().replace(BASE, "");
}
async function approveOutreach(p) {
  await main(p).getByRole("button", { name: /Approve this exact text/ }).click(); await idle(p); await sleep(800);
}
async function markSent(p) {
  await main(p).getByText(/^Recipient is correct/).click(); await main(p).getByText("The text is exactly what I want to send").click();
  await main(p).getByRole("button", { name: /Check & open/ }).click(); await sleep(1500);
  await main(p).getByRole("button", { name: "I sent it" }).click(); await idle(p); await sleep(1000);
}
/** Off-camera: create a meeting through the real form and return its URL. */
async function newMeeting(p, { title, type, time, assets = [] }) {
  await p.goto(`${BASE}/meetings/new`, { waitUntil: "networkidle", timeout: 90000 });
  await p.locator("input[name=title]").fill(title);
  await p.locator("input[name=date]").fill(isoDay(0));
  await p.locator("input[name=time]").fill(time);
  await p.locator("select[name=type]").selectOption({ label: type });
  await p.locator("select[name=org_id]").selectOption({ label: ZENTRIX });
  await p.locator("select[name=person_id]").selectOption({ label: "Ananya Rao — Zentrix Analytics" });
  if (assets.length) { await p.getByText("More details (optional)").click(); await p.locator("select[name=asset_id]").selectOption(assets.map((label) => ({ label }))); }
  await p.getByRole("button", { name: "Create meeting" }).click();
  await p.waitForURL(/\/meetings\/[0-9a-f-]{36}/, { timeout: 90000 }); await idle(p);
  return p.url().replace(BASE, "").replace(/#.*$/, "");
}
/** Open a meeting the way a user would: Meetings in the sidebar, then the row. */
async function openMeetingFromList(t, title) {
  const p = t.page;
  await t.step("Open Meetings from the sidebar.", () => t.moveAndClick(navLink(p, "Meetings")));
  await t.step("Today's meetings are listed first. Open this one.", () => t.moveAndClick(main(p).getByRole("link", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first()));
  await p.waitForURL(/\/meetings\/[0-9a-f-]{36}/, { timeout: 30000 });
}

const FLOWS = [
  {
    slug: "today-plan-v2", category: CAT, title: "Plan your day from Today",
    learn: "Read Today top to bottom: schedule, priority tasks, overdue commitments, transactions and lease events — then open what to do first.", tryRoute: "/today",
    async run(t) {
      const p = t.page;
      await t.goto("/tasks");
      await t.title("Plan your day from Today", "Today collects what needs you — meetings, tasks, transactions and lease dates — most urgent first.");
      await t.step("Open Today from the sidebar. It is your start page every morning.", () => t.moveAndClick(navLink(p, "Today")));
      await t.step("Getting started tracks the set-up steps still left, with a button for the next one.", () => t.point(main(p).getByText("Getting started").first()));
      await t.step("Today's schedule: every meeting with its time, place and whether the brief is ready.", () => t.point(main(p).getByText(/^Today's schedule/).first()));
      await t.step("Priority tasks & follow-ups: what to do today, most urgent first.", async () => { await t.scroll(400); await t.point(main(p).getByText(/^Priority tasks & follow-ups/).first()); });
      await t.step("Overdue commitments: promises that slipped past their date.", () => t.point(main(p).getByText(/^Overdue commitments/).first()));
      await t.step("Recommended next actions: the most urgent things first, each with the reason.", async () => { await t.scroll(400); await t.point(main(p).getByText(/^Recommended next actions/).first()); });
      await t.step("Active transactions: deals in offers, approvals or execution, and what blocks them.", async () => { await t.scroll(400); await t.point(main(p).getByText(/^Active transactions/).first()); });
      await t.step("Pending approvals: changes waiting in Review before they touch your records.", async () => { await t.scroll(400); await t.point(main(p).getByText(/^Pending approvals/).first()); });
      await t.step("Important lease events: notice deadlines and expiries coming up, so nothing is missed.", async () => { await t.scroll(400); await t.point(main(p).getByText(/^Important lease events/).first()); });
      await t.step("Priority accounts: the companies most worth calling, with their score and why.", async () => { await t.scroll(600); await t.point(main(p).getByText(/^Priority accounts/).first()); });
      await t.step("Open All tasks to start working through them.", async () => { await t.scroll(-6000); await t.moveAndClick(main(p).getByRole("link", { name: "All tasks" }).first()); });
      await t.step("It opens in Tasks, where you complete it, snooze it or see what it is linked to.", async () => { await p.waitForURL(/\/tasks/); await t.point(main(p).getByRole("heading", { name: "Tasks" })); });
      await t.outro("read Today's sections and opened your tasks.", "manage tasks: add one, set a due date, mark it done.");
    },
  },

  {
    slug: "tasks", category: CAT, title: "Manage tasks",
    learn: "Add a task with a due date and priority, then complete it with a note of what was done (or snooze it).", tryRoute: "/tasks",
    async run(t) {
      const p = t.page;
      const name = `Call Ananya Rao about Kharadi options (demo ${new Date().toISOString().slice(11, 16)})`;
      await t.goto("/today");
      await t.title("Manage tasks", "Tasks are your to-do list. Many are added for you (from notes, lease dates and meetings); you can add your own too.");
      await t.step("Tasks sit under Today. Open the Tasks tab.", () => t.moveAndClick(tab(p, "Tasks")));
      await t.step("Filters: Open, Overdue, Snoozed, Stale and Done. Overdue ones are marked in red.", () => t.point(main(p).getByRole("link", { name: "Overdue", exact: true })));
      await t.step("Search titles, choose Mine or Everyone, and filter by where the task came from.", () => t.point(main(p).locator("select[name=source]")));
      await t.step("Each task shows its status, due date, priority and source — 'Blocked' means it waits on another task.", () => t.point(main(p).getByText("Blocked").first()));
      await t.step("Stale holds tasks overdue for too long, so they don't silently disappear.", () => t.point(main(p).getByRole("link", { name: "Stale", exact: true })));
      await t.step("To add your own, scroll to New task at the bottom.", async () => { await t.scroll(20000); await t.point(main(p).getByText("New task", { exact: true })); });
      await t.step("Type what needs doing.", () => t.type(main(p).locator("input[name=title]"), name, 22));
      await t.step("Pick a due date — here, tomorrow.", async () => { const d = main(p).locator("input[name=due]"); await t.point(d); await d.fill(isoDay(1)); });
      await t.step("Set the priority to High, then press Add.", async () => {
        const s = main(p).locator("select[name=priority]"); await t.point(s); await s.selectOption({ label: "High" });
        await t.moveAndClick(main(p).getByRole("button", { name: "Add", exact: true }));
      });
      const row = main(p).locator("li").filter({ hasText: name }).first();
      await t.step("The new task is in the list with its due date and priority.", () => t.point(row));
      await t.step("When it's done, write what you did — that note is kept as evidence.", () => t.type(row.locator("input[name=evidence]"), "Called Ananya, shared 3 Kharadi options", 22));
      await t.step("Press Complete. (Not today? Snooze it for 1, 3, 7 or 14 days instead.)", () => t.moveAndClick(row.getByRole("button", { name: "Complete" })));
      await t.step("Done tasks move to the Done filter, with your note.", async () => { await t.scroll(-20000); await t.moveAndClick(main(p).getByRole("link", { name: "Done", exact: true })); });
      await t.step("Your note is kept as evidence; Reopen brings a task back if needed.", () => t.point(main(p).getByRole("button", { name: "Reopen" }).first()));
      await t.outro("added a task with a due date and priority, then completed it.", "rewrite an outreach draft with AI.");
    },
  },

  {
    slug: "outreach-variants", category: CAT, title: "Rewrite an outreach draft with AI",
    learn: "Use the rewrite chips (shorter, more formal, …) or 3 full alternatives; every rewrite is a new version you can go back to.", tryRoute: "/outreach",
    async run(t) {
      const p = t.page;
      const url = await newOutreach(p, "Arjun Nair — Head – Real Estate & Workplace at Quokka Grid Infotech", "Lease renewal");
      await t.goto("/today");
      await t.title("Rewrite an outreach draft with AI", "Change the tone or length with one click, compare versions, and go back to any earlier one.");
      await t.step("Open Outreach, then the Messages tab.", async () => { await t.moveAndClick(navLink(p, "Outreach")); await t.moveAndClick(main(p).getByRole("link", { name: /^Messages/ }).first()); });
      await t.step("Open the draft to Arjun Nair at Quokka Grid Infotech.", async () => {
        const link = main(p).locator(`a[href="${url}"]`).first();
        if (await link.count()) await t.moveAndClick(link); else await t.goto(url);
      });
      await p.waitForURL(/\/outreach\/[0-9a-f-]{36}/);
      await t.step("This is the draft. You can edit the text yourself at any time.", () => t.point(main(p).getByRole("textbox", { name: "Message text" })));
      await t.step("Why now: the reason for writing, the value for them and key facts like lease dates.", () => t.point(main(p).getByRole("heading", { name: /Why now/ })));
      await t.step("Rewrite with AI: each chip changes the draft in one way.", () => t.point(main(p).getByText("✨ Rewrite with AI")));
      await t.step("Press Shorter.", () => t.moveAndClick(main(p).getByRole("button", { name: "Shorter", exact: true })));
      await t.step("Now More formal. Each rewrite is saved as a new version.", () => t.moveAndClick(main(p).getByRole("button", { name: "More formal", exact: true })));
      await t.step("Language and Translate rewrite it in Hinglish or Hindi.", () => t.point(main(p).getByRole("combobox", { name: "Language" })));
      await t.step("Other ways to say it: Show 3 versions writes complete alternatives.", () => t.moveAndClick(main(p).getByRole("button", { name: /Show 3 versions|Write new versions/ })));
      await t.step("Concise, value-led and question-led. 'Use this one' would make it the draft.", () => t.point(main(p).getByRole("button", { name: "Use this one" }).first()));
      await t.step("Versions lists every one, newest first, marked Current.", () => t.point(main(p).getByRole("heading", { name: /Versions/ })));
      await t.step("Open the first draft to read it.", () => t.moveAndClick(main(p).locator("summary").filter({ hasText: "First draft" }).first()));
      await t.step("Prefer it? Use this version — it comes back as a new version, so nothing is lost.", async () => {
        await t.moveAndClick(main(p).locator("details[open]").filter({ hasText: "First draft" }).getByRole("button", { name: "Use this version" }));
      });
      await t.step("The restored text is back in the draft, ready to approve.", async () => { await t.scroll(-2000); await t.point(main(p).getByRole("textbox", { name: "Message text" })); });
      await t.outro("rewrote a draft with AI and restored an earlier version.", "mark a message as sent and see the follow-up plan.");
    },
  },

  {
    slug: "outreach-sent", category: CAT, title: "Mark a message as sent",
    learn: "After you send from your own mail app, press 'I sent it'; CRE OS then plans the follow-ups and stops them if they reply.", tryRoute: "/outreach",
    async run(t) {
      const p = t.page;
      const url = await newOutreach(p, "Priya Nair — Head – Real Estate & Workplace at Ironmonsoon Capital", "Lease renewal");
      await approveOutreach(p);
      await t.goto(url);
      await t.title("Mark a message as sent → follow-up plan", "CRE OS never sends. You send it from your own mail, then tell CRE OS so it can plan the follow-ups.");
      await t.step("An approved email to Priya Nair. The progress bar shows it is Ready.", () => t.point(main(p).getByRole("list", { name: "Progress" })));
      await t.step("Confirm the recipient and the text.", async () => {
        await t.moveAndClick(main(p).getByText(/^Recipient is correct/)); await t.moveAndClick(main(p).getByText("The text is exactly what I want to send"));
      });
      await t.step("Check & open shows buttons to open your own mail app. Send it from there.", async () => { await t.moveAndClick(main(p).getByRole("button", { name: /Check & open/ })); await sleep(800); });
      await t.step("Back in CRE OS, press I sent it.", () => t.moveAndClick(main(p).getByRole("button", { name: "I sent it" })));
      await t.step("The message is now marked Sent.", () => t.point(main(p).getByRole("list", { name: "Progress" })));
      await t.step("Same conversation: the follow-ups are already planned, with dates.", () => t.point(main(p).getByRole("heading", { name: "Same conversation" })));
      await t.step("A follow-up is only drafted when you ask, and pauses itself if they reply.", () => t.point(main(p).getByRole("link", { name: /Step 2/ }).first()));
      await t.step("Activity records every step — drafted, approved, opened, sent — with times.", () => t.moveAndClick(main(p).locator("summary").filter({ hasText: /^Activity/ })));
      await t.step("When they answer, paste it under 'Did they reply?'.", () => t.point(main(p).getByRole("heading", { name: /Did they reply\?/ })));
      await t.outro("marked an email as sent and saw its follow-up plan.", "record their reply.");
    },
  },

  {
    slug: "outreach-reply", category: CAT, title: "Record a reply and see what happens next",
    learn: "Paste their reply; CRE OS sorts it (interested, meeting, not now, referred…), stops follow-ups and says what to do next.", tryRoute: "/outreach",
    async run(t) {
      const p = t.page;
      const url = await newOutreach(p, "Riya Gokhale — Head – Real Estate & Workplace at Kestrelbay Payments", "Lease renewal");
      await approveOutreach(p); await markSent(p);
      await t.goto(url);
      await t.title("Record a reply → what happens next", "Paste what they said. CRE OS sorts the reply and plans the next step — you stay in control.");
      await t.step("This email to Riya Gokhale was sent. Now she has replied.", () => t.point(main(p).getByRole("list", { name: "Progress" })));
      await t.step("Paste her reply, or note what she said on the phone.", () => t.type(main(p).locator("textarea[name=text]"),
        "Thanks Riya here. Yes, happy to meet — can we do a call on Tuesday at 4pm?", 24));
      await t.step("Press Save reply.", () => t.moveAndClick(main(p).getByRole("button", { name: "Save reply" })));
      await t.step("It is sorted as a Meeting reply. Others: Interested, Not now, Referred someone else, Declined…", () => t.point(main(p).getByRole("heading", { name: "Their reply" })));
      await t.step("What we promised is listed, and Next says what to do now.", () => t.point(main(p).getByText(/^Next:/)));
      await t.step("Planned follow-ups stop, so she won't get a chaser after replying.", () => t.point(main(p).getByRole("heading", { name: "Same conversation" })));
      await t.step("A referral would add the new person to Review — never straight into your contacts.", () => t.point(main(p).getByRole("heading", { name: "Their reply" })));
      await t.outro("recorded a reply and saw the next step.", "approve drafts in Drafts & messages.");
    },
  },

  {
    slug: "drafts-messages", category: CAT, title: "Drafts & messages: approve, then open in your mail app",
    learn: "Every outgoing message waits in Drafts & messages. Approve the exact text, open it in your own app, send it there, then mark it sent.", tryRoute: "/drafts",
    async run(t) {
      const p = t.page;
      await newOutreach(p, "Meera Rao — Head – Real Estate & Workplace at Pinecrest Freight Logistics", "Lease renewal");
      await t.goto("/today");
      await t.title("Drafts & messages", "Every message CRE OS writes waits here for you. Nothing is sent unless you send it yourself.");
      await t.step("Open Outreach, then the Drafts & messages tab.", async () => { await t.moveAndClick(navLink(p, "Outreach")); await t.moveAndClick(tab(p, "Drafts & messages")); });
      await t.step("Tabs split drafts by channel: email, WhatsApp, LinkedIn, invites.", () => t.point(main(p).getByRole("link", { name: /^Email/ }).first()));
      await t.step("Inbox triage sorts imported replies; Sequences shows multi-step outreach plans.", () => t.point(main(p).getByRole("link", { name: "Inbox triage" })));
      await t.step("Needs action shows drafts still waiting for you.", () => t.point(main(p).getByRole("link", { name: "Needs action" })));
      const card = main(p).locator("div").filter({ hasText: /Pinecrest Freight|Meera Rao/ }).filter({ has: p.getByRole("button", { name: "Approve", exact: true }) }).last();
      await t.step("A new draft to Meera Rao. Read the recipient, subject and text.", () => t.point(card));
      await t.step("Approve this exact text. If anyone edits it later, the approval is removed.", () => t.moveAndClick(card.getByRole("button", { name: "Approve", exact: true })));
      await t.step("It is now Approved, with a fingerprint of the approved text.", () => t.point(main(p).getByText(/approval matches this content/).first()));
      await t.step("Open to send opens it in your own mail app — you press Send there.", () => t.point(main(p).getByRole("button", { name: "Open to send" }).first()));
      await t.step("Edit, Copy or Discard are always there. Editing removes the approval so it must be approved again.", () => t.point(main(p).getByRole("button", { name: "Edit" }).first()));
      await t.step("Then come back and press Mark sent so follow-ups are tracked.", () => t.point(main(p).getByRole("link", { name: "Sent", exact: true })));
      await t.outro("approved a draft's exact text, ready to open in your mail app.", "take notes during a meeting.");
    },
  },

  {
    slug: "meeting-live", category: CAT, title: "Take notes in a meeting and apply the outcome",
    learn: "Use Meeting mode to note things as they happen, then turn the notes into tasks, a follow-up draft and proposals for Review.", tryRoute: "/meetings",
    async run(t) {
      const p = t.page;
      const title = `Zentrix — options review (demo ${new Date().toISOString().slice(11, 16)})`;
      await newMeeting(p, { title, type: "Requirement discussion", time: "10:00" });
      await t.goto("/today");
      await t.title("Take notes during a meeting → apply the outcome", "Meeting mode shows what to ask; your notes become tasks, a draft and proposed updates — after you approve.");
      await openMeetingFromList(t, title);
      await t.step("The brief: readiness score, purpose, attendees, history and questions to ask.", () => t.point(main(p).getByText("Readiness")));
      await t.step("Press Meeting mode when the meeting starts.", () => t.moveAndClick(main(p).getByRole("link", { name: "Meeting mode" })));
      await t.step("One screen: who is here, what to ask, talking points.", () => t.point(main(p).getByText("In meeting")));
      await t.step("Scroll for the questions to ask and talking points.", async () => { await t.scroll(500); await t.point(main(p).getByText("Talking points")); await t.scroll(-500); });
      await t.step("Type a note as it happens and Save.", async () => {
        await t.type(main(p).getByRole("textbox", { name: "Note" }), "Ananya liked Kharadi Tech Park. They need 25,000 sq ft.", 22);
        await t.moveAndClick(main(p).getByRole("button", { name: "Save", exact: true }));
      });
      await t.step("Mark a promise as an Action item, then Save.", async () => {
        await t.type(main(p).getByRole("textbox", { name: "Note" }), "We will send the floor plans on 2026-11-13.", 22);
        await main(p).getByRole("combobox", { name: "Type" }).selectOption({ label: "Action item" });
        await t.moveAndClick(main(p).getByRole("button", { name: "Save", exact: true }));
      });
      await t.step("After the meeting: Finish turns the notes into updates.", () => t.moveAndClick(main(p).getByRole("link", { name: /Finish: turn notes into updates/ })));
      await t.step("Your notes are included. Press Structure my notes.", () => t.moveAndClick(main(p).getByRole("button", { name: "Structure my notes" })));
      await t.step("It found the size change and our commitment, each quoted from your notes.", () => t.point(main(p).getByText("Commitments").first()));
      await t.step("Each box decides what happens: history, Review proposals, tasks, contact changes.", () => t.point(main(p).getByText("Create tasks for our commitments")));
      await t.step("Choose what to apply — also tick 'Draft a follow-up email'.", () => t.moveAndClick(main(p).getByText(/Draft a follow-up email/)));
      await t.step("Press Approve selected.", () => t.moveAndClick(main(p).getByRole("button", { name: "Approve selected" })));
      await t.step("Done: changes went to Review, tasks were created, and a follow-up draft waits in Outreach.", () => t.point(main(p).getByText(/^Applied /)));
      await t.step("Open Review to approve the proposed changes.", () => t.moveAndClick(main(p).getByRole("link", { name: "Open Review" })));
      await t.outro("took notes in Meeting mode and applied the outcome.", "record a meeting that didn't happen.");
    },
  },

  {
    slug: "meeting-no-show", category: CAT, title: "Record a meeting that didn't happen",
    learn: "Write that it didn't happen; CRE OS offers to reschedule or record it as not held, without inventing any outcome.", tryRoute: "/meetings",
    async run(t) {
      const p = t.page;
      const title = `Zentrix — intro call (demo ${new Date().toISOString().slice(11, 16)})`;
      await newMeeting(p, { title, type: "Requirement discussion", time: "09:00" });
      await t.goto("/today");
      await t.title("Record a meeting that didn't happen", "No-shows happen. Record it so your history is right — nothing else is changed.");
      await openMeetingFromList(t, title);
      await t.step("Go to After the meeting.", () => t.moveAndClick(main(p).locator('a[href="#after"]').first()));
      await t.step("Write what happened, in plain words.", () => t.type(main(p).locator("textarea[name=text]"), "Meeting didn't happen — Ananya was travelling.", 24));
      await t.step("Press Structure my notes.", () => t.moveAndClick(main(p).getByRole("button", { name: "Structure my notes" })));
      await t.step("CRE OS sees the meeting didn't take place — no tasks or updates are invented.", () => t.point(main(p).getByText("This meeting didn't take place")));
      await t.step("You can pick a new date to reschedule it…", () => t.point(main(p).getByText("New date").first()));
      await t.step("…or record it as not held. Keep 'Note it in the contact history' ticked.", () => t.point(main(p).getByText("Note it in the contact history")));
      await t.step("Press Record as not held.", () => t.moveAndClick(main(p).getByRole("button", { name: "Record as not held" })));
      await t.step("Saved. The contact's history now shows the meeting did not happen.", () => t.point(main(p).getByRole("status").filter({ hasText: /./ }).first().or(main(p).getByRole("heading", { name: /After the meeting/ })).first()));
      await t.outro("recorded a meeting as not held.", "use the site-visit checklist and feedback.");
    },
  },

  {
    slug: "site-visit", category: CAT, title: "Site visit checklist and building feedback",
    learn: "Tick the before / during / after checklist and record the client's feedback for each building visited.", tryRoute: "/meetings",
    async run(t) {
      const p = t.page;
      const title = `Site visit — Zentrix Kharadi (demo ${new Date().toISOString().slice(11, 16)})`;
      await newMeeting(p, { title, type: "Site visit", time: "16:00", assets: ["Kharadi Tech Park (demo)", "Kharadi Riverside Towers (demo)"] });
      await t.goto("/today");
      await t.title("Site visit checklist & building feedback", "A site-visit meeting gets a checklist and a feedback form for each building.");
      await openMeetingFromList(t, title);
      await t.step("Jump to the Site visit checklist.", () => t.moveAndClick(main(p).locator('a[href="#checklist"]').first()));
      await t.step("Before, during and after: tick each item as you go.", async () => {
        const items = main(p).locator("#checklist button");
        await t.moveAndClick(items.nth(0)); await sleep(800); await t.moveAndClick(items.nth(1));
      });
      await t.step("Before (confirm access, send the pack), during (check the space) and after (collect feedback).", () => t.point(main(p).locator("#checklist")));
      await t.step("Property feedback: one form per building visited.", () => t.moveAndClick(main(p).locator('a[href="#feedback"]').first()));
      await t.step("Open Kharadi Tech Park.", () => t.moveAndClick(main(p).locator("#feedback summary").filter({ hasText: "Kharadi Tech Park" }).first()));
      const form = main(p).locator("#feedback details[open]").first();
      await t.step("Rate it and set the client's interest.", async () => {
        const o = form.locator("select[name=overall]"); await t.point(o); await o.selectOption("4");
        const i = form.locator("select[name=interest]"); await t.point(i); await i.selectOption({ label: "Interested" });
      });
      await t.step("Add what they said. Only tick 'clearly rejected' if the client said no.", () => t.type(form.locator("textarea").first(), "Liked the floor plate and metro access.", 22));
      await t.step("Save feedback.", () => t.moveAndClick(form.getByRole("button", { name: "Save feedback" })));
      await t.step("The building now shows the client's interest and rating.", () => t.point(main(p).locator("#feedback summary").filter({ hasText: "Kharadi Tech Park" }).first()));
      await t.outro("ticked the visit checklist and saved feedback for a building.", "import your calendar.");
    },
  },

  {
    slug: "calendar-import", category: CAT, title: "Import a calendar (.ics)",
    learn: "Export an .ics file from Google or Outlook and upload it on Meetings; each meeting gets a preparation page. Re-importing never duplicates.", tryRoute: "/meetings",
    async run(t) {
      const p = t.page;
      const stamp = Date.now();
      const file = `/tmp/comms/zentrix-calendar.ics`;
      const d = isoDay(1).replace(/-/g, "");
      fs.mkdirSync("/tmp/comms", { recursive: true });
      fs.writeFileSync(file, ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demo//Tutorial//EN", "BEGIN:VEVENT", `UID:tutorial-${stamp}@demo.example`,
        `DTSTAMP:${d}T040000Z`, `DTSTART:${d}T093000Z`, `DTEND:${d}T103000Z`, "SUMMARY:Zentrix Analytics — Kharadi options call",
        "LOCATION:Video call", "ORGANIZER;CN=Me:mailto:owner@cre-os.local", "ATTENDEE;CN=Ananya Rao:mailto:ananya.rao@zentrix.example",
        "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
      await t.goto("/today");
      await t.title("Import a calendar (.ics)", "No calendar connected? Export an .ics file from Google or Outlook and upload it — CRE OS prepares each meeting.");
      await t.step("Open Meetings from the sidebar.", () => t.moveAndClick(navLink(p, "Meetings")));
      await t.step("Tabs: Today, Upcoming, Needs preparation, Past, Cancelled and Reports. Open Upcoming.", () => t.moveAndClick(main(p).getByRole("link", { name: "Upcoming", exact: true })));
      await t.step("Connected calendar: link Google or Outlook and new meetings get a preparation page every hour.", async () => { await t.scroll(1500); await t.point(main(p).getByRole("heading", { name: "Connected calendar" })); });
      await t.step("No connection? Use Import from your calendar.", async () => { await t.point(main(p).getByRole("heading", { name: /Import from your calendar/ })); });
      await t.step("Choose the .ics file you exported (here, one meeting with Zentrix tomorrow).", async () => {
        const inp = main(p).locator("input[type=file][name=file]"); await t.point(inp); await inp.setInputFiles(file);
      });
      await t.step("Press Import. Importing the same file again won't create duplicates.", () => t.moveAndClick(main(p).getByRole("button", { name: "Import", exact: true })));
      await t.step("The result says how many meetings were added.", () => t.point(main(p).getByText(/Imported \d+ meeting/)));
      await t.step("It now appears in the Upcoming list, with its type, company and attendees.", async () => { await t.scroll(-3000); await t.point(main(p).getByRole("link", { name: /Kharadi options call/ }).first()); });
      await t.step("Open the imported meeting.", () => t.moveAndClick(main(p).getByRole("link", { name: /Kharadi options call/ }).first()));
      await p.waitForURL(/\/meetings\/[0-9a-f-]{36}/);
      await t.step("It has its own preparation page: company and attendee were matched from the invite.", () => t.point(main(p).getByText("Readiness")));
      await t.step("Press Prepare brief to get the purpose, people, history and questions.", async () => {
        const b = main(p).getByRole("button", { name: "Prepare brief" });
        if (await b.count()) await t.moveAndClick(b); else await t.point(main(p).getByRole("link", { name: "Meeting mode" }));
      });
      await t.outro("imported an .ics calendar file and opened a meeting's preparation page.", "plan your day from Today.");
    },
  },
];

module.exports = { FLOWS };
