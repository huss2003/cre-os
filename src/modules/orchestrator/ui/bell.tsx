import Link from "next/link";
import type { AppContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { listInbox } from "../notify/service";
import { notificationAction } from "../schedule/actions";

/** App-shell notification bell: in-app inbox (notify/service) with Done / Snooze 3h / Dismiss. Nothing is sent outside the app. */
export async function NotificationBell({ ctx }: { ctx: AppContext }) {
  const items = await listInbox(ctx.db, ctx.workspaceId, ctx.userId, { limit: 50 }).catch(() => null);
  const n = items?.length ?? 0;
  const urgent = items?.some((i) => i.severity === "urgent");
  return (
    <details className="relative">
      <summary aria-label={`Notifications${n ? ` (${n})` : ""}`} className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 text-ink-soft hover:bg-ink/[0.05] hover:text-ink lg:min-h-7">
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 21a2 2 0 0 0 4 0" /></svg>
        {n ? <span className={`rounded-full px-1.5 text-[11px] font-semibold text-white ${urgent ? "bg-bad" : "bg-brand"}`}>{n > 99 ? "99+" : n}</span> : null}
      </summary>
      <div className="fixed bottom-16 left-2 right-2 z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-lg sm:left-4 sm:right-auto sm:w-96">
        <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold">Notifications</p><Link className="text-xs text-brand" href="/automation?view=notifications">See all</Link></div>
        {items === null ? <p className="text-sm text-warn">Notifications could not be loaded.</p> : !n ? <p className="text-sm text-ink-soft">All clear.</p> : (
          <ul className="divide-y divide-line">{items.slice(0, 15).map((i) => (
            <li key={i.id} className="py-2 text-sm">
              <p className="font-medium">{i.severity === "urgent" ? <span className="mr-1 text-bad">●</span> : null}{i.href ? <Link className="hover:text-brand" href={i.href}>{i.title}</Link> : i.title}{i.count > 1 ? ` (${i.count})` : ""}</p>
              {i.body ? <p className="text-xs text-ink-soft">{i.body}</p> : null}
              <p className="text-[11px] text-ink-soft">{fmt(i.createdAt, "dd MMM, HH:mm", ctx.timezone)}</p>
              <ActionForm action={notificationAction} className="mt-1 flex flex-wrap gap-1">
                <input type="hidden" name="id" value={i.id} />
                <Submit name="action" value="complete" variant="secondary">Done</Submit>
                <Submit name="action" value="snooze" variant="ghost">Snooze 3h</Submit>
                <Submit name="action" value="dismiss" variant="ghost">Dismiss</Submit>
              </ActionForm>
            </li>))}</ul>)}
      </div>
    </details>
  );
}
