import type { Tour } from "../types";

export const tour: Tour = {
  key: "meetings",
  module: "Module 7",
  title: "Meeting preparation",
  summary: "Walk into every client meeting prepared, then turn your notes into approved updates.",
  minutes: 6,
  steps: [
    { route: "/meetings", target: "meetings-heading", title: "Your meetings", body: "Every client meeting gets a preparation page: who you are meeting, why, what happened before and what to ask." },
    { route: "/meetings", target: "meetings-tabs", title: "Upcoming, prep, past", body: "Needs preparation shows meetings whose brief is not ready yet. Past meetings are where you add notes afterwards." },
    { route: "/meetings", target: "meetings-new", title: "Add a meeting yourself", body: "Press New meeting to add one by hand, for example a site visit fixed on a phone call." },
    { route: "/meetings/new", target: "meetings-new-form", title: "New meeting form", body: "Give it a title, date, time and the company and people attending. Nothing is sent to the attendees — this is only your own preparation." },
    { route: "/meetings", target: "meetings-import", title: "Import from your calendar", body: "Export an .ics file from Google or Outlook and upload it here. Importing the same file again will not create duplicates." },
    { route: "/meetings", target: "meetings-connect", title: "Connect your calendar", body: "Connect Google or Outlook once and new meetings get a preparation page every hour. Press Check now if you just booked one." },
    { route: "/meetings", title: "The brief", body: "On a meeting page, press Prepare brief. A readiness score shows how complete it is, and every section is labelled Confirmed or Not confirmed so you know what still needs checking." },
    { route: "/meetings", title: "Questions and objections", body: "Questions the client has already answered are greyed out, so you don't ask twice. Likely objections are anticipated with suggested answers, and matching properties show how well they fit the requirement." },
    { route: "/meetings", title: "Meeting mode", body: "Open Meeting mode on your phone during the meeting for a clean view of key points and questions, and to jot quick notes." },
    { route: "/meetings", title: "After the meeting", body: "Type or paste your notes. CRE OS turns them into proposed updates and tasks, and nothing changes in your records until you approve each one." },
    { route: "/meetings", title: "Site-visit checklist", body: "For site visits, a checklist covers what to inspect and ask at each building, so your comparison later is based on the same points." },
  ],
};
