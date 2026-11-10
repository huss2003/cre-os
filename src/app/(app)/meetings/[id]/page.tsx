import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { HelpFor } from "@/components/ui";
import { gather, assessReadiness, MeetingError, type Item } from "@/modules/meetings/service";
import { MEETING_TYPES, SITE_VISIT } from "@/modules/meetings/rules";
import * as A from "@/modules/meetings/actions";
import { Tag, Dot, Avatar, AvatarStack, Gauge, Section, Kicker, Chip, Disclosure, Chevron, OUTCOME_LABEL, inp, linkBtn } from "@/modules/meetings/ui/dossier";

export const metadata = { title: "Meeting brief" };
type Row = Record<string, any>;
const ROLE: Record<string, string> = { decision_maker: "Decision-maker", economic_buyer: "Economic buyer", influencer: "Influencer", technical_evaluator: "Evaluator", operational: "Operational", gatekeeper: "Gatekeeper", procurement: "Procurement", administrative: "Administrative", unknown: "Role unknown" };
const dateFmt = (d: string) => new Date(d).toLocaleString("en-IN", { weekday: "short", dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" } as Intl.DateTimeFormatOptions);
const Notice = ({ tone, children }: { tone: "bad" | "warn"; children: React.ReactNode }) => (
  <p className={`flex gap-2.5 border-l-2 py-1 pl-3 text-sm ${tone === "bad" ? "border-bad text-bad" : "border-warn text-warn"}`}>{children}</p>
);

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  let x; try { x = await gather(ctx.db, ctx.workspaceId, id); } catch (e) { if (e instanceof MeetingError) notFound(); throw e; }
  const p = x.prep; const b = p.brief as Row | null; const m = x.meeting;
  const rd = b ? (p.readiness_detail as Row) : assessReadiness(x, null);
  const score = b ? p.readiness : rd.score;
  const t = MEETING_TYPES[p.meeting_type] ?? MEETING_TYPES.discovery;
  const [{ data: people }, { data: assets }] = await Promise.all([
    ctx.db.from("person").select("id, full_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("full_name").limit(1000),
    ctx.db.from("asset").select("id, name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(1000),
  ]);
  const out = p.outcome?.proposed as Row | undefined;
  const cancelled = p.status === "cancelled";
  const canReschedule = editor && !cancelled && p.status !== "completed";
  const startTime = new Date(m.start_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const attendeeNames: string[] = b ? (b.attendees as Row[]).map((a) => a.name) : x.attendees.map((a) => a.name);

  const sections: [string, string][] = b ? ([
    ["purpose", "Purpose"], ["company", "Company"], ["attendees", "Attendees"],
    ...(b.opportunity ? [["opportunity", "Opportunity"]] : []),
    ["history", "Previous discussions"], ["strategy", "Strategy"], ["questions", "Questions"], ["objections", "Objections"],
    ...(b.properties?.length ? [["properties", "Properties"]] : []),
    ["outcome", "Desired outcome"],
  ] as [string, string][]) : [];
  const numbered = sections.length;
  const num = (key: string) => { const i = sections.findIndex(([k]) => k === key); return i >= 0 && i < numbered ? String(i + 1).padStart(2, "0") : ""; };
  if (p.meeting_type === "site_visit") sections.push(["checklist", "Site visit checklist"]);
  if (editor && b && !cancelled) sections.push(["after", "After the meeting"]);
  if (editor) sections.push(["manage", "Manage"]);

  const actions = (
    <div className="flex flex-wrap gap-2 print:hidden lg:flex-col lg:items-stretch">
      {editor && !cancelled ? <ActionForm action={A.briefAction.bind(null, id)}><Submit variant={b ? "secondary" : "primary"} className="w-full min-h-10">{b ? "Regenerate" : "Prepare brief"}</Submit></ActionForm> : null}
      {b ? <Link href={`/meetings/${id}/live`} className={`${linkBtn} bg-ink text-white hover:bg-ink/90`}>Meeting mode</Link> : null}
      {editor && b && p.status === "brief_ready" ? <ActionForm action={A.reviewAction.bind(null, id)}><Submit variant="secondary" className="w-full min-h-10">Mark reviewed</Submit></ActionForm> : null}
      {b ? <a href={`/api/v1/meetings/${id}/brief`} className={`${linkBtn} border border-line bg-surface hover:bg-canvas`}>Export</a> : null}
    </div>
  );

  const readiness = (
    <div>
      <div className="flex items-center gap-4">
        <Gauge score={score} />
        <div className="min-w-0">
          <p className="flex items-center text-sm font-semibold">Readiness<HelpFor k="Meeting readiness" /></p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-soft">{p.status.replace(/_/g, " ")}{b ? ` · v${p.brief_version}${p.reviewed_at ? " · reviewed" : ""}` : ""}{b && String(p.brief_model ?? "").startsWith("mock:") ? " · rule-based wording (AI off)" : ""}</p>
        </div>
      </div>
      {rd.critical?.length ? <div className="mt-4"><Kicker>Critical</Kicker><ul className="mt-1.5 space-y-1 text-sm">{(rd.critical as string[]).map((c, i) => <li key={i} className="flex gap-2"><Dot tone="bad" />{c}</li>)}</ul></div> : null}
      {rd.missing?.length ? <div className="mt-4"><Kicker>Missing</Kicker><ul className="mt-1.5 space-y-1 text-sm text-ink-soft">{(rd.missing as string[]).map((c, i) => <li key={i} className="flex gap-2"><Dot tone="warn" />{c}</li>)}</ul></div>
        : <p className="mt-4 flex gap-2 text-sm text-ok"><Dot tone="ok" />Well prepared.</p>}
    </div>
  );

  const facts = (
    <dl className="space-y-3 text-sm">
      <div><dt className="text-xs text-ink-soft">When</dt><dd>{dateFmt(m.start_at)}</dd></div>
      {m.location ? <div><dt className="text-xs text-ink-soft">Where</dt><dd>{m.location}</dd></div> : null}
      {x.org ? <div><dt className="text-xs text-ink-soft">Company</dt><dd><Link className="underline decoration-line underline-offset-4 hover:text-brand" href={`/companies/${x.org.id}`}>{x.org.display_name}</Link></dd></div> : null}
      {b?.opportunity ? <div><dt className="text-xs text-ink-soft">Deal</dt><dd>{b.opportunity.requirement?.title ?? "Linked deal"}{b.opportunity.stage ? <span className="text-ink-soft"> · {b.opportunity.stage.replace(/_/g, " ")}</span> : null}</dd></div> : null}
    </dl>
  );

  return (
    <div className="mx-auto max-w-[1120px] pb-16 print:max-w-none">
      <Link href="/meetings" className="inline-flex min-h-10 items-center text-sm text-ink-soft hover:text-ink print:hidden">← Meetings</Link>

      <div className="lg:grid lg:grid-cols-[minmax(0,720px)_300px] lg:justify-between lg:gap-12">
        <main className="min-w-0">
          <header className="pb-8 pt-4">
            <Kicker>{t.label} · {dateFmt(m.start_at)}</Kicker>
            <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{m.title}</h1>
            {m.location || x.org ? <p className="mt-2 text-[15px] text-ink-soft">{[m.location, x.org?.display_name].filter(Boolean).join(" · ")}</p> : null}
            <div className="mt-5"><AvatarStack names={attendeeNames} /></div>
            {p.source !== "manual" ? <p className="mt-3 text-xs text-ink-soft">From {p.source === "calendar" ? "your connected calendar" : "an imported .ics file"}</p> : null}
          </header>

          {/* Mobile summary bar */}
          <div className="mb-8 space-y-4 rounded-xl bg-surface p-4 lg:hidden print:hidden">
            <div className="flex items-center gap-4">
              <div className="scale-75 -m-3"><Gauge score={score} /></div>
              <div className="min-w-0 text-sm">
                <p className="font-semibold">Readiness</p>
                <p className="text-ink-soft">{rd.critical?.length ? `${rd.critical.length} critical · ` : ""}{rd.missing?.length ? `${rd.missing.length} missing` : "Well prepared"}</p>
              </div>
            </div>
            {actions}
            {rd.critical?.length || rd.missing?.length ? <details className="group"><summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm text-ink-soft [&::-webkit-details-marker]:hidden">Readiness detail<Chevron /></summary><div className="pt-2">{readiness}</div></details> : null}
          </div>

          <div className="space-y-2 pb-6">
            {cancelled ? <Notice tone="bad">This meeting is cancelled.</Notice> : null}
            {p.status === "rescheduled" ? <Notice tone="warn">Rescheduled — regenerate the brief so dates and reminders are current.</Notice> : null}
            {p.brief_error ? <Notice tone="bad">Last preparation failed: {p.brief_error}. Press Regenerate to retry — earlier versions are kept.</Notice> : null}
          </div>

          {!b ? (
            <section className="border-t border-line py-10">
              <p className="text-xl font-semibold tracking-tight">No brief yet</p>
              <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-ink-soft">Press <b className="text-ink">Prepare brief</b>. It pulls the company, attendees, signals, previous conversations and the deal from your records — usually under a minute.</p>
            </section>
          ) : (
            <article className="max-w-[72ch]">
              <Section id="purpose" n={num("purpose")} title="Meeting purpose">
                <dl className="grid gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-2">
                  {([["Why we're meeting", b.purpose.why, null], ["What triggered it", b.purpose.trigger, null], ["What they may want", b.purpose.they_may_want, "inference"], ["What we want", b.purpose.we_want, null]] as [string, string, string | null][]).map(([k, v, tag]) => (
                    <div key={k} className="bg-surface p-4"><dt className="text-xs font-medium text-ink-soft">{k}{tag ? <Tag k={tag} /> : null}</dt><dd className="mt-1.5">{v}</dd></div>
                  ))}
                </dl>
              </Section>

              <Section id="company" n={num("company")} title="Company">
                <ul className="space-y-2.5">{(b.company.items as Item[]).map((c, i) => <li key={i} className="flex gap-2.5"><Dot tone={c.changed ? "bad" : "muted"} /><span>{c.changed ? <span className="mr-1.5 text-xs font-semibold uppercase tracking-wider text-brand">New</span> : null}{c.text}<Tag k={c.kind} /></span></li>)}{!b.company.items.length ? <li className="text-ink-soft">Nothing on record.</li> : null}</ul>
                {b.company.unknowns.length ? <p className="mt-4 text-sm text-ink-soft">Unknown: {b.company.unknowns.join(", ")}</p> : null}
                {b.company.scores?.lead !== null && b.company.scores?.lead !== undefined ? <p className="mt-2 text-xs text-ink-soft">Lead score {b.company.scores.lead}/100{b.company.scores.opportunity !== null ? ` · deal score ${b.company.scores.opportunity}/100` : ""}</p> : null}
              </Section>

              <Section id="attendees" n={num("attendees")} title="Attendees">
                <ul className="divide-y divide-line">{(b.attendees as Row[]).map((a) => (
                  <li key={a.id} className="flex gap-3 py-4 first:pt-0">
                    <Avatar name={a.name} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2"><span className="font-semibold">{a.personId ? <Link href={`/contacts/${a.personId}`} className="hover:text-brand">{a.name}</Link> : a.name}</span><span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-strong">{ROLE[a.role] ?? a.role}</span></p>
                      <p className="text-sm text-ink-soft">{a.title ?? "Title unknown"}{a.company ? ` · ${a.company}` : ""}{a.relevance ? ` · CRE relevance ${a.relevance}` : ""}{a.stakeholderRole ? ` · stakeholder: ${a.stakeholderRole}` : ""}</p>
                      {a.why_matters ? <p className="mt-2">{a.why_matters}</p> : null}
                      <p className="mt-1.5 text-xs text-ink-soft">{a.interactions ? `${a.interactions} past interaction(s), last ${a.lastInteraction}` : "No previous interaction"}{a.channels.length ? ` · ${a.channels.join(" · ")}` : ""}{a.previous.length ? ` · before: ${a.previous.join("; ")}` : ""}</p>
                      {a.match !== "matched" && a.match !== "manual" ? <p className="mt-1 text-xs text-warn">{a.matchReason}</p> : null}
                    </div>
                  </li>))}</ul>
              </Section>

              {b.opportunity ? <Section id="opportunity" n={num("opportunity")} title="Opportunity">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  {b.opportunity.requirement ? <>
                    <div className="col-span-2 sm:col-span-3"><dt className="text-xs text-ink-soft">Requirement</dt><dd className="font-medium">{b.opportunity.requirement.title} <span className="font-normal text-ink-soft">({b.opportunity.requirement.status})</span></dd></div>
                    <div><dt className="text-xs text-ink-soft">Seats / area</dt><dd className="tabular-nums">{b.opportunity.requirement.seats ?? "?"} / {b.opportunity.requirement.area ?? "?"} sq ft</dd></div>
                    <div><dt className="text-xs text-ink-soft">Budget</dt><dd>{b.opportunity.requirement.budget ?? <i className="text-ink-soft">unknown</i>}</dd></div>
                    <div><dt className="text-xs text-ink-soft">Move-in</dt><dd>{b.opportunity.requirement.move_in ?? <i className="text-ink-soft">unknown</i>}</dd></div>
                  </> : <p className="col-span-full text-ink-soft">No requirement on record.</p>}
                  <div><dt className="text-xs text-ink-soft">Stage</dt><dd className="capitalize">{b.opportunity.stage?.replace(/_/g, " ") ?? "—"}</dd></div>
                  <div className="col-span-2"><dt className="text-xs text-ink-soft">Risks</dt><dd>{b.opportunity.risks ?? "—"}</dd></div>
                </dl>
              </Section> : null}

              <Section id="history" n={num("history")} title="Previous discussions">
                {b.history.first ? <p className="rounded-xl bg-surface px-4 py-3 text-ink-soft">First interaction — nothing on record with this company or these people.</p> : (
                  <ol className="relative space-y-4 border-l border-line pl-5">{(b.history.items as Item[]).map((h, i) => <li key={i} className="relative"><span aria-hidden className="absolute -left-[24.5px] top-[8px] h-2 w-2 rounded-full border-2 border-canvas bg-ink-soft" />{h.text}</li>)}</ol>)}
                {b.history.commitments.length ? <div className="mt-6"><Kicker>Commitments on record</Kicker><ul className="mt-2 space-y-1.5">{(b.history.commitments as Row[]).map((c, i) => <li key={i} className="flex gap-2.5"><Dot tone="muted" /><span>{c.text} <span className="text-sm text-ink-soft">({c.date})</span></span></li>)}</ul></div> : null}
                {b.history.objections.length ? <div className="mt-6"><Kicker>Objections they raised</Kicker><ul className="mt-2 space-y-1.5">{(b.history.objections as Row[]).map((c, i) => <li key={i} className="flex gap-2.5"><Dot tone="warn" /><span>{c.text} <span className="text-sm text-ink-soft">({c.date})</span></span></li>)}</ul></div> : null}
                {b.history.open_tasks.length ? <p className="mt-6 text-sm"><span className="font-medium">Open tasks:</span> {(b.history.open_tasks as Row[]).map((tk) => tk.title).join(" · ")}</p> : null}
                {b.history.outreach.length ? <p className="mt-2 text-sm"><span className="font-medium">Outreach:</span> {(b.history.outreach as Row[]).map((o) => `${o.channel} ${o.status}${o.reply ? ` — "${o.reply.slice(0, 80)}"` : ""}`).join(" · ")}</p> : null}
              </Section>

              <Section id="strategy" n={num("strategy")} title="Meeting strategy">
                <ol className="space-y-5">{(b.strategy as Row[]).map((s, i) => (
                  <li key={i}>
                    <Kicker>{s.stage}</Kicker>
                    <p className="mt-1 font-medium">{s.point}<Tag k="suggestion" /></p>
                    <p className="mt-1 text-sm text-ink-soft">Why: {s.why} · Find out: {s.obtain} · Aim: {s.outcome}</p>
                  </li>))}</ol>
                {b.avoid.length ? <div className="mt-6 rounded-xl bg-surface p-4"><Kicker>Avoid</Kicker><ul className="mt-2 space-y-1">{(b.avoid as string[]).map((v, i) => <li key={i} className="flex gap-2.5"><Dot tone="bad" />{v}</li>)}</ul></div> : null}
              </Section>

              <Section id="questions" n={num("questions")} title="Questions to ask">
                <Kicker>Essential</Kicker>
                <ol className="mt-2 space-y-2.5">{(b.questions.essential as Row[]).map((q, i) => <li key={q.key} className="flex gap-3"><span className="w-5 shrink-0 text-right text-sm tabular-nums text-brand">{i + 1}</span><span>{q.text}</span></li>)}</ol>
                <div className="mt-6"><Kicker>If there&apos;s time</Kicker>
                  <ul className="mt-2 space-y-2">{(b.questions.additional as Row[]).map((q) => <li key={q.key} className="flex gap-3"><span aria-hidden className="w-5 shrink-0 text-right text-ink-soft">–</span><span>{q.answered ? <><s className="text-ink-soft decoration-ink-soft/50">{q.text}</s><span className="mt-0.5 block text-xs text-ink-soft">Already known: {q.answered}</span></> : q.text}</span></li>)}</ul></div>
                {b.questions.strategic.length ? <div className="mt-6"><Kicker>Strategic</Kicker><ul className="mt-2 space-y-2">{(b.questions.strategic as Row[]).map((q) => <li key={q.key} className="flex gap-3"><span aria-hidden className="w-5 shrink-0 text-right text-ink-soft">–</span>{q.text}</li>)}</ul></div> : null}
                {(b.questions.custom ?? []).length ? <div className="mt-6"><Kicker>Your questions</Kicker><ul className="mt-2 space-y-2">{(b.questions.custom as Row[]).map((q, i) => <li key={i} className="flex gap-3"><span aria-hidden className="w-5 shrink-0 text-right text-ink-soft">–</span>{q.text}</li>)}</ul></div> : null}
              </Section>

              <Section id="objections" n={num("objections")} title="Possible objections" note="Anticipated — not things anyone has said.">
                <div className="divide-y divide-line border-y border-line">{(b.objections as Row[]).map((o, i) => (
                  <details key={i} className="group">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 font-medium focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">“{o.objection}”<Chevron /></summary>
                    <dl className="grid gap-2 pb-4 text-[15px] sm:grid-cols-[110px_1fr]">
                      <dt className="text-sm text-ink-soft">May mean</dt><dd>{o.meaning}</dd>
                      <dt className="text-sm text-ink-soft">Respond</dt><dd>{o.response}</dd>
                      <dt className="text-sm text-ink-soft">Ask</dt><dd>{o.follow_up}</dd>
                      <dt className="text-sm text-ink-soft">Have ready</dt><dd className="text-ink-soft">{o.evidence}</dd>
                    </dl>
                  </details>))}</div>
              </Section>

              {b.properties?.length ? <Section id="properties" n={num("properties")} title="Properties">
                <ul className="divide-y divide-line border-y border-line">{(b.properties as Row[]).map((pp) => (
                  <li key={pp.id} className="py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-semibold">{pp.name}</p><Chip tone={pp.verified ? "ok" : "muted"}>{pp.verified ? "Availability verified" : "Availability not verified"}</Chip></div>
                    <p className="text-sm text-ink-soft">{[pp.developer, pp.location, pp.grade && `Grade ${pp.grade}`, pp.floors && `${pp.floors} floors`].filter(Boolean).join(" · ")}</p>
                    {pp.spaces.length ? <ul className="mt-2 space-y-0.5 text-sm tabular-nums">{(pp.spaces as Row[]).map((s, i) => <li key={i}>{s.floor ?? "Floor ?"} · {s.area ?? "?"} sq ft · {s.config ?? "?"} · {s.status}{s.from ? ` from ${s.from}` : ""}{s.rent ? ` · ${s.rent}` : ""} <span className="text-ink-soft">(as of {s.asOf})</span></li>)}</ul> : null}
                    {pp.match.length || pp.mismatch.length || pp.missing.length ? <div className="mt-3 flex flex-wrap gap-1.5">
                      {(pp.match as string[]).map((v, i) => <Chip key={`m${i}`} tone="ok">Fits: {v}</Chip>)}
                      {(pp.mismatch as string[]).map((v, i) => <Chip key={`x${i}`} tone="bad">Gap: {v}</Chip>)}
                      {(pp.missing as string[]).map((v, i) => <Chip key={`u${i}`} tone="muted">Unknown: {v}</Chip>)}
                    </div> : null}
                    <p className="mt-2 text-xs text-ink-soft">Verify: {pp.verify.join(" · ")}</p>
                  </li>))}</ul>
              </Section> : null}

              <Section id="outcome" n={num("outcome")} title="Desired outcome">
                <p className="text-lg font-medium leading-snug tracking-tight">{b.outcome.ideal}</p>
                {b.outcome.acceptable.length ? <ul className="mt-3 space-y-1 text-ink-soft">{(b.outcome.acceptable as string[]).map((a, i) => <li key={i} className="flex gap-2.5"><Dot tone="muted" />Also fine: {a}</li>)}</ul> : null}
                <div className="mt-6"><Kicker>Next steps after the meeting</Kicker>
                  <ol className="mt-2 space-y-1.5">{(b.next_steps as string[]).map((s, i) => <li key={i} className="flex gap-3"><span className="w-5 shrink-0 text-right text-sm tabular-nums text-ink-soft">{i + 1}</span>{s}</li>)}</ol></div>
              </Section>
            </article>
          )}

          {p.meeting_type === "site_visit" ? (
            <div className="print:hidden"><Section id="checklist" title="Site visit checklist">
              <div className="grid gap-6 md:grid-cols-3">{(["before", "during", "after"] as const).map((ph) => (
                <div key={ph}><Kicker>{ph === "before" ? "Before" : ph === "during" ? "During" : "After"}</Kicker>
                  <ul className="mt-2 space-y-1">{SITE_VISIT[ph].map((c) => { const on = !!p.checklist?.[c.key]; return <li key={c.key}>{editor ? <ActionForm action={A.checkAction.bind(null, id, c.key, !on)}><button className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-1 text-left text-sm hover:bg-surface"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "border-brand bg-brand text-white" : "border-line bg-surface"}`}>{on ? <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8l3.5 3.5L13 5" /></svg> : null}</span><span className={on ? "text-ink-soft line-through" : ""}>{c.label}</span></button></ActionForm> : <span className="text-sm">{on ? "✓ " : "○ "}{c.label}</span>}</li>; })}</ul>
                </div>))}</div>
            </Section></div>
          ) : null}

          {editor && b && !cancelled ? (
            <div className="print:hidden"><Section id="after" title="After the meeting">
              {!out ? (
                <ActionForm action={A.structureAction.bind(null, id)} className="space-y-3"><textarea name="text" rows={5} placeholder="What happened? Area, budget, dates, who decides, objections, what you promised… (notes from Meeting mode are included)" className={inp} /><Submit>Structure my notes</Submit></ActionForm>
              ) : p.outcome?.applied ? (
                <p>Applied {new Date(p.outcome.applied.at).toLocaleString("en-IN")}: {p.outcome.applied.proposals} update(s) to Review, {p.outcome.applied.tasks} task(s). <Link href="/approvals" className="text-brand underline underline-offset-4">Open Review</Link></p>
              ) : out.outcome === "no_show" ? (
                <div className="space-y-5 rounded-xl bg-surface p-5">
                  <div><p className="text-lg font-semibold tracking-tight">This meeting didn&apos;t take place</p>{out.summary ? <p className="mt-1 text-ink-soft">{out.summary}</p> : null}</div>
                  {canReschedule ? <ActionForm action={A.rescheduleAction.bind(null, id)} className="flex flex-wrap items-end gap-2"><label className="text-sm"><span className="block text-xs text-ink-soft">New date</span><input type="date" name="date" required className="min-h-10 rounded-lg border border-line bg-surface px-2" /></label><label className="text-sm"><span className="block text-xs text-ink-soft">Time</span><input type="time" name="time" defaultValue={startTime} className="min-h-10 rounded-lg border border-line bg-surface px-2" /></label><Submit variant="secondary">Reschedule</Submit></ActionForm> : null}
                  <ActionForm action={A.noShowAction.bind(null, id)} className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
                    <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" name="log" value="1" defaultChecked className="h-4 w-4 accent-brand" /> Note it in the contact history</label>
                    <Submit>Record as not held</Submit>
                  </ActionForm>
                  <ActionForm action={A.discardOutcomeAction.bind(null, id)}><Submit variant="ghost" className="min-h-10 px-0 text-sm text-ink-soft underline underline-offset-4 hover:text-ink">These notes were wrong — clear</Submit></ActionForm>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-start gap-3"><p className="min-w-0 flex-1">{out.summary}</p><Chip tone={out.outcome === "positive" ? "ok" : out.outcome === "negative" ? "bad" : "muted"}>{OUTCOME_LABEL[out.outcome] ?? "Outcome noted"}</Chip></div>
                  {out.requirement_updates.length ? <div><Kicker>Requirement changes</Kicker><p className="text-xs text-ink-soft">Go to Review — nothing is overwritten.</p><ul className="mt-2 space-y-1.5">{(out.requirement_updates as Row[]).map((u, i) => <li key={i} className="flex gap-2.5"><Dot tone="muted" /><span><span className="capitalize">{u.field.replace(/_/g, " ")}</span> → <b>{u.value}</b> <span className="text-sm text-ink-soft">(“{u.quote}”)</span></span></li>)}</ul>{!x.requirement ? <p className="mt-1 text-xs text-warn">No requirement linked — link one in Set up to propose these.</p> : null}</div> : null}
                  {out.commitments.length ? <div><Kicker>Commitments</Kicker><ul className="mt-2 space-y-1.5">{(out.commitments as Row[]).map((c, i) => <li key={i} className="flex gap-2.5"><Dot tone="muted" /><span>{c.who === "us" ? "We" : "They"}: {c.what}{c.due ? ` (by ${c.due})` : ""}</span></li>)}</ul></div> : null}
                  {out.objections.length ? <p><span className="font-medium">Objections:</span> {out.objections.join(" · ")}</p> : null}
                  {out.decision_process ? <p><span className="font-medium">Decision process:</span> {out.decision_process}</p> : null}
                  <ActionForm action={A.applyAction.bind(null, id)} className="space-y-1 rounded-xl bg-surface p-4">
                    <label className="flex min-h-10 items-center gap-2.5"><input type="checkbox" name="interaction" value="1" defaultChecked className="h-4 w-4 accent-brand" /> Save the meeting to history</label>
                    <label className="flex min-h-10 items-center gap-2.5"><input type="checkbox" name="requirement" value="1" defaultChecked className="h-4 w-4 accent-brand" /> Send requirement / deal changes to Review</label>
                    <label className="flex min-h-10 items-center gap-2.5"><input type="checkbox" name="tasks" value="1" defaultChecked className="h-4 w-4 accent-brand" /> Create tasks for our commitments</label>
                    <label className="flex min-h-10 items-center gap-2.5"><input type="checkbox" name="followup" value="1" className="h-4 w-4 accent-brand" /> Draft a follow-up email (in Outreach, for your approval)</label>
                    <div className="pt-2"><Submit>Approve selected</Submit></div>
                  </ActionForm>
                </div>
              )}
            </Section></div>
          ) : null}

          {editor ? (
            <div className="print:hidden"><Section id="manage" title="Manage" help="Meeting setup">
              <div className="border-t border-line">
                <Disclosure title="Set up" meta="purpose, type, deal, properties">
                  <ActionForm action={A.setupAction.bind(null, id)} className="space-y-3">
                    <textarea name="purpose" defaultValue={p.purpose ?? ""} rows={2} placeholder="Why are we meeting?" className={inp} />
                    <select name="type" defaultValue={p.meeting_type} className={inp}>{Object.entries(MEETING_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                    <select name="opportunity_id" defaultValue={p.opportunity_id ?? ""} className={inp}><option value="">No deal</option>{x.opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
                    <select name="requirement_id" defaultValue={p.requirement_id ?? ""} className={inp}><option value="">No requirement</option>{x.requirements.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
                    <select name="asset_id" multiple defaultValue={p.asset_ids ?? []} className={`${inp} h-28`}>{((assets ?? []) as Row[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                    <Submit variant="secondary">Save</Submit>
                  </ActionForm>
                </Disclosure>
                <Disclosure title="Attendees" meta={String(x.attendees.length)}>
                  <ul className="divide-y divide-line text-sm">{x.attendees.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 py-2"><Avatar name={a.name} size="sm" /><span className="min-w-0 flex-1">{a.name}{a.email ? <span className="text-xs text-ink-soft"> {a.email}</span> : null} <span className="text-xs text-ink-soft">({a.match})</span></span>
                      {a.match !== "matched" && a.match !== "manual" ? <ActionForm action={A.resolveAction.bind(null, id, a.id)} className="flex gap-1"><select name="person_id" defaultValue={a.personId ?? ""} className="min-h-10 max-w-44 rounded-lg border border-line bg-surface text-xs"><option value="">Not a saved contact</option>{((people ?? []) as Row[]).map((pp) => <option key={pp.id} value={pp.id}>{pp.full_name}</option>)}</select><Submit variant="ghost" className="min-h-10 px-3 text-xs">Set</Submit></ActionForm> : null}
                    </li>))}</ul>
                  <ActionForm action={A.attendeeAction.bind(null, id)} className="mt-3 flex flex-wrap gap-2"><select name="person_id" className="min-h-10 flex-1 rounded-lg border border-line bg-surface px-2 text-sm"><option value="">Saved contact…</option>{((people ?? []) as Row[]).map((pp) => <option key={pp.id} value={pp.id}>{pp.full_name}</option>)}</select><input name="name" placeholder="or name" className="min-h-10 w-28 rounded-lg border border-line bg-surface px-2 text-sm" /><input name="email" placeholder="email" className="min-h-10 w-36 rounded-lg border border-line bg-surface px-2 text-sm" /><Submit variant="secondary">Add</Submit></ActionForm>
                </Disclosure>
                <Disclosure title="Materials" meta={String(x.materials.length)}>
                  <ul className="space-y-1.5 text-sm">{x.materials.map((mt) => <li key={mt.id}>{mt.url ? <a href={mt.url} target="_blank" rel="noreferrer noopener" className="text-brand underline underline-offset-4">{mt.title}</a> : mt.title} <span className="text-xs text-ink-soft">{mt.internal_only ? "internal only" : "OK to share"}</span></li>)}</ul>
                  <ActionForm action={A.materialAction.bind(null, id)} className="mt-3 space-y-2"><input name="title" placeholder="e.g. Kharadi rent comparison" className={inp} /><input name="url" placeholder="Link (Drive, SharePoint…)" className={inp} /><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" name="shareable" value="1" className="h-4 w-4 accent-brand" /> OK to share with attendees</label><Submit variant="secondary">Add</Submit></ActionForm>
                </Disclosure>
                {b ? <Disclosure title="Edit the brief">
                  <ActionForm action={A.editAction.bind(null, id)} className="space-y-3 text-sm">
                    <label className="block space-y-1"><span className="text-ink-soft">Why we&apos;re meeting</span><textarea name="why" defaultValue={b.purpose.why} rows={2} className={inp} /></label>
                    <label className="block space-y-1"><span className="text-ink-soft">What we want</span><textarea name="we_want" defaultValue={b.purpose.we_want} rows={2} className={inp} /></label>
                    <label className="block space-y-1"><span className="text-ink-soft">Aim for</span><textarea name="ideal" defaultValue={b.outcome.ideal} rows={2} className={inp} /></label>
                    <label className="block space-y-1"><span className="text-ink-soft">My extra questions (one per line)</span><textarea name="extra_questions" defaultValue={(b.questions.custom ?? []).map((q: Row) => q.text).join("\n")} rows={3} className={inp} /></label>
                    <label className="block space-y-1"><span className="text-ink-soft">Avoid (one per line)</span><textarea name="avoid" defaultValue={b.avoid.join("\n")} rows={2} className={inp} /></label>
                    <label className="block space-y-1"><span className="text-ink-soft">Next steps (one per line)</span><textarea name="next_steps" defaultValue={b.next_steps.join("\n")} rows={3} className={inp} /></label>
                    <Submit variant="secondary">Save as new version</Submit>
                  </ActionForm>
                </Disclosure> : null}
                {canReschedule ? <Disclosure title="Reschedule or cancel">
                  <div className="flex flex-wrap items-end gap-3">
                    <ActionForm action={A.rescheduleAction.bind(null, id)} className="flex flex-wrap items-end gap-2"><input type="date" name="date" required aria-label="New date" className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm" /><input type="time" name="time" aria-label="Time" defaultValue={startTime} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm" /><Submit variant="secondary">Reschedule</Submit></ActionForm>
                    <ActionForm action={A.cancelAction.bind(null, id)}><Submit variant="ghost" confirm="Cancel this meeting in CRE OS? Your own calendar won't change.">Cancel meeting</Submit></ActionForm>
                  </div>
                </Disclosure> : null}
              </div>
            </Section></div>
          ) : null}
        </main>

        <aside className="hidden lg:block print:hidden">
          <div className="sticky top-6 space-y-8 pt-4">
            {readiness}
            <div className="border-t border-line pt-6">{facts}</div>
            {sections.length ? <nav aria-label="Brief sections" className="border-t border-line pt-6">
              <Kicker>Contents</Kicker>
              <ol className="mt-2 space-y-0.5 text-sm">{sections.map(([k, label]) => <li key={k}><a href={`#${k}`} className="flex min-h-8 items-center gap-3 rounded px-1 text-ink-soft hover:text-ink"><span className="w-5 text-xs tabular-nums">{num(k)}</span>{label}</a></li>)}</ol>
            </nav> : null}
            <div className="border-t border-line pt-6">{actions}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
