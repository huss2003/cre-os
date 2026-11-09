import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { MeetingError } from "@/modules/meetings/service";
import { noteAction } from "@/modules/meetings/actions";

export const metadata = { title: "Meeting mode" };
type Row = Record<string, any>;
const card = "rounded-2xl border border-line bg-surface p-4";

/** Meeting mode: one screen, big type, works on a phone. Everything needed in the room; notes saved as you go. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  const { data: p } = await ctx.db.from("meeting_prep").select("id, brief, meeting:meeting_visit_id(title, start_at)").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!p) notFound();
  const b = p.brief as Row | null;
  if (!b) throw new MeetingError("Prepare the brief first.");
  const { data: notes } = await ctx.db.from("meeting_note").select("kind, text, created_at").eq("prep_id", id).order("created_at", { ascending: false });
  return (
    <div className="mx-auto max-w-3xl space-y-4 text-[15px]">
      <div className="flex items-center justify-between gap-2"><Link href={`/meetings/${id}`} className="text-sm text-ink-soft">← Full brief</Link><span className="text-sm text-ink-soft">{(p.meeting as Row).title}</span></div>
      <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Purpose</p><p className="mt-1">{b.purpose.why}</p><p className="mt-1 text-sm"><b>Aim:</b> {b.outcome.ideal}</p></section>
      <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Who's here</p>
        <ul className="mt-1 space-y-1">{(b.attendees as Row[]).map((a) => <li key={a.id}><b>{a.name}</b> <span className="text-sm text-ink-soft">{a.title ?? ""}{a.role && a.role !== "unknown" ? ` · ${a.role.replace(/_/g, " ")}` : " · role unknown"}</span></li>)}</ul></section>
      <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Ask</p><ol className="mt-1 list-decimal space-y-1.5 pl-5">{(b.questions.essential as Row[]).map((q) => <li key={q.key}>{q.text}</li>)}{(b.questions.custom ?? []).map((q: Row, i: number) => <li key={`c${i}`}>{q.text}</li>)}</ol></section>
      <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Talking points</p><ul className="mt-1 space-y-1">{(b.strategy as Row[]).map((s, i) => <li key={i}><span className="capitalize text-ink-soft">{s.stage}:</span> {s.point}</li>)}</ul></section>
      {b.history.commitments.length ? <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Promised earlier</p><ul className="mt-1 list-disc pl-5">{(b.history.commitments as Row[]).map((c, i) => <li key={i}>{c.text}</li>)}</ul></section> : null}
      {(b.company.items as Row[]).length ? <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Key facts</p><ul className="mt-1 space-y-1 text-sm">{(b.company.items as Row[]).slice(0, 5).map((c, i) => <li key={i}>{c.text}{c.kind === "inference" ? <span className="text-amber-800"> (not confirmed)</span> : null}</li>)}</ul></section> : null}
      {b.properties?.length ? <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Properties</p><ul className="mt-1 space-y-1 text-sm">{(b.properties as Row[]).map((pp) => <li key={pp.id}><b>{pp.name}</b>{pp.verified ? "" : " — availability not verified"}{pp.mismatch.length ? ` · gaps: ${pp.mismatch.join("; ")}` : ""}</li>)}</ul></section> : null}
      {editor ? (
        <section className={`${card} sticky bottom-2 border-brand/40 shadow-lg`}>
          <ActionForm action={noteAction.bind(null, id)} className="space-y-2">
            <textarea name="text" rows={3} placeholder="Type a note…" className="w-full rounded-xl border border-line px-3 py-2" />
            <div className="flex gap-2"><select name="kind" aria-label="Type" className="min-h-10 flex-1 rounded-xl border border-line px-2"><option value="note">Note</option><option value="action">Action item</option><option value="commitment">Commitment</option><option value="feedback">Their feedback</option></select><Submit>Save</Submit></div>
          </ActionForm>
        </section>
      ) : null}
      {(notes ?? []).length ? <section className={card}><p className="text-xs font-semibold uppercase text-ink-soft">Notes so far</p><ul className="mt-1 space-y-1 text-sm">{((notes ?? []) as Row[]).map((n, i) => <li key={i}><span className="text-ink-soft">{n.kind} · {new Date(n.created_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</span> — {n.text}</li>)}</ul><Link href={`/meetings/${id}#after`} className="mt-2 inline-block text-sm text-brand underline">Finish: turn notes into updates</Link></section> : null}
    </div>
  );
}
