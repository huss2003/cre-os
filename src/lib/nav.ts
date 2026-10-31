/** Primary navigation. Each route is owned by one module (see AGENTS.md). */
export const NAV: { group: string; items: { href: string; label: string; minRole?: "viewer" | "editor" | "admin" | "owner" }[] }[] = [
  { group: "Daily", items: [
    { href: "/today", label: "Today" },
    { href: "/capture", label: "Capture" },
    { href: "/approvals", label: "Approvals" },
    { href: "/tasks", label: "Tasks" },
    { href: "/calendar", label: "Calendar & visits" },
    { href: "/drafts", label: "Drafts" },
  ]},
  { group: "Records", items: [
    { href: "/search", label: "Search" },
    { href: "/companies", label: "Companies" },
    { href: "/people", label: "People" },
    { href: "/buildings", label: "Buildings" },
    { href: "/leases", label: "Lease radar" },
  ]},
  { group: "Deals", items: [
    { href: "/requirements", label: "Requirements" },
    { href: "/deals", label: "Pipeline" },
    { href: "/finance", label: "Financials" },
    { href: "/documents", label: "Documents" },
    { href: "/fees", label: "Fees" },
  ]},
  { group: "Intelligence", items: [
    { href: "/research", label: "Research" },
    { href: "/network", label: "Network" },
    { href: "/market", label: "Market" },
    { href: "/legal", label: "Legal desk" },
    { href: "/content", label: "Content" },
    { href: "/insights", label: "Insights" },
  ]},
  { group: "System", items: [
    { href: "/imports", label: "Imports", minRole: "editor" },
    { href: "/settings", label: "Settings", minRole: "admin" },
    { href: "/admin", label: "Health", minRole: "admin" },
  ]},
];
