import type { Tour } from "../types";

export const tour: Tour = {
  key: "automation",
  module: "Module 9",
  title: "Automation",
  summary: "See what runs by itself, read your daily plan, fix a failed job and refresh outdated proposals.",
  minutes: 6,
  learned: [
    "Automation → Overview shows what needs you, what runs and every workflow",
    "The daily plan is built at 08:00; meeting briefs are prepared about an hour before",
    "Retry re-runs only failed steps; Pause, Resume and Cancel control a run",
    "Outdated proposals are flagged, never overwritten when approved",
  ],
  steps: [
    { route: "/automation", title: "What runs by itself", body: "This page lists every background job. Start each day with Needs attention: failed, paused and waiting jobs, and records that became out of date." },
    { route: "/automation", title: "All workflows", body: "Each workflow says what starts it (a new quote, a changed requirement, a cancelled meeting…) and whether it is On. Open one to see its steps, last and next run, and controls." },
    { route: "/automation", kind: "do", task: "Open the Daily plan tab", title: "Your 08:00 daily plan", body: "Click the Daily plan tab. The plan is built by itself at 08:00 each working day; Build now makes it earlier.", waitFor: { type: "element", selector: "a[aria-current=page][href='/automation?view=daily']" } },
    { route: "/automation?view=daily", title: "Capacity and suggestions", body: "Warnings show overlapping meetings, too many meetings and overdue commitments. Suggestions are only suggestions — nothing is moved for you. Travel time stays 'unknown' rather than guessed." },
    { route: "/automation?view=notifications", title: "Meeting briefs an hour before", body: "About an hour before each client meeting the brief is prepared and a 'Brief ready' notice appears here and under the bell. Done, Snooze 3h and Dismiss keep the list short." },
    { route: "/automation?view=budgets", title: "Budgets", body: "Admins set daily or monthly limits for AI, research and other paid usage. At the limit, non-critical jobs pause — nothing is lost and no other provider is used." },
    { route: "/automation", title: "Fix a failed job", body: "Open a failed job from Needs attention. 'What went wrong' explains the error and what to do; Retry failed steps re-runs only those steps. Paused runs have Resume and Cancel." },
    { route: "/approvals/outdated", title: "Outdated proposals", body: "After a new quote or a requirement change, comparisons are recalculated as new versions and proposals built on old figures are listed here. Refresh brings one up to date; Dismiss closes the warning. Approved ones are never overwritten." },
    { route: "/assistant", title: "Ask AI to run it", body: "In Ask AI type, for example, \"prepare tomorrow's meetings and list pending client commitments\". It starts the matching workflow and links to the run." },
  ],
};
