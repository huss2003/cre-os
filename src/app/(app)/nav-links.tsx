"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AskAiButton } from "@/modules/assistant/ui/ask-ai-button";
import { MOBILE_BAR, sectionFor, type BadgeKey, type NavGroup, type NavSection } from "@/lib/nav";

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
/** One simple line icon per menu entry so places are recognisable at a glance (and in icon-only mode). */
export function SectionIcon({ k, className = "h-5 w-5" }: { k: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></>,
    assistant: <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>,
    today: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
    leases: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    companies: <><rect x="4" y="4" width="10" height="16" rx="1" /><path d="M14 9h5a1 1 0 0 1 1 1v10H14M7 8h4M7 12h4M7 16h4" /></>,
    people: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 6.5a3 3 0 0 1 0 5.5M18 20c0-2.2-1-3.9-2.5-4.8" /></>,
    buildings: <><path d="M4 20V8l8-4 8 4v12" /><path d="M9 20v-6h6v6" /></>,
    requirements: <><path d="M9 4h6v3H9zM7 5H5v15h14V5h-2M9 12h6M9 16h4" /></>,
    deals: <><path d="M4 7h16M4 12h10M4 17h6" /></>,
    capture: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
    review: <><path d="M9 12l2 2 4-4" /><rect x="4" y="4" width="16" height="16" rx="4" /></>,
    imports: <><path d="M12 4v11M8 11l4 4 4-4M5 20h14" /></>,
    database: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
    geography: <><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></>,
    signals: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
    research: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
    intel: <><path d="M4 19l5-6 4 3 7-9" /></>,
    scoring: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    contacts: <><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="12" cy="10" r="2.5" /><path d="M8 17c.6-2 2.1-3 4-3s3.4 1 4 3" /></>,
    outreach: <><path d="M4 12l16-7-6 16-3-7z" /><path d="M11 14l9-9" /></>,
    meetings: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
    toolkit: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5h6v2M3 12h18" /></>,
    tutorials: <><path d="M3 8l9-4 9 4-9 4z" /><path d="M7 10v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5" /></>,
    workflows: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5" /></>,
    chevron: <><path d="M9 6l6 6-6 6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></>,
    more: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    close: <><path d="M6 6l12 12M18 6L6 18" /></>,
    collapse: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  };
  return <svg viewBox="0 0 24 24" className={className} {...P} aria-hidden>{paths[k] ?? <circle cx="12" cy="12" r="3" />}</svg>;
}

export type Badges = Partial<Record<BadgeKey, number>>;
const BADGE_LABEL: Record<BadgeKey, string> = { review: "waiting for review", outreach: "drafts to finish", meetings: "meetings today" };

function useActive(groups: NavGroup[], footer: NavSection[]) {
  const path = usePathname();
  return sectionFor(path, [...groups.flatMap((g) => g.items), ...footer]);
}

/** One compact row: 16px icon, 13px label, quiet count on the right. 44px tall on touch screens, 30px on desktop. */
function NavItem({ s, active, collapsed, badge, onNavigate }: { s: NavSection; active: boolean; collapsed?: boolean; badge?: number; onNavigate?: () => void }) {
  return (
    <Link href={s.href} onClick={onNavigate} aria-current={active ? "page" : undefined} title={collapsed ? s.label : undefined}
      className={clsx("group relative flex min-h-11 items-center gap-2.5 rounded-md px-2 text-sm lg:min-h-[30px]",
        collapsed && "justify-center px-0",
        active ? "bg-ink/[0.07] font-medium text-ink" : "text-ink/80 hover:bg-ink/[0.04] hover:text-ink")}>
      <SectionIcon k={s.key} className={clsx("h-4 w-4 shrink-0", active ? "text-ink" : "text-ink-soft group-hover:text-ink")} />
      {collapsed ? <span className="sr-only">{s.label}</span> : <span className="min-w-0 flex-1 truncate">{s.label}</span>}
      {badge ? (
        <span className={clsx("text-xs tabular-nums", s.badge === "review" ? "rounded bg-brand px-1.5 font-medium leading-[18px] text-white" : "text-ink-soft",
          collapsed && "absolute right-0.5 top-0.5 rounded bg-brand px-1 text-[10px] leading-4 text-white")}>
          {badge > 99 ? "99+" : badge}<span className="sr-only"> {s.badge ? BADGE_LABEL[s.badge] : ""}</span>
        </span>
      ) : null}
    </Link>
  );
}

