import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { HelpFor } from "@/components/ui";
import { detail, OutreachError, AI_OPS, buildContext } from "@/modules/outreach/service";
import { saveAction, aiAction, requestAction, approveAction, rejectAction, openAction, sentAction, responseAction, pauseAction, resumeAction, prepareAction, closeAction } from "@/modules/outreach/actions";
import { SendPanel } from "@/modules/outreach/ui/send";
import { SCENARIOS, CHANNEL_LABEL, LEVEL_LABEL } from "@/modules/outreach/rules";

export const metadata = { title: "Outreach message" };
type Row = Record<string, any>;
const box = "rounded-2xl border border-line bg-surface p-5";
const inp = "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm";
const STEPS = [["draft", "Draft"], ["pending_approval", "Approval"], ["approved", "Ready"], ["sent", "Sent"], ["replied", "Reply"]] as const;
const ORDER: Record<string, number> = { planned: -1, draft: 0, pending_approval: 1, approved: 2, sent: 3, replied: 4, meeting: 4, declined: 4, no_response: 3, closed: 4 };
const OPS = ["shorten", "expand", "professional", "conversational", "persuasive", "less_sales", "personalise", "trim", "regenerate", "hinglish", "hindi", "english"];
const OPL: Record<string, string> = { shorten: "Shorter", expand: "Longer", professional: "More formal", conversational: "More casual", persuasive: "Clearer value", less_sales: "Less salesy", personalise: "Personalise", trim: "Trim", regenerate: "New version", hinglish: "Hinglish", hindi: "Hindi", english: "English" };

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
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/outreach?tab=messages" className="text-sm text-ink-soft hover:text-ink">← Outreach</Link>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{d.person?.full_name}</h1>
          <p className="text-sm text-ink-soft">{CHANNEL_LABEL[it.channel as keyof typeof CHANNEL_LABEL]} · {SCENARIOS[it.scenario as keyof typeof SCENARIOS].label}{it.step > 1 ? ` · follow-up ${it.step - 1}` : ""}{c ? ` · ${LEVEL_LABEL[c.level]}` : ""}</p>
        </div>
        <ol className="flex gap-1 text-xs" aria-label="Progress">{STEPS.map(([k, l], i) => <li key={k} className={`rounded-full px-2.5 py-1 ${i <= (ORDER[st] ?? 0) ? "bg-ink text-white" : "bg-canvas text-ink-soft"}`}>{l}</li>)}</ol>
      </header>
      {st === "paused" ? <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><span className="flex-1">Paused: {it.pause_reason}</span>{editor ? <ActionForm action={resumeAction.bind(null, id)}><Submit variant="secondary">Resume</Submit></ActionForm> : null}</div> : null}
      {(s.warnings ?? []).length && ["draft", "pending_approval"].includes(st) ? <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><b>Possible duplicate outreach:</b> {(s.warnings as Row[]).map((w) => w.text).join(" ")}</div> : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          {st === "planned" ? (
            <section className={box}><h2 className="font-semibold">Planned follow-up · {it.planned_on}</h2><p className="mt-1 text-sm text-ink-soft">{it.reason}. It is only drafted when you ask, and it pauses automatically if they reply, decline or a colleague gets in touch.</p>
              {editor ? <div className="mt-3 flex gap-2"><ActionForm action={prepareAction.bind(null, id)}><Submit>Draft it now</Submit></ActionForm><ActionForm action={pauseAction.bind(null, id)}><input type="hidden" name="reason" value="Not needed" /><Submit variant="secondary">Skip</Submit></ActionForm></div> : null}
            </section>
          ) : null}

          {it.channel === "call" ? (
            <section className={box}><h2 className="flex items-center font-semibold">Call script<HelpFor k="Call script" /></h2>
              {s.call ? <div className="mt-3 space-y-3 text-sm"><p><b>Open:</b> {s.call.opener}</p><p><b>Reason:</b> {s.call.reason}</p><div><b>Ask:</b><ul className="mt-1 list-disc pl-5">{(s.call.questions ?? []).map((q: string, i: number) => <li key={i}>{q}</li>)}</ul></div>
                <div><b>If they say…</b><ul className="mt-1 space-y-1">{(s.call.objections ?? []).map((o: Row, i: number) => <li key={i}><i>“{o.objection}”</i> → {o.reply}</li>)}</ul></div><p><b>Close:</b> {s.call.close}</p></div> : <p className="text-sm text-ink-soft">No script.</p>}
              {editor && st !== "sent" ? <ActionForm action={sentAction.bind(null, id)} className="mt-4"><Submit>I made the call</Submit></ActionForm> : null}
            </section>
          ) : draft ? (
            <section className={box}>
              <h2 className="flex items-center font-semibold">Message<HelpFor k="Message" /></h2>
              {editable ? (
                <ActionForm action={saveAction.bind(null, id)} className="mt-3 space-y-3">
                  <label className="block text-xs text-ink-soft">To<input name="to" defaultValue={draft.recipient_address ?? ""} placeholder={draft.channel === "whatsapp" ? "+91…" : draft.channel === "linkedin" ? "linkedin.com/in/…" : "email"} className={`${inp} mt-1`} /></label>
                  {draft.subject !== null || draft.channel === "email" || draft.channel === "introduction" ? <label className="block text-xs text-ink-soft">Subject<input name="subject" defaultValue={draft.subject ?? ""} className={`${inp} mt-1`} /></label> : null}
                  <textarea name="body" defaultValue={draft.body} rows={draft.channel === "whatsapp" || draft.channel === "linkedin" ? 5 : 11} className={`${inp} font-[inherit] leading-relaxed`} aria-label="Message text" />
                  <div className="flex flex-wrap items-center gap-3"><Submit variant="secondary">Save changes</Submit><label className="flex items-center gap-1.5 text-xs text-ink-soft"><input type="checkbox" name="learn" value="1" /> Use as an example of my style</label></div>
                  {st !== "draft" ? <p className="text-xs text-amber-800">Saving a change sends it back to draft — approval only covers the exact text and recipient.</p> : null}
                </ActionForm>
              ) : (
                <div className="mt-3 space-y-1 text-sm"><p className="text-ink-soft">To: {draft.recipient_address ?? "—"}</p>{draft.subject ? <p className="font-medium">{draft.subject}</p> : null}<p className="whitespace-pre-wrap">{draft.body}</p></div>
              )}
              {editable ? (
                <details className="mt-4 rounded-xl bg-canvas p-3">
                  <summary className="cursor-pointer text-sm font-medium">Rewrite with AI</summary>
                  <div className="mt-3 flex flex-wrap gap-2">{OPS.map((op) => <ActionForm key={op} action={aiAction.bind(null, id)}><input type="hidden" name="op" value={op} /><Submit variant="ghost" className="min-h-8 px-3 text-xs">{OPL[op]}</Submit></ActionForm>)}</div>
                  {(s.openings ?? []).length ? <div className="mt-3 text-xs"><p className="font-medium">Other openings</p><ul className="list-disc pl-5 text-ink-soft">{(s.openings as string[]).map((o, i) => <li key={i}>{o}</li>)}</ul></div> : null}
                  {(s.ctas ?? []).length ? <div className="mt-2 text-xs"><p className="font-medium">Other calls to action</p><ul className="list-disc pl-5 text-ink-soft">{(s.ctas as string[]).map((o, i) => <li key={i}>{o}</li>)}</ul></div> : null}
                  <p className="mt-2 text-[11px] text-ink-soft">{Object.keys(AI_OPS).length} rewrite options. Every rewrite is saved as a new version.</p>
                </details>
              ) : null}
              {s.forwardable ? <div className="mt-4 rounded-xl bg-canvas p-3 text-sm"><p className="font-medium">Forwardable note for them</p><p className="mt-1 whitespace-pre-wrap">{s.forwardable}</p></div> : null}
            </section>
          ) : null}

          {editor && draft ? (
            st === "draft" ? <section className={box}><h2 className="flex items-center font-semibold">Approval<HelpFor k="Approval" /></h2><div className="mt-3 flex flex-wrap gap-2"><ActionForm action={requestAction.bind(null, id)}><Submit variant="secondary">Ask for approval</Submit></ActionForm><ActionForm action={approveAction.bind(null, id)}><input type="hidden" name="hash" value={draft.content_hash} /><Submit>Approve this exact text</Submit></ActionForm></div></section>
            : st === "pending_approval" ? <section className={box}><h2 className="flex items-center font-semibold">Approval<HelpFor k="Approval" /></h2><div className="mt-3 flex flex-wrap items-end gap-2"><ActionForm action={approveAction.bind(null, id)}><input type="hidden" name="hash" value={draft.content_hash} /><Submit>Approve this exact text</Submit></ActionForm><ActionForm action={rejectAction.bind(null, id)} className="flex gap-2"><input name="note" placeholder="What to change" className={inp} /><Submit variant="secondary">Send back</Submit></ActionForm></div></section>
            : st === "approved" ? <section className={box}><h2 className="flex items-center font-semibold">Send it yourself<HelpFor k="Send it yourself" /></h2><div className="mt-3"><SendPanel action={openAction.bind(null, id)} sent={sentAction.bind(null, id)} hash={draft.content_hash} to={draft.recipient_address ?? ""} text={draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body} email={["email", "introduction"].includes(draft.channel) ? { subject: draft.subject ?? "", body: draft.body } : undefined} /></div></section>
            : null
          ) : null}

          {editor && ["sent", "replied"].includes(st) ? (
            <section className={box}>
              <h2 className="flex items-center font-semibold">Did they reply?<HelpFor k="Did they reply?" /></h2>
              <ActionForm action={responseAction.bind(null, id)} className="mt-3 space-y-3"><textarea name="text" rows={4} placeholder="Paste their reply, or note what they said on the phone" className={inp} /><Submit>Save reply</Submit></ActionForm>
              {st === "sent" ? <ActionForm action={closeAction.bind(null, id)} className="mt-3"><input type="hidden" name="outcome" value="no_response" /><Submit variant="ghost">Close — no response</Submit></ActionForm> : null}
            </section>
          ) : null}
          {it.response ? (
            <section className={box}><h2 className="font-semibold">Their reply</h2>
              <p className="mt-2 text-sm"><span className="rounded-full bg-canvas px-2 py-0.5 text-xs">{String(it.response.outcome).replace(/_/g, " ")}</span> {it.response.summary}</p>
              {(it.response.commitments ?? []).length ? <ul className="mt-2 list-disc pl-5 text-sm">{(it.response.commitments as Row[]).map((m, i) => <li key={i}>{m.who === "us" ? "We" : "They"}: {m.what}{m.due ? ` (by ${m.due})` : ""}</li>)}</ul> : null}
              <p className="mt-2 text-sm"><b>Next:</b> {it.response.next_action}</p>
            </section>
          ) : null}
          {editor && ["draft", "pending_approval", "approved", "planned"].includes(st) ? <ActionForm action={pauseAction.bind(null, id)} className="flex gap-2"><input name="reason" placeholder="Reason to pause" className={inp} /><Submit variant="ghost">Pause</Submit></ActionForm> : null}
        </div>

        <aside className="space-y-4">
          <section className={`${box} space-y-2 text-sm`}>
            <h2 className="flex items-center font-semibold">Why now<HelpFor k="Why now" /></h2>
            <p>{it.reason}</p>{it.value_prop ? <p className="text-ink-soft">Value: {it.value_prop}</p> : null}
            <ul className="space-y-1 border-t border-line pt-2">{(it.facts as Row[]).map((f, i) => <li key={i} className="text-ink-soft">{f.text}</li>)}</ul>
            {(it.assumptions ?? []).length ? <p className="text-xs text-amber-800">Assumed: {(it.assumptions as string[]).join("; ")}</p> : null}
            {it.signal_id ? <Link href={`/signals/${it.signal_id}`} className="block text-brand underline">Open the signal</Link> : null}
            {it.opportunity_id ? <Link href={`/deals/${it.opportunity_id}`} className="block text-brand underline">Open the deal</Link> : null}
          </section>
          {(it.questions ?? []).length ? <section className={`${box} text-sm`}><h2 className="flex items-center font-semibold">Ask them<HelpFor k="Ask them" /></h2><ul className="mt-2 list-disc space-y-1 pl-5">{(it.questions as string[]).map((q, i) => <li key={i}>{q}</li>)}</ul></section> : null}
          {c?.interactions.length ? <section className={`${box} text-sm`}><h2 className="font-semibold">Earlier conversations</h2><ul className="mt-2 space-y-1.5">{c.interactions.map((x: Row) => <li key={x.id}><span className="text-ink-soft">{x.occurred_at.slice(0, 10)} · {x.channel}{x.direction === "inbound" ? " (from them)" : ""}</span>{x.summary ? <span className="block truncate">{x.summary}</span> : null}</li>)}</ul></section> : null}
          {d.siblings.length ? <section className={`${box} text-sm`}><h2 className="font-semibold">Same conversation</h2><ul className="mt-2 space-y-1">{(d.siblings as Row[]).map((x) => <li key={x.id}><Link href={`/outreach/${x.id}`} className="hover:text-brand">Step {x.step} · {CHANNEL_LABEL[x.channel as keyof typeof CHANNEL_LABEL]} · {x.status}{x.planned_on && x.status === "planned" ? ` · ${x.planned_on}` : ""}</Link></li>)}</ul></section> : null}
          <details className={`${box} text-sm`}><summary className="cursor-pointer font-semibold">History ({d.events.length})</summary>
            <ul className="mt-2 space-y-1 text-xs">{(d.events as Row[]).map((e, i) => <li key={i}><span className="text-ink-soft">{new Date(e.created_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</span> {e.event.replace(/_/g, " ")}{e.detail?.reason ? ` — ${e.detail.reason}` : ""}</li>)}</ul>
            <p className="mt-3 font-medium">Versions</p><ul className="mt-1 space-y-1 text-xs">{(d.versions as Row[]).map((v) => <li key={v.version}>v{v.version} · {v.kind.replace("_", " ")}{v.op ? ` (${v.op})` : ""}{v.learn ? " · style example" : ""}</li>)}</ul>
          </details>
        </aside>
      </div>
    </div>
  );
}
