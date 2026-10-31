import Link from "next/link";
import { Badge, Button, Card } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import type { AgendaItem, DayAgenda } from "@/modules/brief/agenda";
import type { RelSuggestion } from "@/modules/brief/caretaker";
import { addSuggestionTaskAction, replanAction } from "./actions-plan";

const KIND_LABEL: Record<AgendaItem["kind"], [string, "ok" | "warn" | "neutral" | "bad" | "brand" | "accent"]> = {
  meeting: ["Meeting", "brand"], prep: ["Prep", "neutral"], travel: ["Travel", "neutral"], promise: ["Promise", "bad"], reply: ["Reply", "accent"],
  call: ["Call", "ok"], follow_up: ["Follow-up", "ok"], approval: ["Approvals", "warn"], lease_window: ["Lease window", "bad"], task: ["Task", "neutral"],
  research: ["Research", "neutral"], relationship: ["Relationship", "accent"],
};

/** Workflow 07: one feasible day order with a rule-based reason per item, blocked items and capacity conflicts. */
export function DayPlanCard({ agenda, generatedAt, reason, tz, canEdit }: { agenda: DayAgenda | null; generatedAt: string | null; reason: string | null; tz: string; canEdit: boolean }) {
  return (
    <Card
      title="Day plan"
      actions={canEdit ? <form action={replanAction}><Button type="submit" variant="ghost">Re-plan now</Button></form> : null}
    >
      {!agenda ? (
        <p className="text-sm text-ink-soft">No plan yet — it is built at 07:20 and re-planned automatically when a reply arrives, a task changes, a deadline enters 48 h or a change is approved.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-ink-soft">
            {agenda.window.from}–{agenda.window.end} · {agenda.capacity.plannedMinutes} of {agenda.capacity.freeMinutes} free min planned · {agenda.capacity.fixedMinutes} min in meetings/buffers
            {generatedAt ? ` · planned ${fmt(generatedAt, "HH:mm", tz)}` : " · live preview"}{reason && reason !== "scheduled" ? ` (${reason})` : ""} · rule-based, no AI
          </p>
          {agenda.conflicts.length ? (
            <ul className="space-y-1">
              {agenda.conflicts.map((c, i) => <li key={i} className="rounded-md border border-bad/30 bg-bad/5 px-2 py-1 text-xs text-bad">Conflict: {c.message}</li>)}
            </ul>
          ) : null}
          {agenda.timeline.length ? (
            <ol className="divide-y divide-line">
              {agenda.timeline.map((t) => {
                const [label, tone] = KIND_LABEL[t.kind];
                return (
                  <li key={t.ref} className={`flex gap-3 py-2 ${t.fixed && t.kind !== "meeting" ? "text-ink-soft" : ""}`}>
                    <span className="w-24 shrink-0 tabular-nums text-xs">{t.start}–{t.end}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {t.rank ? <span className="font-semibold text-brand">{t.rank}.</span> : null}
                        <Link href={t.href} className="font-medium hover:underline break-words">{t.title}</Link>
                        <Badge tone={tone}>{label}</Badge>
                      </div>
                      <div className="text-xs text-ink-soft break-words">{t.why}</div>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-ink-soft">Nothing to schedule today.</p>}
          {agenda.blocked.length ? (
            <details open className="rounded-lg border border-line p-2">
              <summary className="cursor-pointer font-medium">Blocked ({agenda.blocked.length}) — waiting on something else</summary>
              <ul className="mt-1 space-y-1 text-xs">
                {agenda.blocked.map((b) => <li key={b.ref}><Link href={b.href} className="font-medium hover:underline">{b.title}</Link> — waits on {b.waitsOn}</li>)}
              </ul>
            </details>
          ) : null}
          {agenda.unscheduled.length ? (
            <details className="rounded-lg border border-line p-2">
              <summary className="cursor-pointer font-medium">Did not fit today ({agenda.unscheduled.length})</summary>
              <ul className="mt-1 space-y-1 text-xs">
                {agenda.unscheduled.slice(0, 20).map((u) => <li key={u.ref}><Link href={u.href} className="hover:underline">{u.title}</Link> · {u.minutes} min · <span className="text-ink-soft">{u.why}</span></li>)}
              </ul>
            </details>
          ) : null}
          <details className="text-xs text-ink-soft"><summary className="cursor-pointer">How items are ordered</summary>
            <ul className="ml-4 mt-1 list-disc">{agenda.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </details>
        </div>
      )}
    </Card>
  );
}

const REL_LABEL: Record<RelSuggestion["kind"], [string, "ok" | "warn" | "neutral" | "bad" | "accent"]> = {
  promise_overdue: ["Overdue promise", "bad"], promise_due: ["Promise due", "warn"], visit_concern: ["Post-visit", "warn"], renewal: ["Renewal", "accent"], referral: ["Referral", "ok"],
};

/** Workflow 18: human follow-up suggestions (never sent automatically); opted-out contacts are withheld. */
export function RelationshipCard({ items, withheld, canEdit }: { items: RelSuggestion[]; withheld: number; canEdit: boolean }) {
  return (
    <Card title={`Relationship follow-ups (${items.length})`} actions={<Link href="/tasks?source=workflow" className="text-sm text-brand">Tasks</Link>}>
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.slice(0, 12).map((s) => {
            const [label, tone] = REL_LABEL[s.kind];
            return (
              <li key={s.key} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={tone}>{label}</Badge>
                  <Link href={s.href} className="font-medium hover:underline break-words">{s.title}</Link>
                  {s.due ? <span className="text-xs text-ink-soft">by {s.due}</span> : null}
                </div>
                <div className="text-xs text-ink-soft break-words">{s.why}</div>
                {canEdit && !s.createTask ? (
                  <form action={addSuggestionTaskAction} className="mt-1">
                    <input type="hidden" name="key" value={s.key} /><input type="hidden" name="title" value={s.title} /><input type="hidden" name="why" value={s.why} />
                    <input type="hidden" name="due" value={s.due ?? ""} /><input type="hidden" name="link_type" value={s.link.type} /><input type="hidden" name="link_id" value={s.link.id} />
                    <Button type="submit" variant="ghost">Add to tasks</Button>
                  </form>
                ) : s.createTask ? <p className="mt-1 text-xs text-ink-soft">Follow-up task raised automatically; mark it done only with evidence. The promise itself is never auto-closed.</p> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="text-sm text-ink-soft">No follow-ups due. Promises captured from calls/emails, visit feedback, renewal windows and won deals appear here as suggestions — nothing is sent for you.</p>}
      {withheld ? <p className="mt-2 text-xs text-ink-soft">{withheld} suggestion{withheld === 1 ? "" : "s"} withheld: contact opted out, suppressed or company contact restriction.</p> : null}
    </Card>
  );
}
