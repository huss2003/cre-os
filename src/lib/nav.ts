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
 * FOCUS MODE (owner request, Nov 2026): only the Module 1 database screens are shown. Every other screen still exists
 * in the code but is hidden from the menu, and direct visits are redirected to /database (see src/proxy.ts).
 * Set NEXT_PUBLIC_FULL_APP=1 in Vercel to show the whole app again.
 */
export const FOCUS_MODE = process.env.NEXT_PUBLIC_FULL_APP !== "1";
export const HIDDEN_PREFIXES = ["/today", "/tasks", "/calendar", "/drafts", "/leases", "/finance", "/documents", "/fees",
  "/market", "/research", "/network", "/legal", "/content", "/insights", "/settings", "/admin", "/platform"];
/** Kept reachable inside hidden areas because the Database screen links to them. */
const ALLOWED_INSIDE_HIDDEN = ["/admin/audit"];
export function isHiddenPath(path: string): boolean {
  if (!FOCUS_MODE) return false;
  if (ALLOWED_INSIDE_HIDDEN.some((a) => path === a || path.startsWith(a + "/"))) return false;
  return HIDDEN_PREFIXES.some((h) => path === h || path.startsWith(h + "/"));
}
export const HOME = FOCUS_MODE ? "/database" : "/today";

/** The section a path belongs to: the tab with the longest matching prefix wins. */
export function sectionFor(path: string, sections: NavSection[] = NAV): NavSection | null {
  let best: { s: NavSection; len: number } | null = null;
  for (const s of sections) for (const t of s.tabs) {
    if ((path === t.href || path.startsWith(t.href + "/")) && (!best || t.href.length > best.len)) best = { s, len: t.href.length };
  }
  return best?.s ?? null;
}

/** Mobile bottom bar: the five daily sections. */
export const MOBILE_BAR = ["today", "capture", "review", "records", "deals", "setup"] as const;
