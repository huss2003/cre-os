import { Suspense } from "react";
import { addDays } from "date-fns";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, Field, Input, MoreFields, Textarea, Select } from "@/components/ui";
import { EntityPicker } from "@/components/ui/entity-picker";
import { localDate, fmt as fmtAt } from "@/lib/util/time";
import { humanize, shortAction } from "@/modules/signals/text";
import { STATUS_LABEL as PIPE_LABEL } from "@/modules/signals/pipeline";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { getSignalCard, type SignalCard, type EvidenceItem } from "@/modules/signals/card";
import { signalAction, researchNowAction, addCompanyFromSignalAction } from "@/modules/signals/actions";
import { CAT_COLOR, URGENCY, VERIFY_LABEL, StrengthBars, confLabel } from "@/modules/signals/ui/card";

export const metadata = { title: "Signal" };
type Row = Record<string, any>;

const none = <span className="text-ink-soft">Nothing on record.</span>;
/** IST calendar day; date-only values are read as IST days. */
const fmt = (d?: string | null) => (d ? fmtAt(d.length === 10 ? `${d}T00:00:00+05:30` : d, "d MMM yyyy") : null);
const HIST_LABEL: Record<string, string> = { approve: "Approved", reject: "Rejected", dismiss: "Dismissed", snooze: "Snoozed", investigate: "Marked as reviewing", known: "Marked as already known",
  assign_me: "Assigned", create_task: "Task created", link_opportunity: "Linked to an opportunity", propose_opportunity: "Opportunity proposed", add_evidence: "Evidence added",
  add_counter: "Counter-evidence added", correct_company: "Company corrected", override_priority: "Priority overridden", clear_override: "Override cleared",
  record_outcome: "Outcome recorded", task_completed: "Follow-up task completed", reevaluate: "Re-assessed", reopen: "Reopened" };
const SIG_STATUS: Record<string, string> = { new: "New", reviewing: "Reviewing", approved: "Approved", dismissed: "Dismissed", snoozed: "Snoozed", rejected: "Rejected", known: "Already known", converted: "Converted to action" };
function historyDetail(x: Row): string {
  const d = (x.data ?? {}) as Row;
  const bits: string[] = [];
  if (x.action === "correct_company" && (d.from_name || d.to_name)) bits.push(`${d.from_name ?? "unmatched"} → ${d.to_name ?? "company"}`);
  if (d.outcome) bits.push(`outcome: “${d.outcome}”`);
  if (d.pasted) bits.push("from pasted text");
  if (d.priority_before != null && d.priority_after != null && d.priority_before !== d.priority_after) bits.push(`priority ${d.priority_before} → ${d.priority_after}`);
  if (d.until) bits.push(`until ${fmt(d.until)}`);
  return bits.join("; ");
}
const LABEL_TONE: Record<string, string> = { fact: "bg-emerald-50 text-emerald-800 ring-emerald-200", inference: "bg-sky-50 text-sky-800 ring-sky-200", hypothesis: "bg-amber-50 text-amber-800 ring-amber-200", unknown: "bg-stone-100 text-stone-700 ring-stone-200" };
const LABEL_TEXT: Record<string, string> = { fact: "Fact", inference: "Inference", hypothesis: "Hypothesis", unknown: "Unknown" };
function Tag({ kind }: { kind?: string | null }) {
  if (!kind) return null;
  return <span className={`ml-1 inline-block rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ring-1 ${LABEL_TONE[kind] ?? LABEL_TONE.unknown}`}>{LABEL_TEXT[kind] ?? kind}</span>;
}

function Section({ n, title, children, open = false, tag }: { n: number; title: string; children: React.ReactNode; open?: boolean; tag?: string }) {
  return (
    <details open={open} className="group border-t border-line first:border-t-0">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-sm font-semibold">
        <span>{n}. {title}<Tag kind={tag} /></span><span className="text-ink-soft transition-transform group-open:rotate-45" aria-hidden>+</span>
      </summary>
      <div className="pb-3 text-sm">{children}</div>
    </details>
  );
}

