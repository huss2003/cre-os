import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { hasRole, type AppContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { markAction } from "./actions";
import { isRecalculated, markLabel, RUN_STATUS, STEP_STATUS } from "./labels";
import { loadAttention, marksFor } from "./service";

/** Server components shared by Automation pages and other modules' pages (banner, Today card). */

export function RunStatus({ status, step = false }: { status: string; step?: boolean }) {
  const s = (step ? STEP_STATUS : RUN_STATUS)[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function When({ at, tz }: { at: string | null | undefined; tz?: string }) {
  return at ? <time dateTime={at}>{fmt(at, "dd MMM, HH:mm", tz)}</time> : <span className="text-ink-soft">—</span>;
}

/**
 * "Needs refresh" / "Outdated" banner (StaleBanner-like) for one record. Renders nothing when the record has no open
 * warning. Refresh runs the refresh workflow; Dismiss closes the warning (history kept).
 */
export async function ReassessBanner({ ctx, entityType, entityId }: { ctx: AppContext; entityType: string; entityId: string }) {
  const marks = await marksFor(ctx.db, ctx.workspaceId, entityType, entityId).catch(() => []);
  if (!marks.length) return null;
  const canAct = hasRole(ctx, "editor");
  return (
    <div className="space-y-2">
      {marks.map((m) => {
        const k = markLabel(m); const recalc = isRecalculated(m);
        const bad = m.mark === "outdated_warning";
        return (
          <div key={m.id} role="status" className={`rounded-md border px-3 py-2 text-sm ${bad ? "border-bad/30 bg-bad/5" : "border-warn/30 bg-warn/5"}`}>
            <p className="flex flex-wrap items-center gap-2"><Badge tone={k.tone}>{k.label}</Badge><span className="text-ink">{m.reason}</span></p>
            <p className="mt-1 text-xs text-ink-soft">{k.hint} Flagged {fmt(m.created_at, "dd MMM, HH:mm", ctx.timezone)}{m.run_id ? <> · <Link className="underline" href={`/automation/runs/${m.run_id}`}>what changed</Link></> : null}</p>
            {canAct ? (
              <ActionForm action={markAction} className="mt-2 flex flex-wrap gap-2">
                <input type="hidden" name="id" value={m.id} />
                {bad ? null : recalc ? (m.run_id ? <Link className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm" href={`/automation/runs/${m.run_id}`}>Review</Link> : null) : <Submit name="op" value="refresh">Refresh</Submit>}
                <Submit name="op" value="dismiss" variant="ghost" confirm="Dismiss this warning? It stays in the history.">Dismiss</Submit>
              </ActionForm>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Today: background work that needs a person. Hidden when nothing needs attention. */
export async function AutomationAttentionCard({ ctx }: { ctx: AppContext }) {
  const items = await loadAttention({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role, timezone: ctx.timezone }).catch(() => null);
  if (items === null) return <Card title="Background jobs"><p className="text-sm text-warn">Could not check background jobs right now. Open <Link className="underline" href="/automation">Automation</Link> to see their status.</p></Card>;
  if (!items.length) return null;
  return (
    <Card title="Background jobs needing attention" actions={<Link className="text-sm text-brand" href="/automation">All automation</Link>}>
      <ul className="divide-y divide-line">
        {items.slice(0, 6).map((i, n) => (
          <li key={n} className="py-2 text-sm">
            <Link href={i.href} className="font-medium text-ink hover:text-brand"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${i.tone === "bad" ? "bg-bad" : "bg-warn"}`} aria-hidden />{i.title}</Link>
            <p className="text-xs text-ink-soft">{i.detail}</p>
          </li>
        ))}
      </ul>
      {items.length > 6 ? <p className="mt-2 text-xs text-ink-soft">+{items.length - 6} more in Automation.</p> : null}
    </Card>
  );
}
