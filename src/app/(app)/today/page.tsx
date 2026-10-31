import { Suspense } from "react";
import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { Badge, Button, ButtonLink, Card, EmptyState, Input, PageHeader, Select, StaleBanner, Stat, inr } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import { buildBrief, type BriefContent, type TargetView } from "@/modules/brief/builder";
import { gatherBriefInputs, latestBrief, type StoredBrief } from "@/modules/brief/brief-service";
import { loadCtxFor, todayFor } from "@/modules/brief/context";
import { loadSettings } from "@/modules/brief/db";
import { meetingVersionKey } from "@/modules/brief/scheduler";
import { TIER_LABEL, type Tier } from "@/modules/brief/scoring";
import type { SynthesisOutcome } from "@/modules/brief/synthesis";
import { listTasks } from "@/modules/brief/tasks-service";
import { addTargetTaskAction, completeTaskFromToday, generateBriefAction, snoozeTargetAction, snoozeTaskFromToday } from "./actions";
import { DayPlanCard, RelationshipCard } from "./day-plan";
import { computeDailyPlan, latestPlan } from "@/modules/brief/plan";
import { computeRelationshipSuggestions } from "@/modules/brief/caretaker-data";
import { loadRadar } from "@/modules/brief/radar-data";


const ALERT_LABEL: Record<string, string> = { urgent_alert: "Urgent", brief_alert: "Brief alert", promise_overdue: "Overdue promise", lease_event_alert: "Lease event", deadline_48h: "Due ≤ 48 h" };

