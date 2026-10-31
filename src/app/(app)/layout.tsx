import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { NAV } from "@/lib/nav";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageContext();
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => (i.platformOnly ? ctx.isPlatformAdmin : !i.minRole || hasRole(ctx, i.minRole))) }));
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-line bg-ink text-white lg:block">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto p-4">
          <Link href="/today" className="mb-4 text-lg font-semibold tracking-tight">CRE OS</Link>
          <WorkspaceSwitcher current={ctx.workspaceId} workspaces={ctx.workspaces} />
          <NavLinks groups={groups} />
          <div className="mt-auto border-t border-white/10 pt-3 text-xs text-white/60">
            <div className="truncate">{ctx.email}</div>
            <div className="capitalize">{ctx.role}{ctx.isPlatformAdmin ? " · platform admin" : ""}</div>
            <form action="/auth/signout" method="post"><button className="mt-2 text-white/80 hover:text-white">Sign out</button></form>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-ink px-4 py-3 text-white lg:hidden">
          <Link href="/today" className="font-semibold">CRE OS</Link>
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-lg border border-white/20 px-3 py-1.5 text-sm">Menu</summary>
            <div className="absolute right-0 mt-2 w-64 rounded-xl bg-ink p-3 shadow-xl">
              <WorkspaceSwitcher current={ctx.workspaceId} workspaces={ctx.workspaces} />
              <NavLinks groups={groups} />
              <form action="/auth/signout" method="post"><button className="mt-2 text-sm text-white/80">Sign out</button></form>
            </div>
          </details>
        </header>
        <main className="mx-auto w-full max-w-6xl p-4 pb-24 sm:p-6">{children}</main>
        <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-surface text-center text-xs lg:hidden">
          {[["/today","Today"],["/capture","Capture"],["/approvals","Approvals"],["/search","Search"]].map(([h,l]) => (
            <Link key={h} href={h} className="py-3 font-medium text-ink">{l}</Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
