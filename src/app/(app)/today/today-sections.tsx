import Link from "next/link";
import { Badge, ButtonLink, Card, StaleBanner } from "@/components/ui";
import { SECTION_LABEL, type TodayItem, type TodaySection, type TodayView } from "@/modules/brief/today";

/** Today on the new data (spec §3.1/§8.1): recommended actions first, then one card per section. Works at 375px. */
export function TodaySections({ view }: { view: TodayView }) {
  const s = view.sections;
  return (
    <div className="space-y-4">
      {view.failed.length ? <StaleBanner>Partial view — {view.failed.join(", ")} could not be loaded. Those sections are marked below; open them directly before relying on this page.</StaleBanner> : null}

      <Card title="Recommended next actions">
        {view.recommended.length ? (
          <ol className="space-y-3 text-sm">
            {view.recommended.map((a, i) => (
              <li key={`${a.href}-${a.id}`} className="flex gap-2">
                <span className="font-semibold text-brand">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium break-words">{a.title}</div>
                  <div className="text-xs text-ink-soft break-words">{a.reason}</div>
                </div>
                <ButtonLink href={a.href} variant="secondary" className="shrink-0">{a.actionLabel}</ButtonLink>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-ink-soft">Nothing urgent across meetings, deadlines, follow-ups, signals or accounts. Use the quiet time to plan outreach to your top accounts.</p>}
      </Card>

      <SectionCard s={s.meetings} />
      <SectionCard s={s.accounts} more={s.accounts.state === "ok" && s.accounts.missing.length ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-warn">Missing information ({s.accounts.missing.length}) — unknown is not a low score</summary>
          <ItemList items={s.accounts.missing} />
        </details>
      ) : null} />
      <SectionCard s={s.signals} />
      <SectionCard s={s.followups} />
      <SectionCard s={s.approvals} />
      <SectionCard s={s.leases} />
      <SectionCard s={s.milestones} />
    </div>
  );
}

function SectionCard({ s, more }: { s: TodaySection; more?: React.ReactNode }) {
  return (
    <Card title={`${s.title}${s.state === "ok" ? ` (${s.items.length})` : ""}`}>
      {s.state === "failed" ? (
        <p className="text-sm text-bad">Couldn&apos;t load — {SECTION_LABEL[s.key]}. Open <Link href={s.empty.href} className="underline">{s.empty.label.toLowerCase()}</Link> directly; this is not &quot;nothing to do&quot;.</p>
      ) : (
        <>
          {s.note ? <p className="mb-2 text-xs text-warn">{s.note}</p> : null}
          {s.items.length ? <ItemList items={s.items} /> : (
            <div className="text-sm text-ink-soft">
              <p>{s.empty.text}</p>
              <ButtonLink href={s.empty.href} variant="ghost" className="mt-2">{s.empty.label}</ButtonLink>
            </div>
          )}
          {more}
        </>
      )}
    </Card>
  );
}

function ItemList({ items }: { items: TodayItem[] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => (
        <li key={i.id} className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="font-medium break-words">{i.title}</div>
            {i.detail ? <div className="text-xs text-ink-soft break-words">{i.detail}</div> : null}
            {i.badges.length ? <div className="mt-1 flex flex-wrap gap-1">{i.badges.map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}</div> : null}
          </div>
          <ButtonLink href={i.href} variant="secondary" className="self-start">{i.actionLabel}</ButtonLink>
        </li>
      ))}
    </ul>
  );
}