const tierTone: Record<string, "ok" | "warn" | "neutral" | "bad"> = { act_this_week: "ok", validate_nurture: "warn", enrich_or_park: "neutral", suppressed: "bad" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<div className="p-6 text-sm text-ink-soft">Loading…</div>}><Body searchParams={searchParams} /></Suspense>;
}

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const date = todayFor(ctx);
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const lc = loadCtxFor(ctx);
  const canEdit = hasRole(ctx, "editor");

  const stored = await latestBrief(ctx.db, ctx.workspaceId, ctx.userId, date, "daily");
  // No stored brief yet: show a live deterministic preview (not saved, no AI) so the page is useful immediately.
  const content: BriefContent = stored?.content ?? buildBrief(await gatherBriefInputs(lc, settings, date, new Date(), { persistPlan: false }));
  const synthesis = (stored?.content as { synthesis?: SynthesisOutcome } | undefined)?.synthesis ?? null;

  const [overdueLive, preMeeting, urgent, storedPlan, radar] = await Promise.all([
    listTasks(ctx.db, ctx.workspaceId, ctx.userId, { state: "overdue", scope: "mine" }, { staleAfterDays: settings.staleTaskAfterDays, limit: 50 }),
    loadPreMeetingBriefs(ctx, date),
    loadUrgent(ctx),
    latestPlan(lc, date),
    loadRadar(ctx.db, ctx.workspaceId, date, settings),
  ]);
  // latest (event-driven) plan; none yet → live deterministic preview, not stored
  const plan = storedPlan?.agenda ? storedPlan : { ...(await computeDailyPlan(lc, settings, date)), generatedAt: null as string | null };
  const { data: planMeta } = storedPlan?.id ? await ctx.db.from("daily_plan").select("trigger_reason").eq("workspace_id", ctx.workspaceId).eq("id", storedPlan.id).maybeSingle() : { data: null };
  const rel = await computeRelationshipSuggestions(ctx.db, ctx.workspaceId, date, radar.items, { userId: ctx.userId });

  const nothing = !content.targets.length && !content.actions.length && !content.meetings.clusters.length && !content.deadlines.items.length && !overdueLive.length && content.pipeline.open === 0;
  const meetingCount = content.meetings.clusters.reduce((n, c) => n + c.meetings.length, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Today"
        subtitle={<>
          {fmt(new Date(), "EEE dd MMM yyyy", tz)} ·{" "}
          {stored ? <>brief v{stored.version} generated {fmt(stored.generated_at, "HH:mm", tz)}{stored.delivered_at ? ` · delivered ${fmt(stored.delivered_at, "HH:mm", tz)}` : " · not yet delivered"}</> : <>live preview — the brief is prepared automatically before {settings.briefTime}</>}
        </>}
        actions={canEdit ? <form action={generateBriefAction}><Button type="submit" variant="secondary">{stored ? "Refresh brief" : "Generate brief now"}</Button></form> : null}
      />

      {typeof sp.ok === "string" ? <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">{sp.ok}</div> : null}
      {typeof sp.error === "string" ? <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{sp.error}</div> : null}

      {content.sources.filter((s) => s.state === "failed" || s.state === "stale").map((s) => <StaleBanner key={s.key}>{s.note}</StaleBanner>)}
      {stored?.synthesis_status === "fallback_no_ai" ? <StaleBanner>{synthesis?.notice ?? "AI synthesis missing — deterministic brief shown in full."}</StaleBanner> : null}
      {content.modeNote ? <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">{content.modeNote}</div> : null}

      {urgent.data?.length ? (
        <Card title="Urgent (private alerts)">
          <ul className="space-y-2 text-sm">
            {urgent.data.map((u: any) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={u.kind === "urgent_alert" || u.kind === "promise_overdue" ? "bad" : "warn"}>{ALERT_LABEL[u.kind] ?? "Alert"}</Badge>
                {u.payload?.href ? <Link href={u.payload.href} className="hover:underline">{u.payload?.title ?? u.payload?.reason ?? u.kind}</Link> : <span>{u.payload?.title ?? u.payload?.reason ?? u.kind}</span>}
                <span className="text-xs text-ink-soft">{fmt(u.created_at, "dd MMM HH:mm", tz)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {synthesis?.status === "ok" && synthesis.synthesis ? (
        <Card title={<>Summary <Badge tone="accent">{synthesis.mocked ? "AI (mock)" : "AI"}</Badge></>}>
          <p className="text-sm">{synthesis.synthesis.headline}</p>
        </Card>
      ) : null}

      {nothing ? (
        <EmptyState title="Nothing to plan yet" action={canEdit ? <ButtonLink href="/imports">Import data</ButtonLink> : undefined}>
          The brief fills itself from your lease schedule, companies, tasks and calendar. Import a lease or company list, add a
          requirement, or capture a call — scores and the 08:00 brief are recalculated every morning at 07:00.
        </EmptyState>
      ) : null}

      <Card title="Top 3 actions">
        {content.actions.length ? (
          <ol className="space-y-2 text-sm">
            {content.actions.map((a, i) => (
              <li key={a.ref} className="flex gap-2">
                <span className="font-semibold text-brand">{i + 1}.</span>
                <div className="min-w-0"><Link href={a.href} className="font-medium hover:underline">{a.title}</Link><div className="text-xs text-ink-soft">{a.why}</div></div>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-ink-soft">No high-impact actions computed. Add leases, requirements or tasks to give the adviser something to rank.</p>}
      </Card>

      <DayPlanCard agenda={plan.agenda} generatedAt={plan.generatedAt} reason={(planMeta as { trigger_reason?: string } | null)?.trigger_reason ?? null} tz={tz} canEdit={canEdit} />

      <RelationshipCard items={rel.suggestions} withheld={rel.withheld.length} canEdit={canEdit} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="New companies approached" value={`${content.approaches.thisMonth} / ${content.approaches.minimum}`} hint={`Pace target ${content.approaches.pace}; ${content.approaches.perDayMinimum}/workday needed over ${content.approaches.workdaysLeft} workdays`} />
        <Stat label="Pending approvals" value={<Link href="/approvals" className="hover:underline">{content.approvals.changes + content.approvals.drafts}</Link>} hint={`${content.approvals.changes} changes · ${content.approvals.drafts} drafts`} />
        <Stat label="Pipeline (credited)" value={inr(content.pipeline.expectedFee, { compact: true })} hint={`${content.pipeline.open} open · ${content.pipeline.closingThisQuarter} closing this quarter · ${content.pipeline.missingNextAction} without next action`} />
      </div>

      <Card title={`Targets (${content.targets.length})`} actions={content.capacity ? <span className="text-xs text-ink-soft">{content.capacity.callMinutesAvailable} call min · max {content.capacity.maxTargets}</span> : null}>
        {content.targets.length ? (
          <ul className="space-y-3">{content.targets.map((t) => <TargetCard key={t.orgId} t={t} canEdit={canEdit} />)}</ul>
        ) : (
          <p className="text-sm text-ink-soft">
            {content.mode === "light" ? "Light review day — no client-contact targets." : "No scored targets yet. Scores are computed at 07:00 from leases, requirements, signals and relationships; the plan is built at 07:20."}
          </p>
        )}
        {content.capacity?.reasons.length ? <p className="mt-3 text-xs text-ink-soft">Capacity: {content.capacity.reasons.join("; ")}</p> : null}
        {content.displaced.length ? (
          <details className="mt-3 text-sm"><summary className="cursor-pointer text-ink-soft">Below today&apos;s cut line ({content.displaced.length})</summary>
            <ul className="mt-2 space-y-1">{content.displaced.map((d) => <li key={d.orgId}>{d.name} — {d.total} pts, {d.ratio}/min · <span className="text-ink-soft">{d.reason}</span></li>)}</ul>
          </details>
        ) : null}
      </Card>

      <Card title={`Overdue (${overdueLive.length})`} actions={<Link href="/tasks?state=overdue" className="text-sm text-brand">All tasks</Link>}>
        {overdueLive.length ? (
          <ul className="divide-y divide-line">
            {overdueLive.slice(0, 8).map((t) => (
              <li key={t.id} className="py-2 text-sm">
                <div className="font-medium">{t.title}</div>
                <div className="text-xs text-ink-soft">Due {fmt(t.dueAt, "dd MMM HH:mm", tz)} · priority {t.priority}</div>
                {canEdit ? (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <form action={completeTaskFromToday} className="flex flex-1 gap-2">
                      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="version" value={t.rowVersion} />
                      <Input name="evidence" placeholder="What was done (evidence)" required minLength={3} />
                      <Button type="submit">Done</Button>
                    </form>
                    <form action={snoozeTaskFromToday} className="flex gap-2">
                      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="version" value={t.rowVersion} />
                      <Select name="days" defaultValue="1" className="w-24"><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option></Select>
                      <Button type="submit" variant="secondary">Snooze</Button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-soft">Nothing overdue.{content.overdue.staleCount ? ` ${content.overdue.staleCount} stale task(s) are listed under Tasks → Stale.` : ""}</p>}
      </Card>

      <Card title={`Meetings (${meetingCount})`} actions={<Link href="/calendar" className="text-sm text-brand">Calendar</Link>}>
        {content.meetings.note ? <p className={`mb-2 text-xs ${content.meetings.state === "ok" ? "text-ink-soft" : "text-warn"}`}>{content.meetings.note}</p> : null}
        {content.meetings.conflicts.map((c) => <p key={c} className="mb-2 text-xs text-bad">Conflict: {c}</p>)}
        {content.meetings.clusters.length ? content.meetings.clusters.map((cl) => (
          <div key={cl.label} className="mb-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{cl.label}</div>
            <ul className="mt-1 space-y-1 text-sm">
              {cl.meetings.map((m) => {
                const pm = preMeeting.get(m.id);
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{fmt(m.startAt, "HH:mm", tz)}–{fmt(m.endAt, "HH:mm", tz)}</span>
                    <span>{m.title ?? "Meeting"}</span>
                    <Badge>{m.kind.replace("_", " ")}</Badge>
                    {pm ? <Link className="text-xs text-brand" href={`/today?meeting=${m.id}#pre-meeting`}>Pre-meeting brief</Link> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        )) : <p className="text-sm text-ink-soft">{content.meetings.state === "ok" ? "No meetings today." : "No meetings recorded — calendar not verified."}</p>}
      </Card>

      {typeof sp.meeting === "string" && preMeeting.get(sp.meeting) ? <PreMeetingCard b={preMeeting.get(sp.meeting)!} tz={tz} /> : null}

      <Card title="Expiry, notice, escalation & options (next 90 days)" actions={<Link href="/leases" className="text-sm text-brand">Lease radar</Link>}>
        {content.deadlines.items.length ? (
          <ul className="space-y-2 text-sm">
            {content.deadlines.items.slice(0, 10).map((d) => (
              <li key={`${d.leaseId}-${d.kind}-${d.date}`} className="flex flex-wrap items-center gap-2">
                <Badge tone={d.kind === "notice" ? "bad" : d.kind === "escalation" || d.kind === "option" ? "accent" : "warn"}>{d.kind === "escalation" ? "rent escalation" : d.kind}</Badge>
                <span className="tabular-nums">{d.date}</span><span className="text-ink-soft">({d.days} d)</span>
                <span className="font-medium">{d.tenant}</span>{d.asset ? <span className="text-ink-soft">@ {d.asset}</span> : null}
                <Badge tone={d.verified ? "ok" : "neutral"}>{d.basisLabel}</Badge>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-soft">No expiry, break or notice dates in the next 90 days.</p>}
        {content.deadlines.expiredNeedingConfirmation ? <p className="mt-2 text-xs text-warn">{content.deadlines.expiredNeedingConfirmation} expired lease(s) need status confirmation (not hot leads).</p> : null}
      </Card>

      <Card title="Hot replies">
        {content.replies.note ? <p className={`mb-2 text-sm ${content.replies.state === "ok" ? "text-ink-soft" : "text-warn"}`}>{content.replies.note}</p> : null}
        {content.replies.items.length ? (
          <ul className="space-y-2 text-sm">
            {content.replies.items.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.orgId ? <Link href={`/companies/${r.orgId}`} className="hover:underline">{r.orgName}</Link> : r.orgName ?? "Unmatched sender"}</span>{" "}
                — {r.subject ?? "(no subject)"} <span className="text-xs text-ink-soft">{fmt(r.occurredAt, "dd MMM HH:mm", tz)}</span>
              </li>
            ))}
          </ul>
        ) : content.replies.state === "ok" ? <p className="text-sm text-ink-soft">No new meaningful replies since the last brief.</p> : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Intelligence">
          {content.intel ? (
            <div className="text-sm">
              <div className="font-medium">{content.intel.orgName} — {content.intel.claimType.replace(/_/g, " ")}</div>
              {content.intel.excerpt ? <p className="mt-1 text-ink-soft">“{content.intel.excerpt.slice(0, 240)}”</p> : null}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="warn">{content.intel.evidenceTier?.replace(/_/g, " ") ?? "unrated"}</Badge>
                <span>{content.intel.date ?? "undated"}</span>
                <a href={content.intel.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-brand hover:underline">Source</a>
              </div>
            </div>
          ) : <p className="text-sm text-ink-soft">No sourced signal in the last 3 weeks. Research results appear here with their source link.</p>}
        </Card>
        <Card title="Sources">
          <ul className="space-y-1 text-sm">
            {content.sources.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center gap-2">
                <Badge tone={s.state === "ok" ? "ok" : s.state === "not_connected" ? "neutral" : "warn"}>{s.state.replace("_", " ")}</Badge>
                <span>{s.label}</span>
                <span className="text-xs text-ink-soft">{s.lastSuccessAt ? `last success ${fmt(s.lastSuccessAt, "dd MMM HH:mm", tz)}` : s.state === "not_connected" ? "" : "never synced"}</span>
              </li>
            ))}
          </ul>
          {content.sources.some((s) => s.state === "not_connected") ? <p className="mt-2 text-xs text-ink-soft">Connect mail/calendar under <Link href="/settings/connections" className="text-brand">Settings → Connections</Link>.</p> : null}
        </Card>
      </div>

      <details className="text-sm"><summary className="cursor-pointer text-ink-soft">Plain-text brief (works without AI)</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 text-xs">{content.fallbackText}</pre>
      </details>
    </div>
  );
}

function TargetCard({ t, canEdit }: { t: TargetView; canEdit: boolean }) {
  return (
    <li id={`target-${t.orgId}`} className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t.rank}. {t.name}</span>
        <Badge tone={tierTone[t.tier] ?? "neutral"}>{TIER_LABEL[t.tier as Tier] ?? t.tier}</Badge>
        <Badge tone="brand">{t.total}/100</Badge>
        {t.slot === "exploration" ? <Badge tone="accent">exploration</Badge> : t.slot === "deadline" ? <Badge tone="bad">deadline</Badge> : null}
        <Badge>{t.warmth}</Badge>
      </div>
      <p className="mt-1 text-xs text-ink-soft">{t.why}</p>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-brand">Score breakdown · evidence: {t.evidenceConfidence.replace(/_/g, " ")}</summary>
        <ul className="mt-2 space-y-1">
          {t.components.map((c) => (
            <li key={c.key}>
              <span className="font-medium">{c.label}</span> {c.points}/{c.max} <span className="text-ink-soft">· {c.band}</span>
              {c.evidence.length ? <ul className="ml-4 list-disc text-xs text-ink-soft">{c.evidence.map((e, i) => <li key={i} className="break-words">{e}</li>)}</ul> : null}
            </li>
          ))}
        </ul>
        {t.overrides.length ? <p className="mt-1 text-xs">Overrides: {t.overrides.join(", ")}</p> : null}
      </details>
      <div className="mt-2 flex flex-wrap gap-2">
        <ButtonLink href={`/companies/${t.orgId}`} variant="ghost">Open</ButtonLink>
        {canEdit ? (
          <form action={addTargetTaskAction}>
            <input type="hidden" name="org_id" value={t.orgId} /><input type="hidden" name="name" value={t.name} /><input type="hidden" name="why" value={t.why} />
            <Button type="submit" variant="secondary">Add to tasks</Button>
          </form>
        ) : null}
        <form action={snoozeTargetAction}>
          <input type="hidden" name="org_id" value={t.orgId} /><input type="hidden" name="days" value="7" />
          <Button type="submit" variant="ghost">Snooze 7 days</Button>
        </form>
      </div>
    </li>
  );
}

/** Private urgent/brief alerts for this user from the last 36 hours (outbox is user-scoped by RLS). */
async function loadUrgent(ctx: { db: any; workspaceId: string; userId: string }) {
  const since = new Date(Date.now() - 36 * 3_600_000).toISOString();
  return ctx.db.from("outbox").select("id, kind, payload, created_at").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId)
    .in("kind", ["urgent_alert", "brief_alert", "promise_overdue", "lease_event_alert", "deadline_48h"]).gte("created_at", since).order("created_at", { ascending: false }).limit(10);
}

type PreMeetingBrief = StoredBrief & { content: any };

/** Today's pre-meeting briefs for meetings whose CURRENT version matches (rescheduled/cancelled → hidden). */
async function loadPreMeetingBriefs(ctx: { db: any; workspaceId: string; userId: string }, date: string): Promise<Map<string, PreMeetingBrief>> {
  const { data } = await ctx.db.from("brief").select("id, user_id, brief_date, kind, subject_key, version, generated_at, content, synthesis_status, source_health, delivered_at")
    .eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).eq("kind", "pre_meeting").eq("brief_date", date).is("archived_at", null).order("version", { ascending: false }).limit(50);
  const out = new Map<string, PreMeetingBrief>();
  const rows = (data ?? []) as PreMeetingBrief[];
  const ids = [...new Set(rows.map((b) => b.content?.meeting?.id).filter(Boolean))];
  if (!ids.length) return out;
  const { data: ms } = await ctx.db.from("meeting_visit").select("id, external_calendar_id, start_at, status, archived_at").eq("workspace_id", ctx.workspaceId).in("id", ids);
  for (const m of ms ?? []) {
    if (m.status === "cancelled" || m.archived_at) continue;
    const vk = meetingVersionKey({ id: m.id, externalId: m.external_calendar_id, startAt: m.start_at });
    const b = rows.find((r) => r.content?.meeting?.id === m.id && r.subject_key === vk);
    if (b) out.set(m.id, b);
  }
  return out;
}

function PreMeetingCard({ b, tz }: { b: PreMeetingBrief; tz: string }) {
  const c = b.content;
  return (
    <div id="pre-meeting">
    <Card title={`Pre-meeting: ${c.meeting?.title ?? "Meeting"} · ${fmt(c.meeting?.startAt, "HH:mm", tz)}`}>
      <div className="space-y-2 text-sm">
        {c.org ? <div><span className="font-medium">{c.org.name}</span>{c.score ? <> — {c.score.total}/100 ({TIER_LABEL[c.score.tier as Tier] ?? c.score.tier})</> : null}</div> : <p className="text-ink-soft">Meeting not linked to a company.</p>}
        {c.opportunity ? <div>Deal: {c.opportunity.name} · {c.opportunity.stage.replace(/_/g, " ")}{c.opportunity.nextAction ? ` · next: ${c.opportunity.nextAction}` : ""}</div> : null}
        {c.questions?.length ? <div><div className="font-medium">Questions to confirm</div><ul className="ml-4 list-disc">{c.questions.map((q: string) => <li key={q}>{q}</li>)}</ul></div> : null}
        {c.leases?.length ? <div><div className="font-medium">Leases</div><ul className="ml-4 list-disc">{c.leases.map((l: any) => <li key={l.leaseId}>{l.asset ?? "Unknown building"} — expiry {l.expiry ?? "unknown"}{l.basis ? ` (${l.basis})` : ""}{l.notice ? ` · notice ${l.notice}` : ""}</li>)}</ul></div> : null}
        {c.recent?.length ? <div><div className="font-medium">Recent interactions</div><ul className="ml-4 list-disc">{c.recent.map((r: any, i: number) => <li key={i}>{fmt(r.occurredAt, "dd MMM", tz)} {r.channel}: {r.subject ?? r.summary ?? ""}</li>)}</ul></div> : null}
        {c.openTasks?.length ? <div><div className="font-medium">Open tasks</div><ul className="ml-4 list-disc">{c.openTasks.map((t: any) => <li key={t.id}>{t.title}</li>)}</ul></div> : null}
      </div>
    </Card>
    </div>
  );
}