const MORE_STORE = "cre-os.nav-more-open";

function NavGroupBlock({ g, active, badges, collapsed, onNavigate }: { g: NavGroup; active?: string; badges: Badges; collapsed?: boolean; onNavigate?: () => void }) {
  const holdsActive = g.items.some((s) => s.key === active);
  const [open, setOpen] = useState(!g.collapsible);
  useEffect(() => {
    if (!g.collapsible) return;
    try { setOpen(holdsActive || localStorage.getItem(MORE_STORE) === "1"); } catch { setOpen(holdsActive); }
  }, [g.collapsible, holdsActive]);
  const toggle = () => setOpen((o) => { try { localStorage.setItem(MORE_STORE, o ? "0" : "1"); } catch { /* ignore */ } return !o; });
  const showItems = collapsed || open;
  return (
    <div>
      {g.label && !collapsed ? (
        g.collapsible ? (
          <button type="button" onClick={toggle} aria-expanded={open}
            className="mb-0.5 flex min-h-11 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-soft hover:text-ink lg:min-h-7">
            {g.label}<SectionIcon k="chevron" className={clsx("h-3 w-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          </button>
        ) : <h2 className="mb-0.5 flex min-h-7 items-center px-2 text-xs font-medium text-ink-soft">{g.label}</h2>
      ) : null}
      {g.label && collapsed ? <div className="mx-2 my-2 border-t border-line" aria-hidden /> : null}
      {showItems ? (
        <ul className="space-y-px">
          {g.items.map((s) => <li key={s.key}><NavItem s={s} active={active === s.key} collapsed={collapsed} badge={s.badge ? badges[s.badge] : undefined} onNavigate={onNavigate} /></li>)}
        </ul>
      ) : null}
    </div>
  );
}

function NavList({ groups, footer, badges, collapsed, onNavigate }: { groups: NavGroup[]; footer: NavSection[]; badges: Badges; collapsed?: boolean; onNavigate?: () => void }) {
  const active = useActive(groups, footer)?.key;
  return (
    <nav aria-label="Main" className="space-y-4">
      {groups.map((g) => <NavGroupBlock key={g.key} g={g} active={active} badges={badges} collapsed={collapsed} onNavigate={onNavigate} />)}
    </nav>
  );
}

const NEW_ITEMS = [
  { href: "/capture", label: "Capture a note or file", k: "capture" },
  { href: "/outreach/new", label: "New outreach", k: "outreach" },
  { href: "/meetings/new", label: "New meeting", k: "meetings" },
  { href: "/toolkit/compare/new", label: "New comparison", k: "toolkit" },
];

/** "New" quick menu. Closes on Escape, outside click and navigation. */
function NewMenu({ compact, align = "right" }: { compact?: boolean; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="New"
        className={clsx("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md text-sm font-medium lg:min-h-8",
          compact ? "w-11 border border-line bg-surface text-ink hover:bg-canvas lg:w-8" : "bg-brand px-3 text-white hover:bg-brand-strong")}>
        <SectionIcon k="plus" className="h-4 w-4" />{compact ? <span className="sr-only">New</span> : "New"}
      </button>
      {open ? (
        <ul role="menu" className={clsx("absolute z-40 mt-1.5 w-60 rounded-lg border border-line bg-surface p-1 shadow-xl", align === "right" ? "right-0" : "left-0")}>
          {NEW_ITEMS.map((i) => (
            <li key={i.href} role="none">
              <Link role="menuitem" href={i.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-canvas lg:min-h-8">
                <SectionIcon k={i.k} className="h-4 w-4 text-ink-soft" />{i.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Sidebar search. Ctrl/⌘ K focuses it from anywhere. */
function SearchBox() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ref.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form action="/search" role="search" className="relative min-w-0 flex-1">
      <label htmlFor="global-search" className="sr-only">Search everything</label>
      <SectionIcon k="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
      <input ref={ref} id="global-search" name="q" type="search" aria-label="Search" placeholder="Search"
        className="peer block min-h-11 w-full rounded-md border border-line bg-surface pl-7 pr-10 text-sm text-ink placeholder:text-ink-soft focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 lg:min-h-8" />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1 text-[10px] text-ink-soft peer-focus:hidden lg:block">⌘K</kbd>
    </form>
  );
}

const STORE = "cre-os.sidebar-collapsed";

/** The whole app frame: sidebar (desktop), slim page header, drawer + bottom tabs (mobile), page container. */
export function AppShell({ groups, footer, badges, workspace, account, children }: {
  groups: NavGroup[]; footer: NavSection[]; badges: Badges; workspace: ReactNode; account: ReactNode; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const path = usePathname();
  const active = useActive(groups, footer);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { setCollapsed(localStorage.getItem(STORE) === "1"); } catch { /* storage blocked */ } }, []);
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(STORE, c ? "0" : "1"); } catch { /* ignore */ } return !c; });
  useEffect(() => { setDrawer(false); }, [path]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [drawer]);

  const title = path === "/search" ? "Search" : active?.label ?? "CRE OS";
  const items = groups.flatMap((g) => g.items);
  const tab = (k: string) => items.find((s) => s.key === k);
  const bottom = MOBILE_BAR.map(tab).filter((s): s is NavSection => !!s);

  return (
    <div className={clsx("min-h-screen bg-surface lg:grid", collapsed ? "lg:grid-cols-[60px_1fr]" : "lg:grid-cols-[232px_1fr]")}>
      <a href="#main" className="sr-only z-50 rounded-md bg-brand px-4 py-3 font-medium text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>

      <aside className="hidden border-r border-line bg-canvas lg:block" aria-label="Sidebar">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto overflow-x-hidden px-2.5 py-3">
          <div className={clsx("mb-3 flex items-center gap-1", collapsed ? "flex-col" : "justify-between pl-1")}>
            <Link href="/today" className="flex min-h-8 items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-ink text-[11px] font-bold text-white">C</span>
              {collapsed ? <span className="sr-only">CRE OS</span> : "CRE OS"}
            </Link>
            <button type="button" onClick={toggle} aria-pressed={collapsed} aria-label={collapsed ? "Expand menu" : "Collapse menu to icons"} title={collapsed ? "Expand menu" : "Collapse menu"}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink">
              <SectionIcon k="collapse" className="h-4 w-4" />
            </button>
          </div>
          {collapsed ? (
            <div className="mb-3 flex flex-col items-center gap-1">
              <Link href="/search" title="Search" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink">
                <SectionIcon k="search" className="h-4 w-4" /><span className="sr-only">Search</span>
              </Link>
              <NewMenu compact align="left" />
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-1.5"><SearchBox /><NewMenu compact align="left" /></div>
          )}
          <NavList groups={groups} footer={[]} badges={badges} collapsed={collapsed} />
          <div className="mt-auto space-y-2 pt-6">
            <NavList groups={[{ key: "footer", label: null, items: footer }]} footer={[]} badges={badges} collapsed={collapsed} />
            {collapsed ? null : <div className="space-y-2">{workspace}{account}</div>}
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
          <div className="flex items-center gap-1 px-2 py-1.5 lg:hidden">
            <button type="button" onClick={() => setDrawer(true)} aria-expanded={drawer} aria-controls="nav-drawer"
              className="flex h-11 w-11 items-center justify-center rounded-md text-ink hover:bg-canvas">
              <SectionIcon k="more" className="h-5 w-5" /><span className="sr-only">Open menu</span>
            </button>
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</p>
            <Link href="/search" className="flex h-11 w-11 items-center justify-center rounded-md text-ink hover:bg-canvas">
              <SectionIcon k="search" className="h-5 w-5" /><span className="sr-only">Search</span>
            </Link>
            <NewMenu compact />
          </div>
          <div className="hidden h-12 items-center gap-3 px-6 lg:flex">
            {active && active.tabs.length > 1 ? null : <p className="shrink-0 text-sm font-medium text-ink">{title}</p>}
            <SectionTabs sections={items.concat(footer)} />
            <div className="ml-auto flex items-center gap-2"><AskAiButton variant="bar" /></div>
          </div>
        </header>

        <div className="border-b border-line px-3 py-1.5 empty:hidden lg:hidden"><SectionTabs sections={items.concat(footer)} /></div>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 focus:outline-none sm:px-6 lg:px-10 lg:pb-12 lg:pt-8">
          {children}
        </main>

        <AskAiButton variant="fab" />
        <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] text-center text-[11px] backdrop-blur lg:hidden">
          {bottom.map((s) => {
            const on = active?.key === s.key;
            const b = s.badge ? badges[s.badge] : undefined;
            return (
              <Link key={s.key} href={s.href} aria-current={on ? "page" : undefined}
                className={clsx("relative flex min-h-14 flex-col items-center justify-center gap-1 font-medium", on ? "text-ink" : "text-ink-soft")}>
                <SectionIcon k={s.key} className="h-5 w-5" />{s.label}
                {b ? <span className="absolute right-[24%] top-2 h-1.5 w-1.5 rounded-full bg-brand" aria-hidden /> : null}
              </Link>
            );
          })}
          <button type="button" onClick={() => setDrawer(true)} className="flex min-h-14 flex-col items-center justify-center gap-1 font-medium text-ink-soft">
            <SectionIcon k="more" className="h-5 w-5" />More
          </button>
        </nav>
      </div>

      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu" id="nav-drawer">
          <button type="button" aria-label="Close menu" tabIndex={-1} className="absolute inset-0 bg-ink/30" onClick={() => setDrawer(false)} />
          <div ref={drawerRef} className="absolute inset-y-0 left-0 flex w-[min(300px,86vw)] flex-col overflow-y-auto bg-canvas px-2.5 py-2 shadow-2xl">
            <div className="mb-2 flex items-center justify-between pl-1">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-ink text-[11px] font-bold text-white">C</span>CRE OS
              </span>
              <button type="button" onClick={() => setDrawer(false)} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-ink/[0.05]">
                <SectionIcon k="close" className="h-5 w-5" /><span className="sr-only">Close menu</span>
              </button>
            </div>
            <NavList groups={groups} footer={footer} badges={badges} onNavigate={() => setDrawer(false)} />
            <div className="mt-auto space-y-2 pt-6">
              <NavList groups={[{ key: "footer", label: null, items: footer }]} footer={[]} badges={badges} onNavigate={() => setDrawer(false)} />
              {workspace}{account}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Tabs for the current section (hidden when a section has one screen). Quiet text tabs, Linear-style. */
export function SectionTabs({ sections }: { sections: NavSection[] }) {
  const path = usePathname();
  const s = sectionFor(path, sections);
  if (!s || s.tabs.length < 2) return null;
  const current = s.tabs.filter((t) => path === t.href || path.startsWith(t.href + "/")).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <div className="-mx-1 min-w-0 overflow-x-auto">
      <div className="flex min-w-max items-center gap-0.5 px-1">
        {s.tabs.map((t) => (
          <Link key={t.href} href={t.href} aria-current={current === t.href ? "page" : undefined}
            className={clsx("flex min-h-11 items-center whitespace-nowrap rounded-md px-2.5 text-sm lg:min-h-7",
              current === t.href ? "bg-ink/[0.07] font-medium text-ink" : "text-ink-soft hover:bg-ink/[0.04] hover:text-ink")}>
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
