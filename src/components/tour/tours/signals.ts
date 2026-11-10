import type { Tour } from "../types";

export const tour: Tour = {
  key: "signals",
  module: "Module 2",
  title: "Signals & research",
  summary: "Spot news and events about your companies early, with the source behind each one.",
  minutes: 5,
  practice: { label: "Practice Co plans Pune expansion (tutorial)", href: "/signals/{signal}", fallback: "/signals" },
  steps: [
    { route: "/signals", target: "signals-header", title: "What a signal is", body: "A signal is a piece of news about a company you track, like hiring, funding, a new office or a lease ending. Press Scan now to look for fresh ones.", placement: "bottom" },
    { route: "/signals", target: "signals-views", kind: "do", task: "Click any view", title: "Filter by type", body: "Pick a view to see only one kind of signal. The number shows how many are open.", placement: "right", waitFor: { type: "click" } },
    { route: "/signals", target: "signals-search", kind: "do", task: "Type Practice in the search box", title: "Find a signal", body: "Search by company, place or words in the evidence. Type: Practice", placement: "bottom", waitFor: { type: "input" } },
    { route: "@current", target: "signals-search", kind: "do", task: "Search, then open the Practice Co signal", title: "Open a signal", body: "Press Enter, then click \"Practice Co plans Pune expansion (tutorial)\".", placement: "bottom", waitFor: { type: "route", route: "/signals/*" } },
    { route: "@current", title: "Source and reliability", body: "Every signal shows where it came from and how sure it is. This practice one is labelled a hypothesis with low confidence — treat a report as a lead to check, not a fact. From here you can act on it or dismiss it." },
    { route: "/research", target: "research-header", title: "Research", body: "Companies you watch are searched on the web on a schedule. Anything found becomes a signal, with its link and date.", placement: "bottom" },
    { route: "/research", target: "research-status", title: "Live sources", body: "This box tells you whether web research is switched on and how many companies are due. If it is off, only your own data and pasted news are used.", placement: "bottom" },
    { route: "/research", title: "Research one company", body: "Add a company to your watch list or open one to research it now. You get an assessment out of 100 showing how likely they are to need space, with the reasons behind the score." },
  ],
};
