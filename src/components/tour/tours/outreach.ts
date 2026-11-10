import type { Tour } from "../types";

export const tour: Tour = {
  key: "outreach",
  module: "Module 5",
  title: "Outreach engine",
  summary: "Who to contact today, why, and how to send a message you approved yourself.",
  minutes: 6,
  steps: [
    { route: "/outreach", target: "outreach-heading", title: "Your outreach desk", body: "This is where you decide who to contact and what to say. Nothing is ever sent automatically: you approve and send every message yourself." },
    { route: "/outreach", target: "outreach-today", title: "New conversations to start", body: "Each card shows a person, the reason to reach out now (for example a lease expiry or an expansion signal) and their lead score. Channel pills show whether email, WhatsApp or LinkedIn is available. Press Prepare drafts to get a first version to edit." },
    { route: "/outreach", target: "outreach-followups", title: "Follow-ups due", body: "People you contacted earlier who have not replied show up here on the right day. Open one to prepare the next polite follow-up." },
    { route: "/outreach?tab=messages", target: "outreach-subtabs", title: "Messages", body: "Drafts you are still writing, messages waiting for approval, and approved messages ready to send. A draft is not outreach until you send it." },
    { route: "/outreach?tab=messages", title: "Writing a message", body: "Inside a message you can type freely or press Rewrite with AI for a better version. Every change is kept under Versions, so you can restore an older one at any time." },
    { route: "/outreach?tab=messages", title: "Approve the exact text", body: "When you are happy, approve the exact wording. Then Check & open in Gmail, Outlook or WhatsApp opens your own app with the text filled in — you press send there, not CRE OS." },
    { route: "/outreach?tab=messages", title: "I sent it, and the reply", body: "After sending, press I sent it so follow-ups are timed correctly. When they reply, paste the reply in: CRE OS suggests tasks and any record updates go to Review for your approval." },
    { route: "/outreach?tab=conversations", target: "outreach-tabs", title: "Conversations", body: "Messages you marked as sent stay here until the person replies, so nobody is forgotten." },
    { route: "/outreach?tab=paused", target: "outreach-tabs", title: "Paused", body: "Outreach pauses on its own when someone replies, declines, asks not to be contacted or a rule says stop. You can see the reason and resume only if it makes sense." },
    { route: "/outreach?tab=results", target: "outreach-results", title: "Honest results", body: "Messages sent, replies, meaningful replies and meetings over the last 90 days. Every rate says what it is divided by, and drafts are never counted as outreach." },
    { route: "/outreach/new", target: "outreach-pick-contact", title: "Start a new outreach", body: "Pick any saved contact to begin. If a colleague or partner knows them, CRE OS suggests asking for a warm introduction first." },
  ],
};
