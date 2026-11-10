import type { Tour } from "../types";

const SAMPLE_NOTE = "Priya confirmed 25,000 sq ft in Kharadi, budget around ₹95/sf/month, move by March. CFO Anil decides. We promised 3 options by Friday.";

export const tour: Tour = {
  key: "meetings",
  module: "Module 7",
  title: "Meeting preparation",
  summary: "Prepare a brief for a practice meeting, take notes in Meeting mode and turn them into approved updates.",
  minutes: 10,
  practice: { label: "Practice Co — requirement discussion (tutorial), tomorrow 11:00", href: "/meetings/{meeting}", fallback: "/meetings?tab=upcoming" },
  learned: [
    "Every meeting has a preparation page with a readiness score",
    "Prepare brief pulls company, people, signals and the deal from your records",
    "Meeting mode is a clean phone view for key points and quick notes",
    "Structure my notes turns notes into proposed updates and tasks",
    "You choose what to apply — record changes still go through Review",
  ],
  steps: [
    { route: "/meetings", target: "meetings-heading", title: "Your meetings", body: "Every client meeting gets a preparation page. You'll now prepare, run and wrap up a practice meeting with Practice Co." },
    { route: "/meetings?tab=upcoming", target: "meeting-practice-row", kind: "do", task: "Open the Practice Co meeting", title: "Open the practice meeting", body: "Tomorrow's \"Practice Co — requirement discussion (tutorial)\" is in Upcoming. Click it.", waitFor: { type: "route", route: "@practice" } },
    { route: "@practice", title: "The preparation page", body: "Who you're meeting, why, what happened before and what to ask — all on one page. Right now there's no brief yet." },
    { route: "@practice", target: "meeting-prepare", kind: "do", task: "Click Prepare brief", title: "Prepare the brief", body: "Press Prepare brief. It gathers the company, attendees, the expansion signal and the deal from your records.", waitFor: { type: "click" } },
    { route: "@current", target: "meeting-readiness", title: "Readiness", body: "The score shows how prepared you are. Critical items need fixing before the meeting; Missing items are good to find out. Each fact in the brief is labelled Confirmed or Not confirmed." },
    { route: "@current", title: "Questions and objections", body: "Scroll the brief: questions the client already answered are greyed out, and likely objections come with suggested answers." },
    { route: "@current", target: "meeting-mode", kind: "do", task: "Open Meeting mode", title: "In the meeting", body: "Meeting mode is a clean view for your phone during the meeting. Open it.", waitFor: { type: "click" } },
    { route: "@current", target: "meeting-live-note-text", kind: "do", task: "Type (or paste) a note", title: "Jot a quick note", body: `Type a note as if Priya just told you something. Try:\n\n“${SAMPLE_NOTE}”`, waitFor: { type: "input" } },
    { route: "@current", target: "meeting-live-save", kind: "do", task: "Press Save", title: "Save the note", body: "Notes save straight to this meeting. English, Hindi or Hinglish all work.", waitFor: { type: "click" } },
    { route: "@current", target: "meeting-live-finish", kind: "do", task: "Press Finish: turn notes into updates", title: "The meeting is over", body: "Time to turn your notes into updates. Press Finish.", waitFor: { type: "click" } },
    { route: "@current", target: "meeting-after", title: "After the meeting", body: "Your Meeting mode notes are included automatically. Add anything else you remember in the box." },
    { route: "@current", target: "meeting-structure", kind: "do", task: "Press Structure my notes", title: "Structure the notes", body: "CRE OS reads the notes closely: area, budget, dates, who decides and what you promised.", waitFor: { type: "click" } },
    { route: "@current", target: "meeting-clarify", kind: "do", task: "Answer any clarification questions", title: "Anything unclear?", body: "If something in your notes is ambiguous, CRE OS asks first. Answer and press Save answers. If there are no questions, this step ticks itself.", waitFor: { type: "element", selector: "[data-tour=\"meeting-apply\"]" } },
    { route: "@current", target: "meeting-apply", title: "Choose what to apply", body: "Each box is one kind of update. Requirement and contact changes go to Review; commitments become tasks. Untick anything you don't want." },
    { route: "@current", target: "meeting-apply-submit", kind: "do", task: "Press Approve selected", title: "Apply", body: "Press Approve selected. Nothing is overwritten — record changes wait in Review.", waitFor: { type: "click" } },
    { route: "@current", target: "meeting-applied", title: "Done — and the follow-up pack", body: "You now get a client email draft, WhatsApp draft, internal report and next agenda. All are drafts: you check and send them yourself." },
  ],
};
