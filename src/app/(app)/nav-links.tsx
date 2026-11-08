"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { sectionFor, type NavSection } from "@/lib/nav";

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
/** One simple icon per section so beginners can recognise places at a glance. */
export function SectionIcon({ k, className = "h-5 w-5" }: { k: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    today: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
    capture: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
    review: <><path d="M9 12l2 2 4-4" /><rect x="4" y="4" width="16" height="16" rx="4" /></>,
    records: <><path d="M4 20V8l8-4 8 4v12" /><path d="M9 20v-6h6v6" /></>,
    deals: <><path d="M4 7h16M4 12h10M4 17h6" /></>,
    signals: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
    intelligence: <><path d="M4 19l5-6 4 3 7-9" /></>,
    setup: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
  };
  return <svg viewBox="0 0 24 24" className={className} {...P} aria-hidden>{paths[k] ?? <circle cx="12" cy="12" r="3" />}</svg>;
}

/** Sidebar / menu: one entry per section, with icon and a one-line hint. */
export function NavLinks({ sections }: { sections: NavSection[] }) {
  const path = usePathname();
  const active = sectionFor(path, sections)?.key;
  return (
    <nav className="mt-6 space-y-1">
      {sections.map((s) => (
        <Link key={s.key} href={s.href}
          className={clsx("flex items-center gap-3 rounded-xl px-3 py-2.5 transition",
            active === s.key ? "bg-brand-soft text-brand" : "text-ink hover:bg-canvas")}>
          <SectionIcon k={s.key} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{s.label}</span>
            <span className={clsx("block truncate text-xs", active === s.key ? "text-brand/70" : "text-ink-soft")}>{s.hint}</span>
          </span>
        </Link>
      ))}
    </nav>
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
          <Link key={t.href} href={t.href}
            className={clsx("whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition", current === t.href ? "bg-brand text-white shadow-sm" : "text-ink-soft hover:bg-canvas hover:text-ink")}>
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Mobile bottom bar. */
export function MobileBar({ sections }: { sections: NavSection[] }) {
  const path = usePathname();
  const active = sectionFor(path, sections)?.key;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 grid border-t border-line bg-surface/95 text-center text-[11px] backdrop-blur lg:hidden" style={{ gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))` }}>
      {sections.map((s) => (
        <Link key={s.key} href={s.href} className={clsx("flex flex-col items-center gap-0.5 py-2 font-medium", active === s.key ? "text-brand" : "text-ink-soft")}>
          <SectionIcon k={s.key} className="h-5 w-5" />{s.label}
        </Link>
      ))}
    </nav>
  );
}
