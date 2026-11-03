"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { sectionFor, type NavSection } from "@/lib/nav";

/** Sidebar / menu: one entry per section, with a one-line hint. */
export function NavLinks({ sections }: { sections: NavSection[] }) {
  const path = usePathname();
  const active = sectionFor(path, sections)?.key;
  return (
    <nav className="mt-4 space-y-1">
      {sections.map((s) => (
        <Link key={s.key} href={s.href} prefetch
          className={clsx("block rounded-md px-2 py-2", active === s.key ? "bg-white/15 text-white" : "text-white/80 hover:bg-white/10")}>
          <span className="block text-sm font-medium">{s.label}</span>
          <span className="block text-[11px] text-white/50">{s.hint}</span>
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
    <div className="-mx-4 mb-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <div className="flex min-w-max gap-1">
        {s.tabs.map((t) => (
          <Link key={t.href} href={t.href} prefetch
            className={clsx("whitespace-nowrap border-b-2 px-3 py-2 text-sm", current === t.href ? "border-brand font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink")}>
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
    <nav className="fixed inset-x-0 bottom-0 z-20 grid border-t border-line bg-surface text-center text-xs lg:hidden" style={{ gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))` }}>
      {sections.map((s) => (
        <Link key={s.key} href={s.href} prefetch className={clsx("py-3 font-medium", active === s.key ? "text-brand" : "text-ink")}>{s.label}</Link>
      ))}
    </nav>
  );
}
