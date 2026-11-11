/**
 * Primary navigation: seven sections, each a job the user does. Every screen still exists; related screens are tabs
 * inside one section instead of 26 separate menu entries. Each route is owned by one module (see AGENTS.md).
 */
export type Role = "viewer" | "editor" | "admin" | "owner";
export interface NavTab { href: string; label: string; minRole?: Role; platformOnly?: boolean }
/** One menu entry. `tabs` lists every screen that belongs to it (shown as tabs above the page when >1). */
export interface NavSection { key: string; label: string; hint: string; href: string; tabs: NavTab[]; minRole?: Role; platformOnly?: boolean; badge?: BadgeKey }
export type BadgeKey = "review" | "outreach" | "meetings";
/** A labelled group of menu entries (one per module). `label` null = no heading. */
export interface NavGroup { key: string; label: string | null; items: NavSection[] }

const one = (key: string, label: string, hint: string, href: string, extra: Partial<NavSection> = {}): NavSection =>
  ({ key, label, hint, href, tabs: [{ href, label }], ...extra });

/** The sidebar, in order. Plain-language groups, one per module. */
export const NAV_GROUPS: NavGroup[] = [
  { key: "home", label: null, items: [
    one("home", "Home", "Today at a glance", "/home"),
    { key: "assistant", label: "Ask AI", hint: "Ask questions, get briefs and drafts", href: "/assistant", tabs: [
      { href: "/assistant", label: "Chat" }, { href: "/assistant/memory", label: "Memory" }, { href: "/assistant/commands", label: "Saved commands" }, { href: "/assistant/notes", label: "Notes" }, { href: "/assistant/usage", label: "Usage" }] },
  ] },
  { key: "plan", label: "Plan", items: [
    { key: "today", label: "Today", hint: "Your plan, tasks and visits", href: "/today", tabs: [
      { href: "/today", label: "Plan" }, { href: "/tasks", label: "Tasks" }, { href: "/calendar", label: "Calendar & visits" }] },
    one("leases", "Lease radar", "Leases coming up for renewal", "/leases"),
  ]},
  { key: "records", label: "Records", items: [
    one("companies", "Companies", "Every company you track", "/companies"),
    one("people", "People", "Contacts at those companies", "/people"),
    one("buildings", "Buildings", "Campuses, towers and space", "/buildings"),
    one("requirements", "Requirements", "What each client is looking for", "/requirements"),
    { key: "deals", label: "Deals", hint: "Opportunities in progress", href: "/deals", tabs: [
      { href: "/deals", label: "Pipeline" }, { href: "/finance", label: "Financials" }, { href: "/documents", label: "Documents" }, { href: "/fees", label: "Fees" }] },
    one("capture", "Capture", "Log a call, meeting or visit", "/capture"),
    one("review", "Review", "Check changes before they apply", "/approvals", { badge: "review" }),
    one("imports", "Imports", "Bring in a spreadsheet", "/imports", { minRole: "editor" }),
    one("database", "Database", "Browse all tables", "/database", { minRole: "editor" }),
    one("geography", "Places", "Cities, micro-markets", "/geography", { minRole: "editor" }),
  ]},
  { key: "signals", label: "Signals & research", items: [
    one("signals", "Signals", "Events that may need action", "/signals"),
    one("research", "Research", "Look into a company", "/research"),
  ]},
  { key: "intel", label: "Intelligence", items: [
    { key: "intel", label: "Market & reports", hint: "Market, network, legal, content", href: "/market", tabs: [
      { href: "/market", label: "Market" }, { href: "/network", label: "Network" }, { href: "/legal", label: "Legal" },
      { href: "/content", label: "Content" }, { href: "/insights", label: "Reports" }] },
  ]},
  { key: "scoring", label: "Scoring", items: [one("scoring", "Scores", "Who to focus on first", "/scoring")] },
  { key: "contacts", label: "Contacts", items: [one("contacts", "Find contacts", "Find and verify decision-makers", "/contacts")] },
  { key: "outreach", label: "Outreach", items: [
    { key: "outreach", label: "Outreach", hint: "Who to contact and what to say", href: "/outreach", badge: "outreach", tabs: [
      { href: "/outreach", label: "Outreach" }, { href: "/drafts", label: "Drafts & messages" }] },
  ]},
  { key: "meetings", label: "Meetings", items: [one("meetings", "Meetings", "Prepare for every meeting", "/meetings", { badge: "meetings" })] },
  { key: "toolkit", label: "Deal toolkit", items: [one("toolkit", "Deal toolkit", "Compare, cost and recommend", "/toolkit")] },
  { key: "learn", label: "Learn", items: [one("tutorials", "Tutorials", "Guided walk-throughs", "/tutorials")] },
];

/** Shown at the bottom of the sidebar, next to the account. Not affected by focus mode. */
export const NAV_FOOTER: NavSection[] = [
  { key: "settings", label: "Settings", hint: "Workspace settings", href: "/settings", minRole: "admin", tabs: [
    { href: "/settings", label: "Settings", minRole: "admin" }, { href: "/admin", label: "Health", minRole: "admin" },
    { href: "/platform", label: "Tenants", platformOnly: true }] },
];

/** Flat list (used for active-section lookup and page tabs). */
export const NAV: NavSection[] = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_FOOTER];

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
  "/home",
  // Module 12 — AI assistant
  "/assistant",
  // Module 1 — Database
  "/capture", "/approvals", "/companies", "/people", "/buildings", "/deals", "/requirements", "/database", "/geography", "/imports",
  // Module 2 — Signals & research
  "/signals", "/research",
  // Module 3 — Scoring
  "/scoring",
  // Module 4 — Contact enrichment
  "/contacts",
  // Module 5 — Outreach
  "/outreach",
  // Module 7 — Meeting preparation
  "/meetings",
  // Module 8 — Deal toolkit
  "/toolkit",
  // Guided tutorials
  "/tutorials",
];
/** Reachable by link from a signal, but not shown in the menu. */
const FOCUS_LINKED = ["/settings/connections", "/contacts", "/drafts", "/companies", "/people", "/buildings", "/requirements", "/deals", "/signals", "/tasks", "/approvals", "/search", "/scoring", "/research"];
export const HIDDEN_PREFIXES: string[] = [];
const under = (path: string, list: string[]) => list.some((h) => path === h || path.startsWith(h + "/"));
export function isHiddenPath(path: string): boolean {
  // Focus mode only trims the MENU. Every screen stays reachable by link, so buttons/links that open a
  // contact, company, deal, document, settings page etc. never bounce back to Home.
  if (!FOCUS_MODE) return false;
  return path === "/today" && !under(path, FOCUS_MENU);
}
/** Menu filter: only the focus screens. */
export function inFocusMenu(path: string): boolean {
  return !FOCUS_MODE || under(path, FOCUS_MENU);
}
export const HOME = "/home";

/** The section a path belongs to: the tab with the longest matching prefix wins. */
export function sectionFor(path: string, sections: NavSection[] = NAV): NavSection | null {
  let best: { s: NavSection; len: number } | null = null;
  for (const s of sections) for (const t of s.tabs) {
    if ((path === t.href || path.startsWith(t.href + "/")) && (!best || t.href.length > best.len)) best = { s, len: t.href.length };
  }
  return best?.s ?? null;
}

/** Mobile bottom tab bar (plus a "More" button that opens the full menu). */
export const MOBILE_BAR = ["home", "outreach", "meetings", "toolkit"] as const;
