import type { Tour } from "../types";

const SAMPLE_REPLY = "Thanks for reaching out. Yes, we are looking at about 25,000 sq ft in Kharadi from Q3. Can you send me 3 options by Friday? Please also loop in my colleague Rohan Desai (rohan.desai@practice-co.example) — he handles facilities.";

export const tour: Tour = {
  key: "outreach",
  module: "Module 5",
  title: "Outreach engine",
  summary: "Draft, rewrite, approve and 'send' a real message to a practice contact, then log their reply.",
  minutes: 10,
  practice: { label: "Priya Sharma (tutorial) at Practice Co", href: "/contacts/{contact}", fallback: "/outreach" },
  learned: [
    "Today shows who to contact and why — Priya appeared because of a signal about her company",
    "Prepare drafts writes one draft per channel, only from what's on record",
    "Rewrite chips and Versions: every change is kept, nothing is lost",
    "Approval covers the exact text and recipient — editing resets it",
    "CRE OS never sends: you open your own mail app, send, then press I sent it",
    "Pasting a reply creates tasks; contact changes wait in Review",
  ],
  steps: [
    { route: "/outreach", target: "outreach-heading", title: "Your outreach desk", body: "Here you decide who to contact and what to say. Nothing is ever sent automatically — in this tutorial you'll do every step yourself on a practice contact." },
    { route: "/outreach", target: "outreach-practice-card", title: "A reason to reach out", body: "Priya Sharma (tutorial) is on Today because of the signal \"Practice Co plans Pune expansion\". The card shows the reason, the approach and her lead score." },
    { route: "/outreach", target: "outreach-prepare", kind: "do", task: "Click Prepare drafts on Priya Sharma's card", title: "Prepare the drafts", body: "Email and WhatsApp are ticked, so you get one draft for each. Press Prepare drafts.", waitFor: { type: "click" } },
    { route: "@current", target: "outreach-compose", title: "Your first draft", body: "This is the email draft. It is built only from what's on record — no invented facts. You can type straight into it and press Save changes." },
    { route: "@current", target: "outreach-rewrite", kind: "do", task: "Click a Rewrite chip, e.g. Shorter", title: "Rewrite with one click", body: "Pick any chip — Shorter, More formal, Less salesy… In practice mode the rewrite is rule-based, so it's instant.", waitFor: { type: "click", target: "outreach-rewrite-chips" } },
    { route: "@current", target: "outreach-compose", title: "The new wording", body: "The message above now shows the rewritten text. Read it — you are always the editor." },
    { route: "@current", target: "outreach-versions", kind: "do", task: "Open a version in the Versions list", title: "Nothing is lost", body: "Every save and rewrite is a version. Tap one to read it; Use this version brings it back as a new version.", waitFor: { type: "click" } },
    { route: "@current", target: "outreach-approve", kind: "do", task: "Click ✓ Approve this exact text", title: "Approve the exact text", body: "Approval covers this exact text and recipient. If anyone edits it later, it goes back to draft.", waitFor: { type: "click" } },
    { route: "@current", target: "outreach-send", title: "You send it — not CRE OS", body: "CRE OS never sends email or WhatsApp. Check & open re-checks the text and opens it in your own Gmail, Outlook or WhatsApp. The practice address ends in .example, so nothing can arrive anywhere." },
    { route: "@current", target: "outreach-check", kind: "do", task: "Tick both boxes, then press Check & open", title: "Check & open", body: "Tick that the recipient and text are right, then press Check & open. You'll see buttons to open your mail app — you don't need to use them for practice.", waitFor: { type: "click", target: "outreach-check-open" } },
    { route: "@current", target: "outreach-sent", kind: "do", task: "Press I sent it", title: "Record that you sent it", body: "After sending from your own app you come back and press I sent it. That times the follow-ups correctly. For practice, just press it.", waitFor: { type: "click" } },
    { route: "@current", target: "outreach-reply-text", kind: "do", task: "Paste the sample reply into the box", title: "They replied!", body: `Copy this sample reply and paste it into the box:\n\n“${SAMPLE_REPLY}”`, waitFor: { type: "input" } },
    { route: "@current", target: "outreach-reply-save", kind: "do", task: "Press Save reply", title: "Save the reply", body: "CRE OS reads the reply, works out the outcome and pulls out what was promised.", waitFor: { type: "click" } },
    { route: "@current", target: "outreach-reply-result", title: "What CRE OS took from it", body: "You'll see the outcome, the commitment (3 options by Friday) and the next action. Rohan is proposed as a new contact — he is only created once you approve him in Review." },
    { route: "/tasks", title: "Tasks from the reply", body: "Commitments you made become tasks here, so 'send 3 options by Friday' doesn't slip." },
    { route: "/approvals", target: "review-header", title: "Review before it counts", body: "Contact changes and new people from replies wait here. Nothing in your records changed until you approve it." },
  ],
};
