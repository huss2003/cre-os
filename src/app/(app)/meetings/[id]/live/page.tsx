import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { MeetingError } from "@/modules/meetings/service";
import { noteAction } from "@/modules/meetings/actions";
import { Avatar, Dot, Kicker, Tag } from "@/modules/meetings/ui/dossier";

export const metadata = { title: "Meeting mode" };
type Row = Record<string, any>;
const Block = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="border-t border-line py-7"><Kicker>{title}</Kicker><div className="mt-3">{children}</div></section>
);

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
  const meeting = p.meeting as Row;
  return (
    <div className="mx-auto max-w-[640px] text-[17px] leading-relaxed">
      <div className="flex min-h-10 items-center justify-between gap-2">
        <Link href={`/meetings/${id}`} className="inline-flex min-h-10 items-center text-sm text-ink-soft hover:text-ink">← Full brief</Link>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-brand"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand motion-safe:animate-pulse" />In meeting</span>
      </div>
      <header className="pb-6 pt-4">
        <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">{meeting.title}</h1>
        <p className="mt-4 text-lg">{b.purpose.why}</p>
        <p className="mt-3 rounded-xl bg-brand-soft px-4 py-3 text-[15px] text-brand-strong"><span className="font-semibold">Aim:</span> {b.outcome.ideal}</p>
      </header>

      <Block title="Who's here">
        <ul className="space-y-3">{(b.attendees as Row[]).map((a) => <li key={a.id} className="flex items-center gap-3"><Avatar name={a.name} /><div className="min-w-0"><p className="font-semibold leading-tight">{a.name}</p><p className="text-sm text-ink-soft">{a.title ?? ""}{a.role && a.role !== "unknown" ? ` · ${a.role.replace(/_/g, " ")}` : " · role unknown"}</p></div></li>)}</ul>
      </Block>
      <Block title="Ask">
        <ol className="space-y-3">{[...(b.questions.essential as Row[]).map((q) => q.text as string), ...(b.questions.custom ?? []).map((q: Row) => q.text as string)].map((q, i) => <li key={i} className="flex gap-3"><span className="w-6 shrink-0 text-right tabular-nums text-brand">{i + 1}</span><span>{q}</span></li>)}</ol>
      </Block>
      <Block title="Talking points">
        <ul className="space-y-3">{(b.strategy as Row[]).map((s, i) => <li key={i}><span className="block text-xs font-medium uppercase tracking-wider text-ink-soft">{s.stage}</span>{s.point}</li>)}</ul>
      </Block>
      {b.history.commitments.length ? <Block title="Promised earlier"><ul className="space-y-2">{(b.history.commitments as Row[]).map((c, i) => <li key={i} className="flex gap-3"><Dot tone="muted" />{c.text}</li>)}</ul></Block> : null}
      {(b.company.items as Row[]).length ? <Block title="Key facts"><ul className="space-y-2 text-[15px]">{(b.company.items as Row[]).slice(0, 5).map((c, i) => <li key={i} className="flex gap-3"><Dot tone="muted" /><span>{c.text}{c.kind === "inference" ? <Tag k="inference" /> : null}</span></li>)}</ul></Block> : null}
      {b.properties?.length ? <Block title="Properties"><ul className="space-y-3 text-[15px]">{(b.properties as Row[]).map((pp) => <li key={pp.id}><p className="font-semibold">{pp.name}</p>{!pp.verified ? <p className="text-sm text-ink-soft">Availability not verified</p> : null}{pp.mismatch.length ? <p className="text-sm text-bad">Gaps: {pp.mismatch.join("; ")}</p> : null}</li>)}</ul></Block> : null}

      {(notes ?? []).length ? <Block title="Notes so far">
        <ul className="space-y-2.5 text-[15px]">{((notes ?? []) as Row[]).map((n, i) => <li key={i}><span className="text-xs uppercase tracking-wider text-ink-soft">{n.kind} · {new Date(n.created_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</span><p>{n.text}</p></li>)}</ul>
        <Link href={`/meetings/${id}#after`} className="mt-4 inline-flex min-h-10 items-center text-sm font-medium text-brand underline underline-offset-4">Finish: turn notes into updates</Link>
      </Block> : null}

      {editor ? (
        <section className="sticky bottom-2 z-10 mt-4 rounded-2xl border border-line bg-surface/95 p-3 shadow-[0_8px_30px_rgba(15,23,42,0.10)] backdrop-blur supports-[backdrop-filter]:bg-surface/85">
          <ActionForm action={noteAction.bind(null, id)} className="space-y-2">
            <textarea name="text" rows={3} placeholder="Type a note…" aria-label="Note" className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-base" />
            <div className="flex gap-2"><select name="kind" aria-label="Type" className="min-h-11 flex-1 rounded-xl border border-line bg-surface px-2 text-base"><option value="note">Note</option><option value="action">Action item</option><option value="commitment">Commitment</option><option value="feedback">Their feedback</option></select><Submit className="min-h-11">Save</Submit></div>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
