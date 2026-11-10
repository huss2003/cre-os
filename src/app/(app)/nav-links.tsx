"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AskAiButton } from "@/modules/assistant/ui/ask-ai-button";
import { sectionFor, type BadgeKey, type NavGroup, type NavSection } from "@/lib/nav";

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

function NavItem({ s, active, collapsed, badge, onNavigate }: { s: NavSection; active: boolean; collapsed?: boolean; badge?: number; onNavigate?: () => void }) {
  return (
    <Link href={s.href} onClick={onNavigate} aria-current={active ? "page" : undefined} title={collapsed ? s.label : undefined}
      className={clsx("relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors motion-reduce:transition-none",
        collapsed && "justify-center px-0",
        active ? "bg-brand-soft font-semibold text-brand before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand"
          : "text-ink hover:bg-canvas")}>
      <SectionIcon k={s.key} className="h-5 w-5 shrink-0" />
      {collapsed ? <span className="sr-only">{s.label}</span> : <span className="min-w-0 flex-1 truncate">{s.label}</span>}
      {badge ? (
        <span className={clsx("rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-5 text-white", collapsed && "absolute right-1 top-1")}>
          {badge > 99 ? "99+" : badge}<span className="sr-only"> {s.badge ? BADGE_LABEL[s.badge] : ""}</span>
        </span>
      ) : null}
    </Link>
  );
}

