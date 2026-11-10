import type { Tour } from "../types";

export const tour: Tour = {
  key: "meetings",
  module: "Module 7",
  title: "Meeting preparation",
  summary: "Walk into every client meeting prepared, then turn your notes into approved updates.",
  minutes: 8,
  steps: [
    { route: "/meetings", target: "meetings-heading", title: "Your meetings", body: "Every client meeting gets a preparation page: who you are meeting, why, what happened before and what to ask." },
    { route: "/meetings?tab=today", target: "meetings-tabs", title: "Today first", body: "The page opens on Today: your meetings for the day and what still needs doing before each one. Upcoming, Needs preparation and Past are one tap away." },
    { route: "/meetings", target: "meetings-new", title: "Add a meeting yourself", body: "Press New meeting to add one by hand, for example a site visit fixed on a phone call. Nothing is sent to the attendees." },
    { route: "/meetings?tab=upcoming", target: "meetings-import", title: "Import from your calendar", body: "Upload an .ics file exported from Google or Outlook. Importing the same file again will not create duplicates." },
    { route: "/meetings?tab=upcoming", target: "meetings-connect", title: "Connect your calendar", body: "Connect Google or Outlook once and new meetings get a preparation page every hour." },
    { route: "/meetings", title: "The brief, ready an hour before", body: "Press Prepare brief on a meeting page, or let CRE OS prepare one automatically about an hour before it starts. Each section is labelled Confirmed or Not confirmed." },
    { route: "/meetings", title: "Questions and objections", body: "Questions the client already answered are greyed out, so you don't ask twice. Likely objections come with suggested answers." },
    { route: "/meetings", title: "Meeting mode", body: "Open Meeting mode on your phone during the meeting for a clean view of key points and questions, and to jot quick notes." },
    { route: "/meetings", title: "Site-visit feedback per property", body: "For site visits, record feedback for each building: interested, maybe or rejected, plus ratings for location, layout, parking and price. Rejected only counts if you tick that the client clearly said no." },
    { route: "/meetings", title: "Photos and documents", body: "Upload photos, PDFs or floor plans to a meeting. They stay internal and are never shared automatically." },
    { route: "/meetings", title: "Notes, in any language", body: "Type or paste your notes — English, Hindi or Hinglish all work. CRE OS reads them closely and asks clarification questions where something is unclear." },
    { route: "/meetings", title: "Review proposed updates", body: "Your notes become proposed updates to requirements, deals and contacts, plus tasks. Nothing changes in your records until you approve each one in Review." },
    { route: "/meetings", title: "The follow-up pack", body: "After the meeting you get a follow-up email, a WhatsApp draft, an internal report and an agenda for the next meeting. All are drafts — you check and send them yourself." },
    { route: "/meetings?tab=reports", target: "meetings-tabs", title: "Reports", body: "Reports shows meetings by company, contact and property, with outcomes and follow-ups still pending or overdue. It also counts requirements and deals created within 30 days after a meeting — timing only, not proof." },
  ],
};
