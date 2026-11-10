/**
 * Primary navigation: seven sections, each a job the user does. Every screen still exists; related screens are tabs
 * inside one section instead of 26 separate menu entries. Each route is owned by one module (see AGENTS.md).
 */
export type Role = "viewer" | "editor" | "admin" | "owner";
export interface NavTab { href: string; label: string; minRole?: Role; platformOnly?: boolean }
export interface NavSection { key: string; label: string; hint: string; href: string; tabs: NavTab[]; minRole?: Role }

export const NAV: NavSection[] = [
  { key: "today", label: "Today", hint: "Your plan, tasks and visits", href: "/today", tabs: [
    { href: "/today", label: "Plan" },
    { href: "/tasks", label: "Tasks" },
    { href: "/calendar", label: "Calendar & visits" },
  ]},
  { key: "capture", label: "Capture", hint: "Log a call, meeting or visit", href: "/capture", tabs: [
    { href: "/capture", label: "Capture" },
  ]},
  { key: "review", label: "Review", hint: "Check changes before they apply", href: "/approvals", tabs: [
    { href: "/approvals", label: "Review" },
    { href: "/drafts", label: "Drafts & messages" },
  ]},
  { key: "records", label: "Records", hint: "Companies, people, buildings", href: "/search", tabs: [
    { href: "/search", label: "Search" },
    { href: "/companies", label: "Companies" },
    { href: "/people", label: "People" },
    { href: "/buildings", label: "Buildings" },
    { href: "/leases", label: "Lease radar" },
  ]},
  { key: "deals", label: "Deals", hint: "Requirements and opportunities", href: "/deals", tabs: [
    { href: "/deals", label: "Pipeline" },
    { href: "/requirements", label: "Requirements" },
    { href: "/finance", label: "Financials" },
    { href: "/documents", label: "Documents" },
    { href: "/fees", label: "Fees" },
  ]},
  { key: "signals", label: "Signals", hint: "Events that may need action", href: "/signals", tabs: [
    { href: "/signals", label: "Signals" },
  ]},
  { key: "contacts", label: "Contacts", hint: "Find and verify decision-makers", href: "/contacts", tabs: [
    { href: "/contacts", label: "Contacts" },
  ]},
  { key: "meetings", label: "Meetings", hint: "Prepare for every meeting", href: "/meetings", tabs: [
    { href: "/meetings", label: "Meetings" },
  ]},
  { key: "outreach", label: "Outreach", hint: "Who to contact today and what to say", href: "/outreach", tabs: [
    { href: "/outreach", label: "Outreach" },
  ]},
  { key: "scoring", label: "Scoring", hint: "Who to focus on first", href: "/scoring", tabs: [
    { href: "/scoring", label: "Scores" },
  ]},
  { key: "intel", label: "Intelligence", hint: "Market, research, network", href: "/market", tabs: [
    { href: "/market", label: "Market" },
    { href: "/research", label: "Research" },
    { href: "/network", label: "Network" },
    { href: "/legal", label: "Legal" },
    { href: "/content", label: "Content" },
    { href: "/insights", label: "Reports" },
  ]},
  { key: "setup", label: "Setup", hint: "Database, places, imports", href: "/database", minRole: "editor", tabs: [
    { href: "/database", label: "Database", minRole: "editor" },
    { href: "/geography", label: "Geography", minRole: "editor" },
    { href: "/imports", label: "Imports", minRole: "editor" },
    { href: "/settings", label: "Settings", minRole: "admin" },
    { href: "/admin", label: "Health", minRole: "admin" },
    { href: "/platform", label: "Tenants", platformOnly: true },
  ]},
];

/**
 * FOCUS MODE (owner request, Nov 2026): only Module 5 (Outreach) and Module 7 (Meetings) are shown in the menu.
 * Modules 1–4 stay in code and are reachable by link from those screens (contacts, companies, deals, signals, review).
 * Every other screen still exists in code. Record pages that a signal links to (company, person, building, requirement,
 * tasks, review) stay reachable by link but are not in the menu. Everything else redirects to /signals (src/proxy.ts).
 * Set NEXT_PUBLIC_FULL_APP=1 in Vercel to show the whole app again.
 */
export const FOCUS_MODE = process.env.NEXT_PUBLIC_FULL_APP !== "1";
/** Screens shown in the menu while in focus mode. */
export const FOCUS_MENU = [
  // Module 5 — Outreach
  "/outreach",
  // Module 7 — Meeting preparation
  "/meetings",
];
/** Reachable by link from a signal, but not shown in the menu. */
const FOCUS_LINKED = ["/settings/connections", "/contacts", "/drafts", "/companies", "/people", "/buildings", "/requirements", "/deals", "/signals", "/tasks", "/approvals", "/search", "/scoring", "/research"];
export const HIDDEN_PREFIXES: string[] = [];
const under = (path: string, list: string[]) => list.some((h) => path === h || path.startsWith(h + "/"));
export function isHiddenPath(path: string): boolean {
  if (!FOCUS_MODE) return false;
  return !under(path, FOCUS_MENU) && !under(path, FOCUS_LINKED);
}
/** Menu filter: only the focus screens. */
export function inFocusMenu(path: string): boolean {
  return !FOCUS_MODE || under(path, FOCUS_MENU);
}
export const HOME = FOCUS_MODE ? "/outreach" : "/today";

/** The section a path belongs to: the tab with the longest matching prefix wins. */
export function sectionFor(path: string, sections: NavSection[] = NAV): NavSection | null {
  let best: { s: NavSection; len: number } | null = null;
  for (const s of sections) for (const t of s.tabs) {
    if ((path === t.href || path.startsWith(t.href + "/")) && (!best || t.href.length > best.len)) best = { s, len: t.href.length };
  }
  return best?.s ?? null;
}

/** Mobile bottom bar: the five daily sections. */
export const MOBILE_BAR = ["today", "capture", "review", "records", "deals", "signals", "scoring", "contacts", "intel", "setup"] as const;
