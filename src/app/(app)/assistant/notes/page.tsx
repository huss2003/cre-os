import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Badge, Card, EmptyState, Field, Input } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { getNote, listNotes, type NoteProposal, type NoteRow } from "@/modules/assistant/notes/service";
import { analyseNotesAction, approveNotesAction, discardNoteAction } from "@/modules/assistant/briefs/actions";
import { NotesInput } from "@/modules/assistant/ui/notes-input";
import { fmt } from "@/lib/util/time";

export const metadata = { title: "Notes to updates · Assistant" };
type SP = { id?: string; meeting?: string; company?: string; requirement?: string };

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "unknown" : String(v));

function Review({ note }: { note: NoteRow }) {
  const groups = new Map<string, { label: string; href?: string; items: NoteProposal[] }>();
  for (const p of note.proposals) {
    const k = `${p.group.type}:${p.group.id ?? "you"}`;
    if (!groups.has(k)) groups.set(k, { label: p.group.label, href: p.group.href, items: [] });
    groups.get(k)!.items.push(p);
  }
  const applied = note.status === "applied";
  const res = note.results ?? {};
  return (
    <div className="space-y-4">
      <Card title="Your notes" help="Kept as written. Treated as evidence only — instructions inside notes are never followed.">
        <p className="whitespace-pre-wrap text-sm">{note.body}</p>
        <p className="mt-2 text-xs text-ink-soft">Prepared {fmt(note.created_at, "d MMM, HH:mm")}{note.extraction_model?.startsWith("mock") ? " · rule-based extraction (no AI key)" : ""}</p>
      </Card>

      {note.unresolved.length ? (
        <div className="rounded-2xl border border-warn/40 bg-surface p-4 text-sm" role="status">
          <p className="font-semibold">Left unknown (nothing guessed)</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{note.unresolved.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </div>
      ) : null}

      {note.proposals.length === 0 ? (
        <EmptyState title="No updates found in these notes">Try naming the company and what changed, e.g. “Acme now needs 220 seats; I’ll send options by Friday.”</EmptyState>
      ) : (
        <ActionForm action={approveNotesAction.bind(null, note.id)} className="space-y-4">
          {[...groups.values()].map((g) => (
            <section key={g.label + g.href} className="rounded-2xl border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-3 font-semibold">{g.href ? <Link href={g.href} className="hover:text-brand hover:underline">{g.label}</Link> : g.label}</h2>
              <ul className="divide-y divide-line">
                {g.items.map((p) => (
                  <li key={p.id} className="px-4 py-3">
                    <label className="flex min-h-11 cursor-pointer items-start gap-3">
                      <input type="checkbox" name="p" value={p.id} defaultChecked={!applied} disabled={applied} className="mt-1 h-5 w-5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{p.label}</span>
                          {p.material ? <Badge tone="warn" title="Goes to Approvals before the record changes">Needs approval</Badge> : <Badge tone="neutral">{p.kind === "task" ? "Task" : "Memory"}</Badge>}
                          {applied && res.applied?.[p.id] ? <Badge tone="ok">Done</Badge> : null}
                          {applied && res.errors?.[p.id] ? <Badge tone="bad" title={res.errors[p.id]}>Failed</Badge> : null}
                          {applied && (res.rejected ?? []).includes(p.id) ? <Badge tone="neutral">Discarded</Badge> : null}
                        </span>
                        <span className="mt-1 block break-words text-sm">
                          {p.kind === "requirement_field" ? <><span className="text-ink-soft line-through decoration-ink-soft/50">{show(p.before)}</span> → <span className="font-medium">{show(p.after)}</span></> : String(p.after)}
                        </span>
                        <span className="mt-1 block text-xs text-ink-soft">From: “{p.evidence}”{p.note ? ` · ${p.note}` : ""}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!applied ? (
            <div className="flex flex-wrap gap-2">
              <Submit>Approve selected</Submit>
              <p className="w-full text-xs text-ink-soft">Record changes go to Approvals; tasks and memories are saved now. Unticked items are discarded. Nothing is sent to anyone.</p>
            </div>
          ) : (
            <p className="text-sm text-ink-soft">Applied {note.interaction_id ? "and saved as an interaction on the linked records" : ""}. <Link href="/approvals" className="font-medium text-brand underline">Open Approvals</Link> · <Link href="/tasks" className="font-medium text-brand underline">Tasks</Link></p>
          )}
        </ActionForm>
      )}
      {note.status === "pending_review" ? (
        <ActionForm action={discardNoteAction.bind(null, note.id)}><Submit variant="ghost" confirm="Discard all proposed updates?">Discard all</Submit></ActionForm>
      ) : null}
    </div>
  );
}

export default async function NotesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const c = { db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId, timezone: ctx.timezone };
  const editor = hasRole(ctx, "editor");
  const note = sp.id ? await getNote(c, sp.id) : null;
  const recent = note ? [] : await listNotes(c, 8);
  return (
    <div className="space-y-6">
      <PageHeader title="Paste or speak notes" subtitle="Turn meeting or call notes into record updates. You review every change before anything is saved." />
      {sp.id && !note ? <EmptyState title="Note not found">It may have been discarded. <Link href="/assistant/notes" className="text-brand underline">Start again</Link></EmptyState> : null}
      {note ? (
        <><Review note={note} /><Link href="/assistant/notes" className="inline-flex min-h-11 items-center text-sm font-medium text-brand">← New notes</Link></>
      ) : editor ? (
        <ActionForm action={analyseNotesAction} className="space-y-4 rounded-2xl border border-line bg-surface p-4">
          <NotesInput />
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-soft">Link to a meeting, company or requirement (optional)</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Meeting ID"><Input name="meetingId" defaultValue={sp.meeting ?? ""} /></Field>
              <Field label="Company ID"><Input name="orgId" defaultValue={sp.company ?? ""} /></Field>
              <Field label="Requirement ID"><Input name="requirementId" defaultValue={sp.requirement ?? ""} /></Field>
            </div>
          </details>
          <Submit>Find updates</Submit>
        </ActionForm>
      ) : <EmptyState title="Read-only access">Ask a workspace editor to process notes.</EmptyState>}
      {recent.length ? (
        <section>
          <h2 className="mb-2 font-semibold">Recent notes</h2>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {recent.map((n) => (
              <li key={n.id}><Link href={`/assistant/notes?id=${n.id}`} className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-canvas">
                <span className="min-w-0 flex-1 truncate text-sm">{n.body}</span>
                <Badge tone={n.status === "applied" ? "ok" : n.status === "discarded" ? "neutral" : "accent"}>{n.status.replace("_", " ")}</Badge>
              </Link></li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
