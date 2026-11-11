import Link from "next/link";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { getBriefSetting, latestBrief, type BriefCtx } from "@/modules/assistant/briefs/morning";
import { runBriefNowAction, saveBriefSettingAction } from "@/modules/assistant/briefs/actions";
import { localDate } from "@/lib/util/time";

/** Top-of-/home card: today's morning brief link (or how to get one) + opt-in toggle and time picker. */
export async function MorningBriefCard({ c, editor }: { c: BriefCtx; editor: boolean }) {
  const [setting, last] = await Promise.all([getBriefSetting(c).catch(() => null), latestBrief(c).catch(() => null)]);
  const today = localDate(new Date(), c.timezone || "Asia/Kolkata");
  const fresh = last && last.brief_date === today ? last : null;
  return (
    <section aria-labelledby="mb-h" className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="mb-h" className="text-lg font-semibold">Morning brief</h2>
          {fresh ? (
            <p className="mt-1 text-sm">
              {fresh.status === "partial" ? <span className="font-medium text-warn">Partial — not checked: {fresh.failed_sources.join(", ")}. </span> : null}
              {fresh.counts.meetings ?? 0} meetings · {fresh.counts.followups ?? 0} follow-ups · {fresh.counts.signals ?? 0} signals · {fresh.counts.leases ?? 0} lease windows · {fresh.counts.approvals ?? 0} approvals.{" "}
              {fresh.conversation_id ? <Link href={`/assistant/${fresh.conversation_id}`} className="font-semibold text-brand underline underline-offset-4">Open today&apos;s brief →</Link> : null}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              {setting?.enabled ? `Arrives weekdays at ${setting.time_local}. ` : "Get meetings, follow-ups, new signals, lease windows and approvals in one place each weekday morning. "}
              It appears here and as a pinned assistant conversation — nothing is emailed.
            </p>
          )}
        </div>
        {editor ? <ActionForm action={runBriefNowAction}><Submit variant="secondary">{fresh ? "Open" : "Build today’s brief now"}</Submit></ActionForm> : null}
      </div>
      {editor ? (
        <ActionForm action={saveBriefSettingAction} className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4 text-sm">
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={!!setting?.enabled} className="h-5 w-5" /> Send me a brief every weekday at</label>
          <input type="time" name="time" defaultValue={setting?.time_local ?? "08:00"} className="min-h-11 rounded-lg border border-line bg-surface px-2" aria-label="Brief time" />
          <span className="text-ink-soft">IST</span>
          <Submit variant="ghost">Save</Submit>
        </ActionForm>
      ) : null}
    </section>
  );
}