function NavList({ groups, footer, badges, collapsed, onNavigate }: { groups: NavGroup[]; footer: NavSection[]; badges: Badges; collapsed?: boolean; onNavigate?: () => void }) {
  const active = useActive(groups, footer)?.key;
  return (
    <nav aria-label="Main" className="space-y-4">
      {groups.map((g) => (
        <div key={g.key}>
          {g.label && !collapsed ? <h2 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-soft">{g.label}</h2> : null}
          {g.label && collapsed ? <div className="mx-3 mb-2 border-t border-line" aria-hidden /> : null}
          <ul className="space-y-0.5">
            {g.items.map((s) => <li key={s.key}><NavItem s={s} active={active === s.key} collapsed={collapsed} badge={s.badge ? badges[s.badge] : undefined} onNavigate={onNavigate} /></li>)}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const NEW_ITEMS = [
  { href: "/outreach/new", label: "New outreach", k: "outreach" },
  { href: "/meetings/new", label: "New meeting", k: "meetings" },
  { href: "/toolkit/compare/new", label: "New comparison", k: "toolkit" },
  { href: "/capture", label: "Capture a note", k: "capture" },
];

/** "+ New" quick menu. Closes on Escape, outside click and navigation. */
function NewMenu({ compact }: { compact?: boolean }) {
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
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={clsx("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-brand text-sm font-semibold text-white shadow-sm hover:bg-brand-strong", compact ? "w-11" : "px-4")}>
        <SectionIcon k="plus" className="h-5 w-5" />{compact ? <span className="sr-only">New</span> : "New"}
      </button>
      {open ? (
        <ul role="menu" className="absolute right-0 z-40 mt-2 w-56 rounded-xl border border-line bg-surface p-1.5 shadow-xl">
          {NEW_ITEMS.map((i) => (
            <li key={i.href} role="none">
              <Link role="menuitem" href={i.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-ink hover:bg-canvas">
                <SectionIcon k={i.k} className="h-5 w-5 text-ink-soft" />{i.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SearchBox() {
  return (
    <form action="/search" role="search" className="relative w-full max-w-md">
      <label htmlFor="global-search" className="sr-only">Search companies, people, buildings</label>
      <SectionIcon k="search" className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-soft" />
      <input id="global-search" name="q" type="search" placeholder="Search companies, people, buildings…"
        className="block min-h-11 w-full rounded-lg border border-line bg-canvas pl-10 pr-3 text-sm text-ink placeholder:text-ink-soft focus:border-brand focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand/20" />
    </form>
  );
}

const STORE = "cre-os.sidebar-collapsed";

/** The whole app frame: sidebar (desktop), top bar, drawer + bottom tabs (mobile), page container. */
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
  const bottom = ["home", "outreach", "meetings", "toolkit"].map(tab).filter((s): s is NavSection => !!s);

  return (
    <div className={clsx("min-h-screen lg:grid", collapsed ? "lg:grid-cols-[72px_1fr]" : "lg:grid-cols-[248px_1fr]")}>
      <a href="#main" className="sr-only z-50 rounded-lg bg-brand px-4 py-3 font-semibold text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>

      <aside className="hidden border-r border-line bg-surface lg:block" aria-label="Sidebar">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto overflow-x-hidden px-3 py-4">
          <div className={clsx("mb-4 flex items-center gap-2", collapsed ? "flex-col" : "justify-between pl-1")}>
            <Link href="/home" className="flex min-h-11 items-center gap-2 text-base font-bold tracking-tight">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm text-white">C</span>
              {collapsed ? <span className="sr-only">CRE OS home</span> : "CRE OS"}
            </Link>
            <button type="button" onClick={toggle} aria-pressed={collapsed} aria-label={collapsed ? "Expand menu" : "Collapse menu to icons"} title={collapsed ? "Expand menu" : "Collapse menu"}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-soft hover:bg-canvas hover:text-ink">
              <SectionIcon k="collapse" className="h-5 w-5" />
            </button>
          </div>
          {collapsed ? null : <div className="mb-4">{workspace}</div>}
          <NavList groups={groups} footer={[]} badges={badges} collapsed={collapsed} />
          <div className="mt-auto space-y-2 pt-6">
            <NavList groups={[{ key: "footer", label: null, items: footer }]} footer={[]} badges={badges} collapsed={collapsed} />
            {collapsed ? null : account}
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className="flex items-center gap-2 px-3 py-2 lg:hidden">
            <button type="button" onClick={() => setDrawer(true)} aria-expanded={drawer} aria-controls="nav-drawer"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-ink hover:bg-canvas">
              <SectionIcon k="more" className="h-6 w-6" /><span className="sr-only">Open menu</span>
            </button>
            <p className="min-w-0 flex-1 truncate text-base font-semibold">{title}</p>
            <Link href="/search" className="flex h-11 w-11 items-center justify-center rounded-lg text-ink hover:bg-canvas">
              <SectionIcon k="search" className="h-5 w-5" /><span className="sr-only">Search</span>
            </Link>
            <NewMenu compact />
          </div>
          <div className="hidden items-center gap-4 px-8 py-3 lg:flex">
            <SearchBox />
            <div className="ml-auto flex items-center gap-2"><AskAiButton variant="bar" /><NewMenu /></div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 focus:outline-none sm:px-6 lg:px-8 lg:pb-12 lg:pt-8">
          <SectionTabs sections={items.concat(footer)} />
          {children}
        </main>

        <AskAiButton variant="fab" />
        <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] text-center text-[11px] backdrop-blur lg:hidden">
          {bottom.map((s) => {
            const on = active?.key === s.key;
            const b = s.badge ? badges[s.badge] : undefined;
            return (
              <Link key={s.key} href={s.href} aria-current={on ? "page" : undefined}
                className={clsx("relative flex min-h-14 flex-col items-center justify-center gap-0.5 font-medium", on ? "text-brand" : "text-ink-soft")}>
                {on ? <span className="absolute inset-x-4 top-0 h-[3px] rounded-b-full bg-brand" aria-hidden /> : null}
                <SectionIcon k={s.key} className="h-5 w-5" />{s.key === "toolkit" ? "Toolkit" : s.label}
                {b ? <span className="absolute right-[22%] top-1.5 h-2 w-2 rounded-full bg-brand" aria-hidden /> : null}
              </Link>
            );
          })}
          <button type="button" onClick={() => setDrawer(true)} className="flex min-h-14 flex-col items-center justify-center gap-0.5 font-medium text-ink-soft">
            <SectionIcon k="more" className="h-5 w-5" />More
          </button>
        </nav>
      </div>

      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu" id="nav-drawer">
          <button type="button" aria-label="Close menu" tabIndex={-1} className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} />
          <div ref={drawerRef} className="absolute inset-y-0 left-0 flex w-[min(320px,88vw)] flex-col overflow-y-auto bg-surface px-3 py-3 shadow-2xl">
            <div className="mb-3 flex items-center justify-between pl-1">
              <span className="text-base font-bold">CRE OS</span>
              <button type="button" onClick={() => setDrawer(false)} className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-canvas">
                <SectionIcon k="close" className="h-5 w-5" /><span className="sr-only">Close menu</span>
              </button>
            </div>
            <div className="mb-4">{workspace}</div>
            <NavList groups={groups} footer={footer} badges={badges} onNavigate={() => setDrawer(false)} />
            <div className="mt-auto space-y-2 pt-6">
              <NavList groups={[{ key: "footer", label: null, items: footer }]} footer={[]} badges={badges} onNavigate={() => setDrawer(false)} />
              {account}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Tabs for the current section, shown above every page (hidden when a section has one screen). */
export function SectionTabs({ sections }: { sections: NavSection[] }) {
  const path = usePathname();
  const s = sectionFor(path, sections);
  if (!s || s.tabs.length < 2) return null;
  const current = s.tabs.filter((t) => path === t.href || path.startsWith(t.href + "/")).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <div className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="inline-flex min-w-max gap-1 rounded-xl border border-line bg-surface p-1 shadow-sm">
        {s.tabs.map((t) => (
          <Link key={t.href} href={t.href} aria-current={current === t.href ? "page" : undefined}
            className={clsx("flex min-h-11 items-center whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors motion-reduce:transition-none", current === t.href ? "bg-brand text-white shadow-sm" : "text-ink-soft hover:bg-canvas hover:text-ink")}>
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
