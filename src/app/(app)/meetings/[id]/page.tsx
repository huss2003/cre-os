import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { HelpFor } from "@/components/ui";
import { gather, assessReadiness, MeetingError, type Item } from "@/modules/meetings/service";
import { MEETING_TYPES, SITE_VISIT } from "@/modules/meetings/rules";
import * as A from "@/modules/meetings/actions";

export const metadata = { title: "Meeting brief" };
type Row = Record<string, any>;
const box = "rounded-2xl border border-line bg-surface p-5";
const inp = "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm";
const KIND: Record<string, [string, string]> = { fact: ["Confirmed", "bg-emerald-50 text-emerald-800"], history: ["Historical", "bg-slate-100 text-slate-700"], inference: ["Not confirmed", "bg-amber-50 text-amber-800"], unknown: ["Unknown", "bg-slate-50 text-slate-500"], suggestion: ["Suggestion", "bg-violet-50 text-violet-800"] };
const Tag = ({ k }: { k: string }) => <span className={`ml-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium ${KIND[k]?.[1] ?? ""}`}>{KIND[k]?.[0] ?? k}</span>;
const ROLE: Record<string, string> = { decision_maker: "Decision-maker", economic_buyer: "Economic buyer", influencer: "Influencer", technical_evaluator: "Evaluator", operational: "Operational", gatekeeper: "Gatekeeper", procurement: "Procurement", administrative: "Administrative", unknown: "Role unknown" };
const H = ({ t, n }: { t: string; n?: string }) => <h2 className="flex items-center text-base font-semibold">{n ? <span className="mr-2 text-xs font-normal text-ink-soft">{n}</span> : null}{t}<HelpFor k={t} /></h2>;

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
  return (
    <div className="mx-auto max-w-5xl space-y-5 print:max-w-none">
      <Link href="/meetings" className="text-sm text-ink-soft hover:text-ink print:hidden">← Meetings</Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{m.title}</h1>
          <p className="text-sm text-ink-soft">{t.label} · {new Date(m.start_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}{m.location ? ` · ${m.location}` : ""}{x.org ? <> · <Link className="underline" href={`/companies/${x.org.id}`}>{x.org.display_name}</Link></> : ""}</p>
          {p.source !== "manual" ? <p className="text-xs text-ink-soft">From {p.source === "calendar" ? "your connected calendar" : "an imported .ics file"}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          {b ? <Link href={`/meetings/${id}/live`} className="inline-flex min-h-10 items-center rounded-xl bg-ink px-4 text-sm font-semibold text-white">Meeting mode</Link> : null}
          {editor && !cancelled ? <ActionForm action={A.briefAction.bind(null, id)}><Submit variant={b ? "secondary" : "primary"}>{b ? "Regenerate" : "Prepare brief"}</Submit></ActionForm> : null}
          {editor && b && p.status === "brief_ready" ? <ActionForm action={A.reviewAction.bind(null, id)}><Submit variant="secondary">Mark reviewed</Submit></ActionForm> : null}
          {b ? <a href={`/api/v1/meetings/${id}/brief`} className="inline-flex min-h-10 items-center rounded-xl border border-line px-4 text-sm">Export</a> : null}
        </div>
      </header>
      {cancelled ? <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">This meeting is cancelled.</p> : null}
      {p.status === "rescheduled" ? <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Rescheduled — regenerate the brief so dates and reminders are current.</p> : null}
      {p.brief_error ? <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">Last preparation failed: {p.brief_error}. Press Regenerate to retry — earlier versions are kept.</p> : null}

      <section className={`${box} flex flex-wrap items-center gap-5`}>
        <div className="text-center"><p className="text-4xl font-bold tabular-nums">{score}</p><p className="text-xs text-ink-soft">readiness /100</p></div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="flex items-center font-semibold">Meeting readiness<HelpFor k="Meeting readiness" /></p>
          {rd.critical?.length ? <p className="text-rose-700">Critical: {rd.critical.join(" · ")}</p> : null}
          {rd.missing?.length ? <p className="text-ink-soft">Missing: {rd.missing.join(" · ")}</p> : <p className="text-emerald-700">Well prepared.</p>}
          <p className="mt-1 text-xs text-ink-soft">Status: {p.status.replace(/_/g, " ")}{b ? ` · brief v${p.brief_version}${p.reviewed_at ? " · reviewed" : ""}${String(p.brief_model ?? "").startsWith("mock:") ? " · rule-based wording (AI off)" : ""}` : ""}</p>
        </div>
      </section>

      {!b ? (
        <section className={box}><p className="font-semibold">No brief yet</p><p className="mt-1 text-sm text-ink-soft">Press <b>Prepare brief</b>. It pulls the company, attendees, signals, previous conversations and the deal from your records — usually under a minute.</p></section>
      ) : (
        <>
          <section className={box}><H t="Meeting purpose" n="1" />
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-ink-soft">Why we're meeting</dt><dd>{b.purpose.why}</dd></div>
              <div><dt className="text-ink-soft">What triggered it</dt><dd>{b.purpose.trigger}</dd></div>
              <div><dt className="text-ink-soft">What they may want <Tag k="inference" /></dt><dd>{b.purpose.they_may_want}</dd></div>
              <div><dt className="text-ink-soft">What we want</dt><dd>{b.purpose.we_want}</dd></div>
            </dl>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className={box}><H t="Company" n="2" />
              <ul className="mt-3 space-y-2 text-sm">{(b.company.items as Item[]).map((c, i) => <li key={i}>{c.changed ? <span className="mr-1 rounded bg-brand px-1 text-[10px] text-white">New</span> : null}{c.text}<Tag k={c.kind} /></li>)}{!b.company.items.length ? <li className="text-ink-soft">Nothing on record.</li> : null}</ul>
              {b.company.unknowns.length ? <p className="mt-2 text-sm text-ink-soft">Unknown: {b.company.unknowns.join(", ")}</p> : null}
              {b.company.scores?.lead !== null && b.company.scores?.lead !== undefined ? <p className="mt-2 text-xs text-ink-soft">Lead score {b.company.scores.lead}/100{b.company.scores.opportunity !== null ? ` · deal score ${b.company.scores.opportunity}/100` : ""}</p> : null}
            </section>
            <section className={box}><H t="Attendees" n="3" />
              <ul className="mt-3 space-y-3 text-sm">{(b.attendees as Row[]).map((a) => (
                <li key={a.id} className="rounded-xl bg-canvas p-3">
                  <p className="font-medium">{a.personId ? <Link href={`/contacts/${a.personId}`} className="hover:text-brand">{a.name}</Link> : a.name} <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs">{ROLE[a.role] ?? a.role}</span></p>
                  <p className="text-xs text-ink-soft">{a.title ?? "Title unknown"}{a.company ? ` · ${a.company}` : ""}{a.relevance ? ` · CRE relevance ${a.relevance}` : ""}{a.stakeholderRole ? ` · stakeholder: ${a.stakeholderRole}` : ""}</p>
                  {a.why_matters ? <p className="mt-1">{a.why_matters}</p> : null}
                  <p className="mt-1 text-xs text-ink-soft">{a.interactions ? `${a.interactions} past interaction(s), last ${a.lastInteraction}` : "No previous interaction"}{a.channels.length ? ` · ${a.channels.join(" · ")}` : ""}{a.previous.length ? ` · before: ${a.previous.join("; ")}` : ""}</p>
                  {a.match !== "matched" && a.match !== "manual" ? <p className="mt-1 text-xs text-amber-800">{a.matchReason}</p> : null}
                </li>))}</ul>
            </section>
          </div>

          {b.opportunity ? <section className={box}><H t="Opportunity" n="4" />
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              {b.opportunity.requirement ? <>
                <p><span className="text-ink-soft">Requirement:</span> {b.opportunity.requirement.title} ({b.opportunity.requirement.status})</p>
                <p><span className="text-ink-soft">Seats / area:</span> {b.opportunity.requirement.seats ?? "?"} / {b.opportunity.requirement.area ?? "?"} sq ft</p>
                <p><span className="text-ink-soft">Budget:</span> {b.opportunity.requirement.budget ?? <i>unknown</i>}</p>
                <p><span className="text-ink-soft">Move-in:</span> {b.opportunity.requirement.move_in ?? <i>unknown</i>}</p>
              </> : <p className="text-ink-soft">No requirement on record.</p>}
              <p><span className="text-ink-soft">Stage:</span> {b.opportunity.stage?.replace(/_/g, " ") ?? "—"}</p>
              <p><span className="text-ink-soft">Risks:</span> {b.opportunity.risks ?? "—"}</p>
            </div>
          </section> : null}

          <section className={box}><H t="Previous discussions" n="5" />
            {b.history.first ? <p className="mt-2 rounded-xl bg-canvas px-3 py-2 text-sm">First interaction — nothing on record with this company or these people.</p> : (
              <ol className="mt-3 space-y-1.5 border-l-2 border-line pl-4 text-sm">{(b.history.items as Item[]).map((h, i) => <li key={i}>{h.text}</li>)}</ol>)}
            {b.history.commitments.length ? <div className="mt-3 text-sm"><p className="font-medium">Commitments on record</p><ul className="list-disc pl-5">{(b.history.commitments as Row[]).map((c, i) => <li key={i}>{c.text} <span className="text-ink-soft">({c.date})</span></li>)}</ul></div> : null}
            {b.history.objections.length ? <div className="mt-2 text-sm"><p className="font-medium">Objections they raised</p><ul className="list-disc pl-5">{(b.history.objections as Row[]).map((c, i) => <li key={i}>{c.text} <span className="text-ink-soft">({c.date})</span></li>)}</ul></div> : null}
            {b.history.open_tasks.length ? <p className="mt-2 text-sm"><span className="font-medium">Open tasks:</span> {(b.history.open_tasks as Row[]).map((tk) => tk.title).join(" · ")}</p> : null}
            {b.history.outreach.length ? <p className="mt-2 text-sm"><span className="font-medium">Outreach:</span> {(b.history.outreach as Row[]).map((o) => `${o.channel} ${o.status}${o.reply ? ` — "${o.reply.slice(0, 80)}"` : ""}`).join(" · ")}</p> : null}
          </section>

          <section className={box}><H t="Meeting strategy" n="6" />
            <ol className="mt-3 space-y-3 text-sm">{(b.strategy as Row[]).map((s, i) => <li key={i}><p className="font-medium capitalize">{s.stage}: <span className="font-normal normal-case">{s.point}</span><Tag k="suggestion" /></p><p className="text-xs text-ink-soft">Why: {s.why} · Find out: {s.obtain} · Aim: {s.outcome}</p></li>)}</ol>
            {b.avoid.length ? <p className="mt-3 text-sm"><span className="font-medium">Avoid:</span> {b.avoid.join(" · ")}</p> : null}
          </section>

          <section className={box}><H t="Questions to ask" n="7" />
            <p className="mt-2 text-xs font-semibold uppercase text-ink-soft">Essential</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">{(b.questions.essential as Row[]).map((q) => <li key={q.key}>{q.text}</li>)}</ol>
            <p className="mt-3 text-xs font-semibold uppercase text-ink-soft">If there's time</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">{(b.questions.additional as Row[]).map((q) => <li key={q.key} className={q.answered ? "text-ink-soft" : ""}>{q.text}{q.answered ? <span className="ml-1 text-xs">— already known: {q.answered}</span> : null}</li>)}</ul>
            {b.questions.strategic.length ? <><p className="mt-3 text-xs font-semibold uppercase text-ink-soft">Strategic</p><ul className="list-disc space-y-1 pl-5 text-sm">{(b.questions.strategic as Row[]).map((q) => <li key={q.key}>{q.text}</li>)}</ul></> : null}
            {(b.questions.custom ?? []).length ? <><p className="mt-3 text-xs font-semibold uppercase text-ink-soft">Your questions</p><ul className="list-disc space-y-1 pl-5 text-sm">{(b.questions.custom as Row[]).map((q, i) => <li key={i}>{q.text}</li>)}</ul></> : null}
          </section>

          <section className={box}><H t="Possible objections" n="8" />
            <p className="mt-1 text-xs text-ink-soft">Anticipated — not things anyone has said.</p>
            <ul className="mt-3 space-y-3 text-sm">{(b.objections as Row[]).map((o, i) => <li key={i}><p className="font-medium">“{o.objection}”</p><p className="text-ink-soft">May mean: {o.meaning}</p><p>Respond: {o.response}</p><p>Ask: {o.follow_up}</p><p className="text-xs text-ink-soft">Have ready: {o.evidence}</p></li>)}</ul>
          </section>

          {b.properties?.length ? <section className={box}><H t="Properties" n="9" />
            <ul className="mt-3 space-y-4 text-sm">{(b.properties as Row[]).map((pp) => (
              <li key={pp.id} className="rounded-xl bg-canvas p-3">
                <p className="font-medium">{pp.name} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${pp.verified ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{pp.verified ? "Availability verified" : "Availability not verified"}</span></p>
                <p className="text-xs text-ink-soft">{[pp.developer, pp.location, pp.grade && `Grade ${pp.grade}`, pp.floors && `${pp.floors} floors`].filter(Boolean).join(" · ")}</p>
                {pp.spaces.length ? <ul className="mt-1 text-xs">{(pp.spaces as Row[]).map((s, i) => <li key={i}>{s.floor ?? "Floor ?"} · {s.area ?? "?"} sq ft · {s.config ?? "?"} · {s.status}{s.from ? ` from ${s.from}` : ""}{s.rent ? ` · ${s.rent}` : ""} <span className="text-ink-soft">(as of {s.asOf})</span></li>)}</ul> : null}
                {pp.match.length ? <p className="mt-1 text-emerald-800">Fits: {pp.match.join(" · ")}</p> : null}
                {pp.mismatch.length ? <p className="text-rose-700">Doesn't fit: {pp.mismatch.join(" · ")}</p> : null}
                {pp.missing.length ? <p className="text-ink-soft">Unknown: {pp.missing.join(" · ")}</p> : null}
                <p className="text-xs">Verify: {pp.verify.join(" · ")}</p>
              </li>))}</ul>
          </section> : null}

          <section className={box}><H t="Desired outcome" n="10" />
            <p className="mt-2 text-sm"><b>Aim for:</b> {b.outcome.ideal}</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">{(b.outcome.acceptable as string[]).map((a, i) => <li key={i}>Also fine: {a}</li>)}</ul>
            <p className="mt-3 text-sm font-medium">After the meeting</p>
            <ul className="list-disc pl-5 text-sm">{(b.next_steps as string[]).map((s, i) => <li key={i}>{s}</li>)}</ul>
          </section>
        </>
      )}

      {p.meeting_type === "site_visit" ? (
        <section className={`${box} print:hidden`}><H t="Site visit checklist" />
          <div className="mt-3 grid gap-4 md:grid-cols-3">{(["before", "during", "after"] as const).map((ph) => (
            <div key={ph}><p className="text-xs font-semibold uppercase text-ink-soft">{ph === "before" ? "Before" : ph === "during" ? "During" : "After"}</p>
              <ul className="mt-1 space-y-1">{SITE_VISIT[ph].map((c) => { const on = !!p.checklist?.[c.key]; return <li key={c.key}>{editor ? <ActionForm action={A.checkAction.bind(null, id, c.key, !on)}><button className="flex min-h-9 w-full items-center gap-2 rounded-lg px-1 text-left text-sm hover:bg-canvas"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "border-brand bg-brand text-white" : "border-line"}`}>{on ? "✓" : ""}</span><span className={on ? "text-ink-soft line-through" : ""}>{c.label}</span></button></ActionForm> : <span>{on ? "✓ " : "○ "}{c.label}</span>}</li>; })}</ul>
            </div>))}</div>
        </section>
      ) : null}

      {editor ? (
        <div className="grid gap-5 lg:grid-cols-2 print:hidden">
          <details className={box}><summary className="cursor-pointer font-semibold">Set up: purpose, type, deal, properties</summary>
            <ActionForm action={A.setupAction.bind(null, id)} className="mt-3 space-y-3">
              <textarea name="purpose" defaultValue={p.purpose ?? ""} rows={2} placeholder="Why are we meeting?" className={inp} />
              <select name="type" defaultValue={p.meeting_type} className={inp}>{Object.entries(MEETING_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              <select name="opportunity_id" defaultValue={p.opportunity_id ?? ""} className={inp}><option value="">No deal</option>{x.opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
              <select name="requirement_id" defaultValue={p.requirement_id ?? ""} className={inp}><option value="">No requirement</option>{x.requirements.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
              <select name="asset_id" multiple defaultValue={p.asset_ids ?? []} className={`${inp} h-24`}>{((assets ?? []) as Row[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              <Submit variant="secondary">Save</Submit>
            </ActionForm>
          </details>
          <details className={box}><summary className="cursor-pointer font-semibold">Attendees ({x.attendees.length})</summary>
            <ul className="mt-3 space-y-2 text-sm">{x.attendees.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1">{a.name}{a.email ? <span className="text-xs text-ink-soft"> {a.email}</span> : null} <span className="text-xs text-ink-soft">({a.match})</span></span>
                {a.match !== "matched" && a.match !== "manual" ? <ActionForm action={A.resolveAction.bind(null, id, a.id)} className="flex gap-1"><select name="person_id" defaultValue={a.personId ?? ""} className="min-h-9 max-w-44 rounded-lg border border-line text-xs"><option value="">Not a saved contact</option>{((people ?? []) as Row[]).map((pp) => <option key={pp.id} value={pp.id}>{pp.full_name}</option>)}</select><Submit variant="ghost" className="min-h-9 px-2 text-xs">Set</Submit></ActionForm> : null}
              </li>))}</ul>
            <ActionForm action={A.attendeeAction.bind(null, id)} className="mt-3 flex flex-wrap gap-2"><select name="person_id" className="min-h-10 flex-1 rounded-xl border border-line px-2 text-sm"><option value="">Saved contact…</option>{((people ?? []) as Row[]).map((pp) => <option key={pp.id} value={pp.id}>{pp.full_name}</option>)}</select><input name="name" placeholder="or name" className="min-h-10 w-28 rounded-xl border border-line px-2 text-sm" /><input name="email" placeholder="email" className="min-h-10 w-36 rounded-xl border border-line px-2 text-sm" /><Submit variant="secondary">Add</Submit></ActionForm>
          </details>
          <details className={box}><summary className="cursor-pointer font-semibold">Materials ({x.materials.length})</summary>
            <ul className="mt-3 space-y-1 text-sm">{x.materials.map((mt) => <li key={mt.id}>{mt.url ? <a href={mt.url} target="_blank" rel="noreferrer noopener" className="text-brand underline">{mt.title}</a> : mt.title} <span className="text-xs text-ink-soft">{mt.internal_only ? "internal only" : "OK to share"}</span></li>)}</ul>
            <ActionForm action={A.materialAction.bind(null, id)} className="mt-3 space-y-2"><input name="title" placeholder="e.g. Kharadi rent comparison" className={inp} /><input name="url" placeholder="Link (Drive, SharePoint…)" className={inp} /><label className="flex items-center gap-2 text-xs"><input type="checkbox" name="shareable" value="1" /> OK to share with attendees</label><Submit variant="secondary">Add</Submit></ActionForm>
          </details>
          {b ? <details className={box}><summary className="cursor-pointer font-semibold">Edit the brief</summary>
            <ActionForm action={A.editAction.bind(null, id)} className="mt-3 space-y-2 text-sm">
              <label className="block">Why we're meeting<textarea name="why" defaultValue={b.purpose.why} rows={2} className={inp} /></label>
              <label className="block">What we want<textarea name="we_want" defaultValue={b.purpose.we_want} rows={2} className={inp} /></label>
              <label className="block">Aim for<textarea name="ideal" defaultValue={b.outcome.ideal} rows={2} className={inp} /></label>
              <label className="block">My extra questions (one per line)<textarea name="extra_questions" defaultValue={(b.questions.custom ?? []).map((q: Row) => q.text).join("\n")} rows={3} className={inp} /></label>
              <label className="block">Avoid (one per line)<textarea name="avoid" defaultValue={b.avoid.join("\n")} rows={2} className={inp} /></label>
              <label className="block">Next steps (one per line)<textarea name="next_steps" defaultValue={b.next_steps.join("\n")} rows={3} className={inp} /></label>
              <Submit variant="secondary">Save as new version</Submit>
            </ActionForm>
          </details> : null}
        </div>
      ) : null}

      {editor && b && !cancelled ? (
        <section id="after" className={`${box} print:hidden`}><H t="After the meeting" />
          {!out ? (
            <ActionForm action={A.structureAction.bind(null, id)} className="mt-3 space-y-2"><textarea name="text" rows={4} placeholder="What happened? Area, budget, dates, who decides, objections, what you promised… (notes from Meeting mode are included)" className={inp} /><Submit>Structure my notes</Submit></ActionForm>
          ) : p.outcome?.applied ? (
            <p className="mt-2 text-sm">Applied {new Date(p.outcome.applied.at).toLocaleString("en-IN")}: {p.outcome.applied.proposals} update(s) to Review, {p.outcome.applied.tasks} task(s). <Link href="/approvals" className="text-brand underline">Open Review</Link></p>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              <p>{out.summary} <span className="rounded-full bg-canvas px-2 py-0.5 text-xs">{out.outcome}</span></p>
              {out.requirement_updates.length ? <div><p className="font-medium">Requirement changes (go to Review — nothing is overwritten)</p><ul className="list-disc pl-5">{(out.requirement_updates as Row[]).map((u, i) => <li key={i}>{u.field.replace(/_/g, " ")} → <b>{u.value}</b> <span className="text-ink-soft">(“{u.quote}”)</span></li>)}</ul>{!x.requirement ? <p className="text-xs text-amber-800">No requirement linked — link one in Set up to propose these.</p> : null}</div> : null}
              {out.commitments.length ? <div><p className="font-medium">Commitments</p><ul className="list-disc pl-5">{(out.commitments as Row[]).map((c, i) => <li key={i}>{c.who === "us" ? "We" : "They"}: {c.what}{c.due ? ` (by ${c.due})` : ""}</li>)}</ul></div> : null}
              {out.objections.length ? <p><span className="font-medium">Objections:</span> {out.objections.join(" · ")}</p> : null}
              {out.decision_process ? <p><span className="font-medium">Decision process:</span> {out.decision_process}</p> : null}
              <ActionForm action={A.applyAction.bind(null, id)} className="space-y-1.5 rounded-xl bg-canvas p-3">
                <label className="flex items-center gap-2"><input type="checkbox" name="interaction" value="1" defaultChecked /> Save the meeting to history</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="requirement" value="1" defaultChecked /> Send requirement / deal changes to Review</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="tasks" value="1" defaultChecked /> Create tasks for our commitments</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="followup" value="1" /> Draft a follow-up email (in Outreach, for your approval)</label>
                <Submit>Approve selected</Submit>
              </ActionForm>
            </div>
          )}
        </section>
      ) : null}

      {editor && !cancelled && p.status !== "completed" ? (
        <div className="flex flex-wrap items-end gap-3 print:hidden">
          <ActionForm action={A.rescheduleAction.bind(null, id)} className="flex flex-wrap items-end gap-2"><input type="date" name="date" required className="min-h-10 rounded-xl border border-line px-2 text-sm" /><input type="time" name="time" defaultValue={new Date(m.start_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} className="min-h-10 rounded-xl border border-line px-2 text-sm" /><Submit variant="secondary">Reschedule</Submit></ActionForm>
          <ActionForm action={A.cancelAction.bind(null, id)}><Submit variant="ghost" confirm="Cancel this meeting in CRE OS? Your own calendar won't change.">Cancel meeting</Submit></ActionForm>
        </div>
      ) : null}
    </div>
  );
}
