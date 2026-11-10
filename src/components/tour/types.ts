/**
 * Guided tutorials ("tours"). A tour is a list of steps; each step lives on a route and may point at an element
 * marked with data-tour="<target>". The runner navigates to the step's route, waits for the target, highlights it
 * and shows the step card. Steps without a target show a centred card.
 */
export interface TourStep {
  route: string;            // e.g. "/outreach" or "/outreach?tab=messages". "@first-outreach" etc. are NOT supported — use real routes.
  target?: string;          // value of a data-tour attribute on that page; omit for a centred explanation card
  title: string;
  body: string;             // 1–3 short plain-language sentences
  placement?: "top" | "bottom" | "left" | "right" | "auto";
}
export interface Tour {
  key: "database" | "signals" | "scoring" | "contacts" | "outreach" | "meetings";
  module: string;           // e.g. "Module 5"
  title: string;            // e.g. "Outreach engine"
  summary: string;          // one line for the tutorial card
  minutes: number;
  steps: TourStep[];
}
