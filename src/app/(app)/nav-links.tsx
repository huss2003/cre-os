"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

export function NavLinks({ groups }: { groups: { group: string; items: { href: string; label: string }[] }[] }) {
  const path = usePathname();
  return (
    <nav className="mt-4 space-y-4">
      {groups.map((g) => (
        <div key={g.group}>
          <div className="mb-1 px-2 text-[11px] uppercase tracking-wider text-white/50">{g.group}</div>
          {g.items.map((i) => (
            <Link key={i.href} href={i.href}
              className={clsx("block rounded-md px-2 py-1.5 text-sm", path.startsWith(i.href) ? "bg-white/15 text-white" : "text-white/80 hover:bg-white/10")}>
              {i.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
