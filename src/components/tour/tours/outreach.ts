import type { Tour } from "../types";

export const tour: Tour = {
  key: "outreach",
  module: "Module 5",
  title: "Outreach engine",
  summary: "Who to contact today, why, and how to send a message you approved yourself.",
  minutes: 8,
  steps: [
    { route: "/outreach", target: "outreach-heading", title: "Your outreach desk", body: "This is where you decide who to contact and what to say. Nothing is ever sent automatically: you approve and send every message yourself." },
    { route: "/outreach", target: "outreach-today", title: "New conversations to start", body: "Each card shows a person, the reason to reach out now and their lead score. Press Prepare drafts to get a first version to edit." },
    { route: "/outreach", target: "outreach-followups", title: "Follow-ups due and overdue", body: "People who have not replied show up here on the right day. Late ones are marked red as overdue, so they never slip. If someone keeps ignoring one approach, Try a different approach suggests another angle." },
    { route: "/outreach?tab=messages", target: "outreach-subtabs", title: "Messages", body: "Drafts you are still writing, messages waiting for approval, and approved messages ready to send. A draft is not outreach until you send it." },
    { route: "/outreach?tab=messages", title: "Writing a message", body: "Inside a message, type freely or press Rewrite with AI. Show 3 versions gives you three different wordings to pick from, and every change is kept under Versions." },
    { route: "/outreach?tab=messages", title: "Spaces that may fit", body: "If the company has a requirement, matching spaces are listed with the message. Press Mention in draft to add one to your text — you still check and approve it." },
    { route: "/outreach?tab=messages", title: "Approve, then send yourself", body: "Approve the exact wording, then open it in Gmail, Outlook or WhatsApp and press send there. Come back and press I sent it so follow-ups are timed correctly." },
    { route: "/outreach?tab=messages", title: "Handling replies", body: "Paste the reply in and CRE OS suggests tasks; record updates go to Review for approval. If they refer you to a colleague, you can start outreach to that person, and an out-of-office reply just pushes the follow-up back." },
    { route: "/outreach?tab=conversations", target: "outreach-tabs", title: "Conversations", body: "Messages you marked as sent stay here until the person replies, so nobody is forgotten." },
    { route: "/outreach?tab=relationships", target: "outreach-tabs", title: "Relationships", body: "Everyone you have dealt with, grouped as needs attention, active, cooling or inactive. Use it to spot good contacts going quiet." },
    { route: "/outreach?tab=paused", target: "outreach-tabs", title: "Paused", body: "Outreach pauses on its own when someone replies, declines or asks not to be contacted. You can see the reason and resume only if it makes sense." },
    { route: "/outreach?tab=results", target: "outreach-results", title: "Honest results", body: "Messages sent, replies, meaningful replies and meetings over the last 90 days. Every rate says what it is divided by, and drafts are never counted." },
    { route: "/outreach?tab=results", target: "outreach-after", title: "After outreach", body: "Opportunities and requirements created within 30 days of a message. This shows timing only, not proof the message caused them." },
    { route: "/outreach?tab=results", target: "outreach-breakdowns", title: "What works best", body: "Compare reply and meeting rates by channel, by approach, and for your top companies and contacts." },
    { route: "/outreach/new", target: "outreach-pick-contact", title: "Start a new outreach", body: "Pick any saved contact to begin. If a colleague or partner knows them, CRE OS suggests asking for a warm introduction first." },
  ],
};
