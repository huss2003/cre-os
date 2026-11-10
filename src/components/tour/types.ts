/**
 * Guided tutorials ("tours"). A tour is a list of steps; each step lives on a route and may point at an element
 * marked with data-tour="<target>". The runner navigates to the step's route, waits for the target, highlights it
 * and shows the step card. Steps without a target show a centred card.
 *
 * Hands-on steps (`kind: "do"`) give the user a task and advance by themselves when the user performs it
 * (see `waitFor`). While a do-step is active, only the highlighted element can be clicked.
 */
export interface WaitFor {
  /** click: a click inside [data-tour=target] · route: pathname matches `route` · element: `selector`/[data-tour=target] appears · input: the user types in [data-tour=target] */
  type: "click" | "route" | "element" | "input";
  target?: string;          // data-tour value; defaults to the step's target
  route?: string;           // for type "route": a path, "*" matches one segment (e.g. "/outreach/*"), or "@practice"
  selector?: string;        // for type "element": any CSS selector
}
export interface TourStep {
  /**
   * A real route ("/outreach?tab=messages"), "@practice" (the tour's practice record) or "@current" (stay where the
   * user is — for steps after the user opened a record by clicking).
   */
  route: string;
  target?: string;          // value of a data-tour attribute on that page; omit for a centred explanation card
  title: string;
  body: string;             // 1–3 short plain-language sentences
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  kind?: "explain" | "do";  // default "explain"
  task?: string;            // short instruction shown in the checklist, e.g. "Click Prepare drafts on Priya's card"
  waitFor?: WaitFor;
}
export interface Tour {
  key: "database" | "signals" | "scoring" | "contacts" | "outreach" | "meetings" | "toolkit";
  module: string;           // e.g. "Module 5"
  title: string;            // e.g. "Outreach engine"
  summary: string;          // one line for the tutorial card
  minutes: number;
  /**
   * The practice record the tour works on. `href` may use {company} {contact} {requirement} {opportunity} {signal}
   * {meeting} {outreach} — filled from the practice data; `fallback` is used when that record doesn't exist.
   */
  practice?: { label: string; href: string; fallback?: string };
  learned?: string[];       // shown on the end screen
  steps: TourStep[];
}