function EvidenceList({ items, empty }: { items: EvidenceItem[]; empty: React.ReactNode }) {
  if (!items.length) return <>{empty}</>;
  return (
    <ul className="space-y-2">
      {items.map((e) => (
        <li key={e.id} className="break-words">
          <p>“{e.excerpt ?? e.note}”<Tag kind={e.label} /></p>
          <p className="text-xs text-ink-soft">
            {[e.sourceName?.trim(), fmt(e.publishedOn), humanize(e.tier), humanize(e.factStatus)].filter(Boolean).join(" · ")}
            {e.url && /^https?:\/\//i.test(e.url) ? <> · <a className="underline" href={e.url} target="_blank" rel="noreferrer noopener">open source</a></> : null}
          </p>
        </li>
      ))}
    </ul>
  );
}

const ACT_LABEL: Record<string, string> = { approve: "Approve + task", investigate: "Investigate", assign_me: "Assign to me", known: "Already known", reject: "Reject", dismiss: "Dismiss", reopen: "Reopen", reevaluate: "Re-assess", clear_override: "Clear override" };

async function Body({ id }: { id: string }) {
  const ctx = await requirePageContext("viewer");
  const d = await getSignalCard(ctx.db, ctx.workspaceId, id);
  if (!d) notFound();
  return <Detail d={d} editor={ctx.role !== "viewer"} userId={ctx.userId} />;
}

function Detail({ d, editor, userId }: { d: SignalCard; editor: boolean; userId: string }) {
  const h = d.header; const s = d.sections; const id = d.id;
  const act = signalAction.bind(null, id);
  const can = new Set<string>(d.actions as string[]);
  const Btn = ({ a, children, v = "secondary" }: { a: string; children: React.ReactNode; v?: "primary" | "secondary" | "danger" }) => <Submit name="action" value={a} variant={v}>{children}</Submit>;
  const u = URGENCY[h.urgency] ?? URGENCY.low;
  const g = s.grouping;
  const L = s.labels as Record<string, string[]>;
  const decide = ["approve", "investigate", "assign_me", "known", "reopen", "reevaluate"].filter((a) => can.has(a) && !(a === "assign_me" && h.assignedUserId === userId));
  return (
    <>
      <Link href="/signals" className="inline-flex min-h-11 items-center text-sm text-ink-soft hover:text-ink">← Signals</Link>
      <header className="mb-6 flex overflow-hidden rounded-2xl border border-line bg-surface">
        <span className={`w-2 shrink-0 ${CAT_COLOR[h.category]?.rail ?? "bg-stone-400"}`} aria-hidden />
        <div className="min-w-0 flex-1 p-5 sm:p-6">
          <p className={`text-sm font-medium ${CAT_COLOR[h.category]?.text ?? ""}`}>{h.categoryLabel}{h.subTypeLabel ? <span className="text-ink-soft"> · {h.subTypeLabel}</span> : null}</p>
          <h1 className="mt-1 break-words text-xl font-bold leading-tight sm:text-2xl">{h.signal}</h1>
          <p className="mt-2 text-ink-soft">
            {h.companyId ? <Link className="text-ink underline-offset-2 hover:underline" href={`/companies/${h.companyId}`}>{h.company}</Link>
              : h.person ? <span className="text-ink">{h.person}</span>
              : <span className="text-warn">Company not matched{s.entity.rawName ? ` (${s.entity.rawName})` : ""}</span>}
            {h.location ? `, ${h.location}` : ""}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div><dt className="text-ink-soft">Detected</dt><dd>{fmt(h.detected)}</dd></div>
            <div><dt className="text-ink-soft">Event date</dt><dd>{h.eventDate ? <>{fmt(h.eventDate)}{h.eventDateBasis ? <span className="text-ink-soft"> ({humanize(h.eventDateBasis).toLowerCase()})</span> : null}</> : "Not dated"}</dd></div>
            <div className="col-span-2"><dt className="text-ink-soft">Evidence</dt><dd>{h.evidenceSummary}</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
            <span className={`rounded-full px-3 py-1 font-medium ring-1 ${u.cls}`} title={(h.priorityReasons as string[]).join("; ")}>{u.label} · {h.priority}/100</span>
            <span className="flex items-center gap-2" title={(h.confidenceReasons as string[]).join(" ")}><StrengthBars level={h.confidence} size="lg" /><span>{confLabel(h.confidence)}</span></span>
            <span>{VERIFY_LABEL[h.verification] ?? h.verification}{" "}<Tag kind={h.verification} /></span>
            <span className="rounded-full bg-canvas px-2.5 py-0.5">{h.statusLabel}{h.snoozedUntil && h.status === "snoozed" ? ` until ${fmt(h.snoozedUntil)}` : ""}</span>
            {h.assignedUserId ? <span className="text-ink-soft">{h.assignedUserId === userId ? "Assigned to you" : "Assigned"}</span> : null}
          </div>
          {h.overrideReviewDue ? <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">Priority override is due for review.</p> : null}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {!s.entity.resolved ? (
            <Card title="Which company is this?">
              <p className="text-sm text-ink-soft">“{s.entity.rawName ?? "Unknown name"}” was not matched automatically{humanize(s.entity.method) ? ` (${humanize(s.entity.method).toLowerCase()})` : ""}. Fuzzy matches are never linked without you.</p>
              {s.entity.candidates.length ? (
                <ul className="mt-3 space-y-2">
                  {(s.entity.candidates as { id: string; name: string; reasons?: string[] }[]).map((c) => (
                    <li key={c.id} className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div><p className="font-medium">{c.name}</p>{c.reasons?.length ? <p className="text-xs text-ink-soft">{c.reasons.join("; ")}</p> : null}</div>
                      {editor ? <ActionForm action={act}><input type="hidden" name="org_id" value={c.id} /><Btn a="correct_company">This is it</Btn></ActionForm> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm text-ink-soft">No likely matches in your records.</p>}
              {editor && s.entity.rawName && !h.person ? <ActionForm action={addCompanyFromSignalAction.bind(null, id)} className="mt-3"><Submit variant="secondary">Add {s.entity.rawName} as a new company</Submit></ActionForm> : null}
            </Card>
          ) : null}

          <Card title="Details">
            <Section n={1} title="What happened" open tag={h.verification}>{s.whatHappened}{s.contextualSummary ? <p className="mt-2 text-ink-soft">{s.contextualSummary}</p> : null}{s.locationNote ? <p className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-warn">{s.locationNote}</p> : null}</Section>
            <Section n={2} title="Why it matters" open tag="inference">{s.whyItMatters || none}</Section>
            <Section n={3} title="Supporting evidence" open>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">For ({s.evidence.length})</p><EvidenceList items={s.evidence} empty={none} /></div>
                <div className="rounded-xl bg-canvas p-3"><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">Against ({s.counterEvidence.length})</p>
                  {s.counterEvidence.length ? <ul className="list-disc space-y-1 pl-4">{s.counterEvidence.map((c, i) => <li key={i}>{c.text} <span className="text-xs text-ink-soft">({c.source === "user" ? "added by a user" : c.source === "rule" ? "rule check" : "evidence"})</span></li>)}</ul> : <span className="text-ink-soft">None found yet — that does not mean there is none.</span>}
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div><dt className="text-ink-soft">First detected</dt><dd>{fmt(g.firstDetected) ?? "—"}</dd></div>
                <div><dt className="text-ink-soft">Most recent confirmation</dt><dd>{fmt(g.mostRecentConfirmation) ?? "None"}</dd></div>
                <div><dt className="text-ink-soft">Sources</dt><dd>{g.supportingSources}</dd></div>
                <div><dt className="text-ink-soft">Independent</dt><dd>{g.independentEvidenceCount ?? 0}{g.contradictoryCount ? <span className="text-warn"> · {g.contradictoryCount} contradicting</span> : null}</dd></div>
              </dl>
              {(h.confidenceReasons as string[]).length ? <p className="mt-2 text-xs text-ink-soft">{(h.confidenceReasons as string[]).join(" ")}</p> : null}
              {s.groupingNotes.length ? <p className="mt-1 text-xs text-ink-soft">Grouping: {s.groupingNotes.join(" ")}</p> : null}
            </Section>
            <Section n={4} title="Related company records" tag="fact">
              {s.relatedCompany ? <>
                <Link className="underline" href={`/companies/${s.relatedCompany.id}`}>{s.relatedCompany.name}</Link>{s.relatedCompany.sector ? ` · ${s.relatedCompany.sector}` : ""}
                {s.relatedCompany.relations.length ? <ul className="mt-1 text-ink-soft">{s.relatedCompany.relations.map((r: Row, i: number) => <li key={i}>{String(r.relation).replace(/_/g, " ")}: <Link className="underline" href={`/companies/${r.id}`}>{r.name}</Link></li>)}</ul> : null}
                {s.opportunities.length ? <ul className="mt-1">{s.opportunities.map((o) => <li key={o.id}>Deal: {o.name} ({[humanize(o.stage), humanize(o.outcome)].filter(Boolean).join(", ").toLowerCase()})</li>)}</ul> : null}
              </> : none}
            </Section>
            <Section n={5} title="Known office locations" tag="fact">{s.officeLocations.length ? s.officeLocations.join(", ") : none}</Section>
            <Section n={6} title="Existing occupancy" tag="fact">
              {s.occupancy.length ? <ul>{s.occupancy.map((l) => <li key={l.leaseId}>{l.asset ?? "Building"} · {l.areaSf ? `${Number(l.areaSf).toLocaleString("en-IN")} sq ft` : "area unknown"} · expiry {fmt(l.expiry) ?? "unknown"}</li>)}</ul> : none}
              <p className="text-xs text-ink-soft">Spare capacity is not recorded<Tag kind="unknown" /></p>
            </Section>
            <Section n={7} title="Relevant lease events">
              {s.leaseEvents.length ? <ul className="space-y-1">{s.leaseEvents.map((e, i) => <li key={i}><span className="rounded bg-amber-50 px-1.5 py-px text-xs font-semibold text-amber-800">{e.typeLabel}</span> {fmt(e.date) ?? "no date"} <span className="text-ink-soft">({humanize(e.basis).toLowerCase()}{e.confirmed ? ", confirmed" : ", not confirmed"})</span><Tag kind={e.confirmed ? "fact" : "inference"} /></li>)}</ul> : none}
            </Section>
            <Section n={8} title="Related contacts">
              {s.contacts.length ? <ul>{s.contacts.map((p) => <li key={p.personId}><Link className="underline" href={`/people/${p.personId}`}>{p.name}</Link>{p.title ? ` — ${p.title}` : ""}{p.creRole ? <span className="ml-1 text-xs text-emerald-700">real-estate decision role</span> : null}</li>)}</ul> : none}
            </Section>
            <Section n={9} title="Existing requirements">{s.requirements.length ? <ul>{s.requirements.map((r) => <li key={r.id}><Link className="underline" href={`/requirements/${r.id}`}>{r.title}</Link>{r.status ? <span className="text-ink-soft"> · {r.status}</span> : null}</li>)}</ul> : none}</Section>
            <Section n={10} title="Counter-evidence">{s.counterEvidence.length ? <ul className="list-disc pl-5">{s.counterEvidence.map((x, i) => <li key={i}>{x.text}</li>)}</ul> : <span className="text-ink-soft">None found yet — that does not mean there is none.</span>}</Section>
            <Section n={11} title="Missing information" tag="unknown">{s.missingInfo.length ? <ul className="list-disc pl-5">{(s.missingInfo as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul> : none}</Section>
            <Section n={12} title="Suggested next steps" open>
              <ul className="space-y-1">{s.nextSteps.map((n, i) => <li key={i}>{n.text} <span className="text-xs text-ink-soft">({humanize(n.actionKind).toLowerCase()})</span></li>)}</ul>
              {d.task ? <p className="mt-1 text-xs"><Link className="underline" href="/tasks">Task: {d.task.title}</Link> · {d.task.status === "done" ? "Done" : humanize(d.task.status)}{d.task.status !== "done" && d.task.due_at ? ` · due ${fmt(d.task.due_at)}` : ""}{d.task.status === "done" && d.task.completion_evidence ? ` · outcome: “${d.task.completion_evidence}”` : ""}</p> : null}
            </Section>
          </Card>

          <Card title="Fact, inference, hypothesis, unknown">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              {(["facts", "inferences", "hypotheses", "unknowns"] as const).map((k) => (
                <div key={k}><p className="mb-1"><Tag kind={{ facts: "fact", inferences: "inference", hypotheses: "hypothesis", unknowns: "unknown" }[k]} /></p>
                  {(L[k] ?? []).length ? <ul className="list-disc pl-5">{L[k].map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-ink-soft">—</p>}</div>
              ))}
            </div>
          </Card>

          <Card title="Priority — why">
            <ul className="list-disc pl-5 text-sm">{(h.priorityReasons as string[]).map((r, i) => <li key={i}>{r}</li>)}</ul>
            {h.priorityOverride ? <p className="mt-2 text-xs text-ink-soft">Overridden to {h.priorityOverride.band}: {h.priorityOverride.reason}{h.priorityOverride.review_on ? ` · review ${fmt(h.priorityOverride.review_on)}` : ""}</p> : null}
          </Card>

          <Card title="History">
            {d.history.length ? <ul className="space-y-1 text-sm">{(d.history as Row[]).map((x, i) => { const det = historyDetail(x); return <li key={i}><span className="text-ink-soft">{fmtAt(x.created_at, "d MMM yyyy, HH:mm")} IST</span> · {HIST_LABEL[x.action] ?? humanize(x.action)}{x.from_status !== x.to_status ? ` (${SIG_STATUS[x.from_status] ?? humanize(x.from_status)} → ${SIG_STATUS[x.to_status] ?? humanize(x.to_status)})` : ""}{det ? ` — ${det}` : ""}{x.reason ? ` — ${x.reason}` : ""}</li>; })}</ul> : none}
            {d.sourceItems.length ? <><p className="mt-3 text-xs font-semibold text-ink-soft">Source items</p><ul className="text-xs">{(d.sourceItems as Row[]).map((x) => <li key={x.id}>{humanize(x.adapter)} · {PIPE_LABEL[x.status as keyof typeof PIPE_LABEL] ?? humanize(x.status)}{x.title ? ` · ${x.title}` : ""}{x.error ? <span className="text-bad"> · {x.error}</span> : null}</li>)}</ul></> : null}
          </Card>
        </div>

        {editor ? (
          <div className="min-w-0 space-y-4">
            <Card title="Decide">
              <ActionForm action={act} className="space-y-2">
                <div className="flex flex-wrap gap-2">{decide.map((a) => <Btn key={a} a={a} v={a === "approve" ? "primary" : "secondary"}>{ACT_LABEL[a]}</Btn>)}</div>
              </ActionForm>
              {can.has("reject") || can.has("dismiss") ? (
                <ActionForm action={act} className="mt-3 space-y-2">
                  <Field label="Reason" hint="Required to reject or dismiss"><Input name="reason" required /></Field>
                  <div className="flex flex-wrap gap-2">{can.has("dismiss") ? <Btn a="dismiss">Dismiss</Btn> : null}{can.has("reject") ? <Btn a="reject" v="danger">Reject</Btn> : null}</div>
                </ActionForm>
              ) : null}
              {can.has("snooze") ? <ActionForm action={act} className="mt-3 flex flex-wrap items-end gap-2"><Field label="Snooze until"><Input name="until" type="date" min={localDate(addDays(new Date(), 1))} required /></Field><Field label="Reason (optional)"><Input name="reason" /></Field><Btn a="snooze">Snooze</Btn></ActionForm> : null}
              {can.has("record_outcome") ? <ActionForm action={act} className="mt-3 space-y-2"><Field label="Outcome" hint="Completes the linked task"><Input name="outcome" required placeholder="e.g. Spoke to facilities head — no requirement this year" /></Field><Btn a="record_outcome">Record outcome</Btn></ActionForm> : null}
            </Card>
            <Card title="Task">
              <ActionForm action={act} className="space-y-2"><Field label="Task title"><Input name="title" maxLength={300} defaultValue={h.recommendedAction ? shortAction(h.recommendedAction) : ""} /></Field><Btn a="create_task">Create task</Btn></ActionForm>
            </Card>
            <Card title="Opportunity">
              <ActionForm action={act} className="space-y-2"><EntityPicker name="opportunity_id" kind="company" label="Link to existing opportunity" endpoint="/signals/lookup" placeholder="Type a deal name…" /><Btn a="link_opportunity">Link</Btn></ActionForm>
              <ActionForm action={act} className="mt-3 space-y-2"><Field label="Or propose a new opportunity" hint="Goes to Review for approval"><Input name="name" placeholder={h.signal} /></Field><Btn a="propose_opportunity">Propose opportunity</Btn></ActionForm>
            </Card>
            {h.companyId ? <Card title="Research"><ActionForm action={researchNowAction.bind(null, h.companyId)}><p className="mb-3 text-sm text-ink-soft">Search for recent news about this company.</p><Submit variant="secondary">Research this company</Submit></ActionForm></Card> : null}
            <Card title="Correct company">
              <ActionForm action={act} className="space-y-2"><EntityPicker name="org_id" kind="company" label="Correct company" placeholder="Type a company name…" defaultValue={h.companyId && h.company ? { id: h.companyId, label: h.company } : null} /><p className="text-xs text-ink-soft">The change is kept in the history and audit log.</p><Btn a="correct_company">Save company</Btn></ActionForm>
            </Card>
            <Card title="Add evidence">
              <ActionForm action={act} className="space-y-2">
                <Field label="What the source says"><Textarea name="text" rows={3} required /></Field>
                <Field label="Source name"><Input name="source" placeholder="e.g. Economic Times" /></Field>
                <Field label="Link" hint="http:// or https:// only"><Input name="url" type="url" pattern="https?://.+" placeholder="https://" /></Field>
                <MoreFields><Field label="Published on"><Input name="published_on" type="date" /></Field></MoreFields>
                <div className="flex flex-wrap gap-2"><Btn a="add_evidence">Add supporting</Btn><Btn a="add_counter">Add counter-evidence</Btn></div>
              </ActionForm>
            </Card>
            <Card title="Override priority">
              <ActionForm action={act} className="space-y-2">
                <Field label="Priority"><Select name="band" defaultValue={h.urgency}><option value="high">High — act now</option><option value="medium">Medium — this month</option><option value="low">Low — watch</option></Select></Field>
                <Field label="Reason"><Input name="reason" required /></Field>
                <Field label="Review on"><Input name="review_on" type="date" min={localDate(addDays(new Date(), 1))} /></Field>
                <div className="flex flex-wrap gap-2"><Btn a="override_priority">Save override</Btn>{h.priorityOverride ? <Btn a="clear_override">Clear override</Btn> : null}</div>
              </ActionForm>
            </Card>
          </div>
        ) : <p className="text-sm text-ink-soft">You have view-only access.</p>}
      </div>
    </>
  );
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<Loading variant="detail" />}><Body id={id} /></Suspense>;
}
