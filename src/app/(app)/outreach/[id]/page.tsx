import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { HelpFor } from "@/components/ui";
import { detail, OutreachError, buildContext } from "@/modules/outreach/service";
import { saveAction, aiAction, requestAction, approveAction, rejectAction, openAction, sentAction, responseAction, pauseAction, resumeAction, prepareAction, closeAction } from "@/modules/outreach/actions";
import { SendPanel } from "@/modules/outreach/ui/send";
import { SCENARIOS, CHANNEL_LABEL, LEVEL_LABEL } from "@/modules/outreach/rules";

export const metadata = { title: "Outreach message" };
type Row = Record<string, any>;
const card = "rounded-2xl border border-line bg-surface p-5 shadow-sm";
const field = "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";
const chip = "min-h-9 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:border-brand/50 hover:bg-brand-soft";
const STEPS = [["draft", "Draft", "✎"], ["pending_approval", "Approval", "☑"], ["approved", "Ready", "✓"], ["sent", "Sent", "➤"], ["replied", "Reply", "↩"]] as const;
const ORDER: Record<string, number> = { planned: -1, draft: 0, pending_approval: 1, approved: 2, sent: 3, no_response: 3, replied: 4, meeting: 4, declined: 4, closed: 4, paused: -1 };
const OPS: [string, string][] = [["shorten", "Shorter"], ["expand", "Longer"], ["professional", "More formal"], ["conversational", "More casual"], ["persuasive", "Clearer value"], ["less_sales", "Less salesy"], ["personalise", "Personalise"], ["trim", "Trim"], ["regenerate", "New version"]];
const daysTo = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 864e5);
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const Icon = ({ c }: { c: string }) => <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">{c}</span>;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  let d; try { d = await detail(ctx.db, ctx.workspaceId, id); } catch (e) { if (e instanceof OutreachError) notFound(); throw e; }
  const { item: it, draft } = d;
  const c = await buildContext(ctx.db, ctx.workspaceId, it.person_id).catch(() => null);
  const st = it.status as string;
  const editable = editor && ["draft", "pending_approval", "approved"].includes(st) && !!draft;
  const s = (it.script ?? {}) as Row;
  const name = d.person?.full_name ?? "—";
  const warnings = [...new Set(((s.warnings ?? []) as Row[]).map((w) => String(w.text)))];
  const relevance = c?.relevance === "high" ? "High relevance" : c?.relevance === "medium" ? "Medium relevance" : null;
  const keyRows: [string, string, string][] = [];
  for (const e of (c?.leaseEvents ?? []).slice(0, 2)) keyRows.push(["📅", e.event_type === "notice_deadline" ? "Notice deadline" : e.event_type === "expiry" ? "Lease expiry" : e.event_type.replace(/_/g, " "), `${e.event_date} (in ${daysTo(e.event_date)} days)${e.confirmed ? "" : " · not confirmed"}`]);
  if (c?.leaseEvents?.[0]?.asset) keyRows.push(["🏢", "Location", c.leaseEvents[0].asset]);
  if (c?.requirement) keyRows.push(["📐", "Requirement", `${c.requirement.area_target_sf ? `~${Number(c.requirement.area_target_sf).toLocaleString("en-IN")} sq ft` : c.requirement.seats_target ? `${c.requirement.seats_target} seats` : c.requirement.title}${c.requirement.status === "draft" ? " (estimated)" : ""}`]);
  if (c?.opportunity) keyRows.push(["💼", "Deal", `${c.opportunity.name} · ${String(c.opportunity.stage).replace(/_/g, " ")}`]);
  if (c?.leadScore != null) keyRows.push(["📈", "Lead score", `${c.leadScore}/100`]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Link href="/outreach?tab=messages" className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">← Outreach</Link>

      {/* Header: who, what, progress */}
      <header className="flex flex-wrap items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-soft text-lg font-semibold text-brand">{initials(name)}</span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
          <p className="text-sm text-ink-soft">{CHANNEL_LABEL[it.channel as keyof typeof CHANNEL_LABEL]} · {SCENARIOS[it.scenario as keyof typeof SCENARIOS].label}{it.step > 1 ? ` · follow-up ${it.step - 1}` : ""}{c ? ` · ${LEVEL_LABEL[c.level]}` : ""}</p>
        </div>
        {c?.org ? <Link href={`/companies/${c.org.id}`} className="rounded-xl border border-line bg-surface px-3 py-1.5 text-sm hover:border-brand/50">🏢 {c.org.display_name}</Link> : null}
        <ol aria-label="Progress" className="ml-auto flex flex-wrap items-center gap-1 text-sm">
          {STEPS.map(([k, l, ic], i) => { const cur = (ORDER[st] ?? 0) === i; const past = i < (ORDER[st] ?? 0); return (
            <li key={k} className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 ${cur ? "bg-brand font-semibold text-white" : past ? "text-ink" : "text-ink-soft"}`}><span aria-hidden>{past ? "✓" : ic}</span>{l}</li>); })}
        </ol>
      </header>

      {st === "paused" ? <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><span aria-hidden>⏸</span><span className="flex-1"><b>Paused:</b> {it.pause_reason}</span>{editor ? <ActionForm action={resumeAction.bind(null, id)}><Submit variant="secondary">Resume</Submit></ActionForm> : null}</div> : null}
      {warnings.length && ["draft", "pending_approval", "approved"].includes(st) ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span aria-hidden>⚠️</span><p className="min-w-0 flex-1"><b>Possible duplicate outreach:</b> {warnings.join(" ")}</p>
          <Link href={`/contacts/${it.person_id}`} className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 font-medium">View history →</Link>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* LEFT: compose */}
        <div className="space-y-5">
          {st === "planned" ? (
            <section className={card}><h2 className="font-semibold">Planned follow-up · {it.planned_on}</h2><p className="mt-1 text-sm text-ink-soft">{it.reason}. It's drafted only when you ask, and pauses itself if they reply, decline or a colleague gets in touch.</p>
              {editor ? <div className="mt-3 flex gap-2"><ActionForm action={prepareAction.bind(null, id)}><Submit>Draft it now</Submit></ActionForm><ActionForm action={pauseAction.bind(null, id)}><input type="hidden" name="reason" value="Not needed" /><Submit variant="secondary">Skip</Submit></ActionForm></div> : null}
            </section>
          ) : null}

          {it.channel === "call" ? (
            <section className={card}>
              <div className="flex items-center gap-3"><Icon c="📞" /><h2 className="flex items-center text-lg font-semibold">Call script<HelpFor k="Call script" /></h2></div>
              {s.call ? <div className="mt-4 space-y-3 text-sm"><p><b>Open:</b> {s.call.opener}</p><p><b>Reason:</b> {s.call.reason}</p><div><b>Ask:</b><ul className="mt-1 list-disc pl-5">{(s.call.questions ?? []).map((q: string, i: number) => <li key={i}>{q}</li>)}</ul></div>
                <div><b>If they say…</b><ul className="mt-1 space-y-1">{(s.call.objections ?? []).map((o: Row, i: number) => <li key={i}><i>“{o.objection}”</i> → {o.reply}</li>)}</ul></div><p><b>Close:</b> {s.call.close}</p></div> : <p className="mt-2 text-sm text-ink-soft">No script.</p>}
              {editor && st !== "sent" ? <ActionForm action={sentAction.bind(null, id)} className="mt-4"><Submit>I made the call</Submit></ActionForm> : null}
            </section>
          ) : draft ? (
            <section className={`${card} space-y-5`}>
              <div className="flex items-center gap-3"><Icon c="✉" /><h2 className="flex items-center text-lg font-semibold">Compose message<HelpFor k="Message" /></h2></div>
              {editable ? (
                <ActionForm key={draft.content_hash} action={saveAction.bind(null, id)} className="space-y-3">
                  <div className="grid items-center gap-x-4 gap-y-3 sm:grid-cols-[72px_1fr]">
                    <label htmlFor="to" className="text-sm text-ink-soft">To</label>
                    <input id="to" name="to" defaultValue={draft.recipient_address ?? ""} placeholder={draft.channel === "whatsapp" ? "+91…" : draft.channel === "linkedin" ? "linkedin.com/in/…" : "name@company.com"} className={field} />
                    {draft.subject !== null || draft.channel === "email" || draft.channel === "introduction" ? <>
                      <label htmlFor="subject" className="text-sm text-ink-soft">Subject</label>
                      <input id="subject" name="subject" defaultValue={draft.subject ?? ""} className={field} />
                    </> : null}
                  </div>
                  <div className="overflow-hidden rounded-xl border border-line focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
                    <textarea name="body" defaultValue={draft.body} rows={draft.channel === "whatsapp" || draft.channel === "linkedin" ? 7 : 13} aria-label="Message text" className="block w-full resize-y bg-surface px-4 py-3 text-[15px] leading-relaxed outline-none" />
                    <div className="flex items-center justify-between border-t border-line bg-canvas px-4 py-2 text-xs text-ink-soft"><span>Plain text — formatting is added by your mail app</span><span className="tabular-nums">{draft.body.length} characters</span></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                    <Submit variant="secondary">💾 Save changes</Submit>
                    <label className="flex items-center gap-2 text-sm text-ink-soft"><input type="checkbox" name="learn" value="1" className="h-4 w-4" /> Use as an example of my style</label>
                  </div>
                  {st !== "draft" ? <p className="text-xs text-amber-800">Saving a change sends it back to draft — approval only covers the exact text and recipient.</p> : null}
                </ActionForm>
              ) : (
                <div className="space-y-1 rounded-xl bg-canvas p-4 text-sm"><p className="text-ink-soft">To: {draft.recipient_address ?? "—"}</p>{draft.subject ? <p className="font-medium">{draft.subject}</p> : null}<p className="whitespace-pre-wrap">{draft.body}</p></div>
              )}
              {s.forwardable ? <div className="rounded-xl bg-canvas p-4 text-sm"><p className="font-medium">Forwardable note for them</p><p className="mt-1 whitespace-pre-wrap">{s.forwardable}</p></div> : null}
            </section>
          ) : null}

          {editable ? (
            <section className="rounded-2xl border border-brand/15 bg-brand-soft/40 p-5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h2 className="flex items-center font-semibold">✨ Rewrite with AI</h2><p className="text-sm text-ink-soft">Each rewrite is saved as a new version — check it before approving.</p></div>
              {/* One form: every chip is a submit button carrying its own op, so the result message sits below the group instead of breaking the row. */}
              <ActionForm action={aiAction.bind(null, id)} className="mt-4">
                <div className="flex flex-wrap items-center gap-2">
                  {OPS.map(([op, l]) => <Submit key={op} variant="ghost" name="op" value={op} className={chip}>{l}</Submit>)}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-brand/10 pt-3">
                  <span className="text-sm text-ink-soft">Language</span>
                  <select name="lang" defaultValue={it.language === "hi" ? "hindi" : it.language === "hinglish" ? "hinglish" : "english"} aria-label="Language" className="min-h-9 rounded-xl border border-line bg-surface px-3 text-sm"><option value="english">English</option><option value="hinglish">Hinglish</option><option value="hindi">Hindi</option></select>
                  <Submit variant="ghost" name="op" value="translate" className={chip}>Translate</Submit>
                </div>
              </ActionForm>
              {(s.openings ?? []).length || (s.ctas ?? []).length ? (
                <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium text-brand">Other openings and calls to action</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">{[...(s.openings ?? []), ...(s.ctas ?? [])].map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></details>
              ) : null}
            </section>
          ) : null}

          {/* Approval / send / reply — one clear next step */}
          {editor && draft && st === "draft" ? (
            <section className={`${card} flex flex-wrap items-center justify-between gap-3`}>
              <p className="flex items-center text-sm text-ink-soft">Save your edits first — approval covers the saved text only.<HelpFor k="Approval" /></p>
              <div className="flex flex-wrap gap-2"><ActionForm action={requestAction.bind(null, id)}><Submit variant="secondary">Ask a colleague</Submit></ActionForm><ActionForm action={approveAction.bind(null, id)}><input type="hidden" name="hash" value={draft.content_hash} /><Submit>✓ Approve this exact text</Submit></ActionForm></div>
            </section>
          ) : null}
          {editor && draft && st === "pending_approval" ? (
            <section className={`${card} space-y-3`}>
              <p className="flex items-center font-semibold">Waiting for approval<HelpFor k="Approval" /></p>
              <div className="flex flex-wrap items-center gap-2"><ActionForm action={approveAction.bind(null, id)}><input type="hidden" name="hash" value={draft.content_hash} /><Submit>✓ Approve this exact text</Submit></ActionForm><ActionForm action={rejectAction.bind(null, id)} className="flex flex-1 gap-2"><input name="note" placeholder="What should change?" className={field} /><Submit variant="secondary">Send back</Submit></ActionForm></div>
            </section>
          ) : null}
          {editor && draft && st === "approved" ? (
            <section className={card}><h2 className="flex items-center font-semibold">Send it yourself<HelpFor k="Send it yourself" /></h2><div className="mt-3"><SendPanel action={openAction.bind(null, id)} sent={sentAction.bind(null, id)} hash={draft.content_hash} to={draft.recipient_address ?? ""} text={draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body} email={["email", "introduction"].includes(draft.channel) ? { subject: draft.subject ?? "", body: draft.body } : undefined} /></div></section>
          ) : null}
          {editor && ["sent", "replied"].includes(st) ? (
            <section className={card}>
              <h2 className="flex items-center font-semibold">Did they reply?<HelpFor k="Did they reply?" /></h2>
              <ActionForm action={responseAction.bind(null, id)} className="mt-3 space-y-3"><textarea name="text" rows={4} placeholder="Paste their reply, or note what they said on the phone" className={field} /><Submit>Save reply</Submit></ActionForm>
              {st === "sent" ? <ActionForm action={closeAction.bind(null, id)} className="mt-3"><input type="hidden" name="outcome" value="no_response" /><Submit variant="ghost">Close — no response</Submit></ActionForm> : null}
            </section>
          ) : null}
          {it.response ? (
            <section className={card}><h2 className="font-semibold">Their reply</h2>
              <p className="mt-2 text-sm"><span className="mr-1 rounded-full bg-canvas px-2 py-0.5 text-xs">{String(it.response.outcome).replace(/_/g, " ")}</span>{it.response.summary}</p>
              {(it.response.commitments ?? []).length ? <ul className="mt-2 list-disc pl-5 text-sm">{(it.response.commitments as Row[]).map((m, i) => <li key={i}>{m.who === "us" ? "We" : "They"}: {m.what}{m.due ? ` (by ${m.due})` : ""}</li>)}</ul> : null}
              <p className="mt-2 text-sm"><b>Next:</b> {it.response.next_action}</p>
            </section>
          ) : null}
          {editor && ["draft", "pending_approval", "approved", "planned"].includes(st) ? (
            <details className="text-sm"><summary className="cursor-pointer text-ink-soft">Pause this message</summary><ActionForm action={pauseAction.bind(null, id)} className="mt-2 flex gap-2"><input name="reason" placeholder="Reason to pause" className={field} /><Submit variant="secondary">Pause</Submit></ActionForm></details>
          ) : null}
        </div>

        {/* RIGHT: context */}
        <aside className="space-y-5">
          <section className={card}>
            <div className="flex items-start justify-between gap-2"><h2 className="flex items-center text-lg font-semibold">⚡ Why now<HelpFor k="Why now" /></h2>{relevance ? <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">{relevance}</span> : null}</div>
            <p className="mt-2 text-sm">{it.reason}.</p>
            {it.value_prop ? <div className="mt-4 flex gap-3 rounded-xl bg-brand-soft p-3 text-sm"><span aria-hidden>🎯</span><div><p className="font-semibold">Value</p><p className="text-ink-soft">{it.value_prop}</p></div></div> : null}
            {keyRows.length ? (
              <div className="mt-5 border-t border-line pt-4">
                <p className="font-semibold">Key context</p>
                <dl className="mt-2 divide-y divide-line text-sm">{keyRows.map(([ic, k, v]) => <div key={k} className="grid grid-cols-[24px_110px_1fr] items-center gap-2 py-2"><span aria-hidden>{ic}</span><dt className="font-medium">{k}</dt><dd className="text-ink-soft">{v}</dd></div>)}</dl>
              </div>
            ) : null}
            {(it.assumptions ?? []).length ? <p className="mt-3 text-xs text-amber-800">Assumed: {(it.assumptions as string[]).join("; ")}</p> : null}
            <div className="mt-3 flex flex-wrap gap-3 text-sm">{it.signal_id ? <Link href={`/signals/${it.signal_id}`} className="text-brand hover:underline">Open the signal →</Link> : null}{it.opportunity_id ? <Link href={`/deals/${it.opportunity_id}`} className="text-brand hover:underline">Open the deal →</Link> : null}</div>
          </section>

          {(it.questions ?? []).length ? (
            <section className={card}><h2 className="flex items-center text-lg font-semibold">❔ Ask them<HelpFor k="Ask them" /></h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm">{(it.questions as string[]).map((q, i) => <li key={i}>{q}</li>)}</ul></section>
          ) : null}

          <section className={card}>
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">🕘 Earlier conversations</h2><Link href={`/contacts/${it.person_id}`} className="text-sm text-brand hover:underline">View all →</Link></div>
            {c?.interactions.length ? (
              <ul className="mt-2 divide-y divide-line">{c.interactions.slice(0, 4).map((x: Row) => (
                <li key={x.id} className="flex gap-3 py-2.5 text-sm"><span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-canvas">{x.channel === "meeting" || x.channel === "visit" ? "📅" : x.channel === "call" ? "📞" : x.channel === "whatsapp" ? "💬" : "✉"}</span>
                  <span className="min-w-0"><span className="block text-xs text-ink-soft">{x.occurred_at.slice(0, 10)} · <span className="capitalize">{x.channel}</span>{x.direction === "inbound" ? " · from them" : ""}</span><span className="block truncate">{x.summary ?? x.subject ?? "—"}</span></span></li>))}</ul>
            ) : <p className="mt-2 text-sm text-ink-soft">No previous conversations — this is a first contact.</p>}
          </section>

          {d.siblings.length ? (
            <section className={card}><h2 className="font-semibold">Same conversation</h2><ul className="mt-2 space-y-1 text-sm">{(d.siblings as Row[]).map((x) => <li key={x.id}><Link href={`/outreach/${x.id}`} className="hover:text-brand">Step {x.step} · {CHANNEL_LABEL[x.channel as keyof typeof CHANNEL_LABEL]} · {x.status.replace("_", " ")}{x.planned_on && x.status === "planned" ? ` · ${x.planned_on}` : ""}</Link></li>)}</ul></section>
          ) : null}

          <details className={card}>
            <summary className="flex cursor-pointer items-center justify-between text-lg font-semibold">🗂 History ({d.events.length})<span className="text-sm text-ink-soft">▾</span></summary>
            <ul className="mt-3 space-y-1 text-xs">{(d.events as Row[]).map((e, i) => <li key={i}><span className="text-ink-soft">{new Date(e.created_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</span> {e.event.replace(/_/g, " ")}{e.detail?.reason ? ` — ${e.detail.reason}` : ""}</li>)}</ul>
            <p className="mt-3 text-sm font-medium">Versions</p><ul className="mt-1 space-y-1 text-xs">{(d.versions as Row[]).map((v) => <li key={v.version}>v{v.version} · {v.kind.replace("_", " ")}{v.op ? ` (${v.op})` : ""}{v.learn ? " · style example" : ""}</li>)}</ul>
          </details>
        </aside>
      </div>
    </div>
  );
}
