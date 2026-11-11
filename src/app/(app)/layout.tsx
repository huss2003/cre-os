import { Suspense } from "react";
import { TourProvider, TourUrlStarter } from "@/components/tour/runner";
import { requirePageContext, hasRole, type AppContext } from "@/lib/auth/context";
import { NAV_GROUPS, NAV_FOOTER, inFocusMenu, type NavSection } from "@/lib/nav";
import { atLocal, localDate } from "@/lib/util/time";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { AppShell, type Badges } from "./nav-links";

/** Cheap head-only counts for menu badges. Any failure just hides that badge. */
async function loadBadges(ctx: AppContext): Promise<Badges> {
  if (!ctx.workspaceId) return {};
  const ws = ctx.workspaceId;
  const day = localDate(new Date(), ctx.timezone);
  const start = atLocal(day, "00:00", ctx.timezone);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    try { const r = await q; return r.error ? undefined : r.count ?? undefined; } catch { return undefined; }
  };
  const [review, outreach, meetings] = await Promise.all([
    count(ctx.db.from("change_proposal").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("state", "proposed").is("archived_at", null)),
    count(ctx.db.from("outreach_item").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", ["draft", "pending_approval"]).is("archived_at", null)),
    count(ctx.db.from("meeting_visit").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null)
      .gte("start_at", start.toISOString()).lt("start_at", end.toISOString())),
  ]);
  return { review, outreach, meetings };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageContext();
  const allowed = (r?: NavSection["minRole"], platformOnly?: boolean) => (platformOnly ? ctx.isPlatformAdmin : !r || hasRole(ctx, r));
  const fit = (s: NavSection, focus: boolean): NavSection | null => {
    if (!allowed(s.minRole, s.platformOnly)) return null;
    const tabs = s.tabs.filter((t) => allowed(t.minRole, t.platformOnly) && (!focus || inFocusMenu(t.href)));
    if (!tabs.length) return null;
    return { ...s, tabs, href: tabs.some((t) => t.href === s.href) ? s.href : tabs[0].href };
  };
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.map((s) => fit(s, true)).filter((s): s is NavSection => !!s) }))
    .filter((g) => g.items.length > 0);
  const footer = NAV_FOOTER.map((s) => fit(s, false)).filter((s): s is NavSection => !!s);
  const badges = await loadBadges(ctx);

  const initial = (ctx.email ?? "?").slice(0, 1).toUpperCase();
  const account = (
    <div className="flex items-center gap-2 rounded-md px-2 py-1">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white" aria-hidden>{initial}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-ink">{ctx.email}</div>
        <div className="text-[11px] capitalize text-ink-soft">{ctx.role}{ctx.isPlatformAdmin ? " · platform admin" : ""}</div>
      </div>
      <form action="/auth/signout" method="post">
        <button className="min-h-11 rounded-md px-1.5 text-xs text-ink-soft hover:bg-ink/[0.05] hover:text-ink lg:min-h-7">Sign out</button>
      </form>
    </div>
  );

  return (
    <TourProvider>
      <Suspense fallback={null}><TourUrlStarter /></Suspense>
      <AppShell groups={groups} footer={footer} badges={badges} account={account}
        workspace={<WorkspaceSwitcher current={ctx.workspaceId} workspaces={ctx.workspaces} />}>
        {children}
      </AppShell>
    </TourProvider>
  );
}
