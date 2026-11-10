import Link from "next/link";
import { Suspense } from "react";
import { TourProvider, TourUrlStarter } from "@/components/tour/runner";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { NAV, MOBILE_BAR, HOME, isHiddenPath, inFocusMenu, type NavSection } from "@/lib/nav";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { NavLinks, SectionTabs, MobileBar } from "./nav-links";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageContext();
  const allowed = (r?: NavSection["minRole"], platformOnly?: boolean) => (platformOnly ? ctx.isPlatformAdmin : !r || hasRole(ctx, r));
  const sections = NAV.filter((s) => allowed(s.minRole))
    .map((s) => ({ ...s, tabs: s.tabs.filter((t) => allowed(t.minRole, t.platformOnly) && inFocusMenu(t.href)) }))
    .filter((s) => s.tabs.length > 0)
    .map((s) => ({ ...s, href: s.tabs.some((t) => t.href === s.href) ? s.href : s.tabs[0].href }));
  const mobile = sections.filter((s) => (MOBILE_BAR as readonly string[]).includes(s.key));
  return (
    <TourProvider>
    <Suspense fallback={null}><TourUrlStarter /></Suspense>
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-line bg-surface lg:block">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto p-4">
          <Link href={HOME} className="mb-5 flex items-center gap-2 px-1 text-lg font-bold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm text-white">C</span>CRE OS
          </Link>
          <WorkspaceSwitcher current={ctx.workspaceId} workspaces={ctx.workspaces} />
          <NavLinks sections={sections} />
          <div className="mt-auto rounded-xl bg-canvas p-3 text-xs text-ink-soft">
            <div className="truncate font-medium text-ink">{ctx.email}</div>
            <div className="capitalize">{ctx.role}{ctx.isPlatformAdmin ? " · platform admin" : ""}</div>
            <form action="/auth/signout" method="post"><button className="mt-2 font-semibold text-brand hover:underline">Sign out</button></form>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
          <Link href={HOME} className="flex items-center gap-2 font-bold"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-xs text-white">C</span>CRE OS</Link>
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-xl border border-line px-3 py-1.5 text-sm font-medium">Menu</summary>
            <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-line bg-surface p-3 shadow-xl">
              <WorkspaceSwitcher current={ctx.workspaceId} workspaces={ctx.workspaces} />
              <NavLinks sections={sections} />
              <form action="/auth/signout" method="post"><button className="mt-2 px-3 text-sm font-semibold text-brand">Sign out</button></form>
            </div>
          </details>
        </header>
        <main className="mx-auto w-full max-w-6xl p-4 pb-24 sm:p-8"><SectionTabs sections={sections} />{children}</main>
        <MobileBar sections={mobile} />
      </div>
    </div>
    </TourProvider>
  );
}
