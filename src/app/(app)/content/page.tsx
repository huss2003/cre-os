import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, ButtonLink, Badge, EmptyState, Field, Select, Input, MoreFields, Textarea } from "@/components/ui";
import { listPosts, voiceSamples, brandRules, confidentialTerms } from "@/modules/intelligence/content/service";
import { listMarketNotes } from "@/modules/intelligence/market/service";
import { AUDIENCES, AUDIENCE_LABEL, checklistPasses, type CheckItem, type Claim } from "@/modules/intelligence/content/editor";
import { Flash, Disclaimer, fmtDay, label } from "@/modules/intelligence/ui";
import { planAction, ideaAction, postAction, voiceAction, linkNoteAction, publicFactAction, removeEvidenceAction, dateAction, guardrailsAction } from "./actions";

type Row = Record<string, unknown>;
const STATUS_TONE: Record<string, "ok" | "warn" | "neutral" | "brand"> = { approved: "ok", published_manually: "brand", in_review: "warn", drafted: "warn" };

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const isAdmin = hasRole(ctx, "admin");
  const [posts, samples, rules, terms, notes] = await Promise.all([listPosts(ctx.db, ctx.workspaceId), voiceSamples(ctx.db, ctx.workspaceId), brandRules(ctx.db, ctx.workspaceId), confidentialTerms(ctx.db, ctx.workspaceId), listMarketNotes(ctx.db, ctx.workspaceId)]);
  const approvedNotes = notes.filter((n) => n.status === "approved" || n.status === "published_manually");
  const noteBy = new Map(notes.map((n) => [String(n.id), n]));
  const weeks = [...new Set(posts.map((p) => String(p.week_start)))];

  return (
    <div>
      <PageHeader title="Content" subtitle="Weekly plan, LinkedIn posts and market notes in your voice. You publish manually — CRE OS never posts." actions={<>
        <ButtonLink variant="secondary" href="/content/calendar">Publishing calendar</ButtonLink>
        {canEdit ? <form action={planAction}><Button>Plan this week</Button></form> : null}
      </>} />
      <Disclaimer>Drafts use approved market notes and public-source facts only. Before approval every number, date, company and claim must match that evidence, and the brand, confidentiality and licence checks must pass. Only approved drafts are marked ready; nothing publishes automatically.</Disclaimer>
      <Flash sp={sp} />
      {samples.length === 0 && <p className="mb-2 text-sm text-ink-soft">No voice samples yet — drafts use a neutral template. {isAdmin ? "Add two or three of your past posts below." : "Ask an admin to add your past posts."}</p>}
      {terms.length === 0 && <p className="mb-4 text-sm text-ink-soft">No confidential terms configured — only client names are screened. {isAdmin ? "Add project code names and deal terms under “Guardrails” below." : "Ask an admin to add them."}</p>}

      {posts.length === 0 ? (
        <Card className="mb-4"><EmptyState title="Nothing planned yet">Use “Plan this week” (it also runs automatically every Monday) for two LinkedIn ideas and a market-note slot with planned dates, or add your own idea below. Approving a market note adds a linked idea automatically.</EmptyState></Card>
      ) : weeks.map((w) => (
        <Card key={w} title={`Week of ${fmtDay(w)}`} className="mb-4">
          <ul className="divide-y divide-line">
            {posts.filter((p) => String(p.week_start) === w).map((p) => {
              const id = String(p.id);
              const items = (p.review_checklist ?? []) as CheckItem[];
              const pass = items.length > 0 && checklistPasses(items);
              const refs = (Array.isArray(p.evidence_refs) ? p.evidence_refs : []) as Row[];
              const fc = (p.fact_check ?? {}) as { claims?: Claim[] };
              const unmatched = (fc.claims ?? []).filter((c) => !c.matched);
              const flags = (Array.isArray(p.content_flags) ? p.content_flags : []) as { kind: string; detail: string }[];
              const manualBrandOpen = items.some((i) => i.key.startsWith("brand:") && !i.ok && /confirm brand review/.test(i.detail));
              const open = canEdit && p.status !== "published_manually";
              return (
                <li key={id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1"><span className="font-medium">{String(p.topic)}</span><Badge>{label(String(p.channel))}</Badge><Badge tone="brand">{AUDIENCE_LABEL[p.audience as keyof typeof AUDIENCE_LABEL] ?? String(p.audience)}</Badge>
                    <Badge tone={STATUS_TONE[String(p.status)] ?? "neutral"}>{p.status === "approved" ? "ready to publish (approved)" : label(String(p.status))}</Badge>
                    <span className="text-xs text-ink-soft">{p.planned_publish_on ? `planned ${fmtDay(String(p.planned_publish_on))}` : "no date"}</span></div>
                  {p.published_url ? <a className="text-xs text-brand" href={String(p.published_url)} target="_blank" rel="noopener noreferrer">{String(p.published_url)}</a> : null}

                  <div className="mt-2 rounded-lg border border-line p-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Source notes ({refs.length})</p>
                    {refs.length === 0 ? <p className="text-xs text-ink-soft">No evidence linked. Facts need a source.</p> : (
                      <ul className="mt-1 space-y-1 text-xs">
                        {refs.map((r) => {
                          const note = r.type === "market_note" ? noteBy.get(String(r.id)) : null;
                          return (
                            <li key={String(r.id)} className="flex flex-wrap items-start justify-between gap-1">
                              <span className="min-w-0 break-words">
                                {r.type === "market_note" ? <>Market note: <span className="font-medium">{note ? String(note.title) : "(not visible)"}</span> {note ? <Badge tone={note.status === "approved" || note.status === "published_manually" ? "ok" : "bad"}>{label(String(note.status))}</Badge> : null}
                                  {note && Array.isArray(note.sources) ? <span className="text-ink-soft"> — {(note.sources as Row[]).map((x) => `${String(x.name)} (released ${fmtDay(x.release_date as string | null)})${x.licensed_name ? x.permits_publication ? " · licensed, publication permitted" : " · licensed, NOT cleared for publication" : ""}`).join("; ")} · n={String(note.sample_size ?? "?")}</span> : null}</>
                                  : <>Public fact: “{String(r.text)}” — <a className="text-brand" href={String(r.source_url)} target="_blank" rel="noopener noreferrer">{String(r.source_name)}</a>, {fmtDay(String(r.source_date))}</>}
                              </span>
                              {open && <form action={removeEvidenceAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="ref" value={String(r.id)} /><Button variant="ghost" className="min-h-0 px-2 py-0 text-xs">remove</Button></form>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {open && (
                      <div className="mt-2 space-y-2">
                        <form action={linkNoteAction} className="flex flex-col gap-1 sm:flex-row sm:items-end"><input type="hidden" name="id" value={id} />
                          <Field label="Link a market note">{approvedNotes.length ? <Select name="note_id" required defaultValue={String(p.market_note_id ?? "")}>{[<option key="" value="" disabled>Choose…</option>, ...approvedNotes.map((n) => <option key={String(n.id)} value={String(n.id)}>{String(n.title)}</option>)]}</Select> : <p className="text-xs text-ink-soft">No approved notes — approve one on <Link className="text-brand" href="/market">Market</Link>.</p>}</Field>
                          {approvedNotes.length ? <Button variant="secondary" type="submit">Link</Button> : null}
                        </form>
                        <details><summary className="cursor-pointer text-xs text-brand">Add a public-source fact</summary>
                          <form action={publicFactAction} className="mt-2 max-w-md space-y-2"><input type="hidden" name="id" value={id} />
                            <Textarea name="text" aria-label="Exact fact as published" required minLength={5} maxLength={600} placeholder="Exact fact as published" className="min-h-16" />
                            <Input name="source_name" required placeholder="Source (e.g. JLL Q3 report)" /><Input name="source_url" type="url" required placeholder="https://…" /><Input name="source_date" type="date" required aria-label="Source date" />
                            <Button variant="secondary" type="submit">Add fact</Button>
                          </form>
                        </details>
                      </div>
                    )}
                  </div>

                  {open && (
                    <form action={dateAction} className="mt-2 flex items-end gap-2"><input type="hidden" name="id" value={id} />
                      <Field label="Planned publish date"><Input name="planned" type="date" defaultValue={p.planned_publish_on ? String(p.planned_publish_on) : ""} /></Field>
                      <Button variant="secondary" type="submit">Set</Button>
                    </form>
                  )}

                  {open && (
                    <form action={postAction} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={id} />
                      {p.body ? <Textarea name="body" defaultValue={String(p.body)} className="min-h-40" maxLength={3500} /> : null}
                      {items.length > 0 && (
                        <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">{items.map((i) => <li key={i.key} className={i.ok ? "text-ok" : "text-bad"}>{i.ok ? "✓" : "✗"} {i.label} <span className="text-ink-soft">— {i.detail}</span></li>)}</ul>
                      )}
                      {unmatched.length > 0 && (
                        <div className="rounded border border-bad/30 bg-bad/5 p-2 text-xs"><p className="font-medium text-bad">Unmatched claims (block approval) — add approved evidence or remove them:</p>
                          <ul className="list-disc pl-4">{unmatched.map((c, k) => <li key={k}><span className="font-medium">{c.kind}</span> “{c.text}”{c.evidence ? <span className="text-ink-soft"> — {c.evidence}</span> : null}</li>)}</ul></div>
                      )}
                      {flags.length > 0 && <p className="text-xs text-warn">Flags: {flags.map((f) => `${label(f.kind)} — ${f.detail}`).join(" · ")}</p>}
                      {p.private_version ? <details className="text-xs"><summary className="cursor-pointer text-brand">Private-shareable version (client names, confidential terms and uncleared licensed figures redacted — for 1:1 sharing, not public posting)</summary><pre className="mt-1 whitespace-pre-wrap break-words rounded bg-canvas p-2">{String(p.private_version)}</pre></details> : null}
                      <div className="flex flex-wrap gap-2">
                        <Button variant={p.body ? "secondary" : "primary"} name="op" value="draft">{p.body ? "Redraft" : "Draft it"}</Button>
                        {p.body ? <Button variant="secondary" name="op" value="save">Save &amp; check</Button> : null}
                        {p.body && manualBrandOpen ? <Button variant="secondary" name="op" value="brand_ok">I checked the brand rules</Button> : null}
                        {p.body && p.status !== "approved" ? <Button name="op" value="approve" disabled={!pass}>Approve</Button> : null}
                        <Button variant="ghost" name="op" value="discard">Discard</Button>
                      </div>
                      {p.status === "approved" && (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><Field label="Published link" hint="After you post it yourself"><Input name="url" type="url" placeholder="https://www.linkedin.com/posts/…" /></Field><Button name="op" value="published">Mark published</Button></div>
                      )}
                    </form>
                  )}
                  {!open && p.body ? <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-canvas p-2 text-xs">{String(p.body)}</pre> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canEdit && (
          <Card title="Add an idea">
            <form action={ideaAction} className="max-w-md space-y-4">
              <Field label="Topic"><Input name="topic" required minLength={3} maxLength={300} /></Field>
              <MoreFields>
                <Field label="Audience"><Select name="audience" defaultValue="general">{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</Select></Field>
                <Field label="Channel"><Select name="channel" defaultValue="linkedin"><option value="linkedin">LinkedIn</option><option value="market_note">Market note</option><option value="newsletter">Newsletter</option></Select></Field>
                <Field label="Planned date"><Input name="planned" type="date" /></Field>
                <Field label="Market note"><Select name="note_id" defaultValue="">{[<option key="" value="">None</option>, ...approvedNotes.map((n) => <option key={String(n.id)} value={String(n.id)}>{String(n.title)}</option>)]}</Select></Field>
              </MoreFields>
              <Button type="submit">Add</Button>
            </form>
          </Card>
        )}
        {isAdmin && (
          <Card title="Guardrails">
            <form action={guardrailsAction} className="space-y-3">
              <Field label="Brand rules" hint="One per line. Checked automatically: “avoid: synergy, game-changer”, “max 3 hashtags”, “no emojis”, “no exclamation marks”, “max 1300 characters”, “must include: …”. Anything else needs a manual confirmation per draft."><Textarea name="brand_rules" className="min-h-24" defaultValue={rules.join("\n")} /></Field>
              <Field label="Confidential terms" hint="One per line: project code names, employer-confidential terms, deal terms. Client names are screened automatically."><Textarea name="confidential_terms" className="min-h-24" defaultValue={terms.join("\n")} /></Field>
              <Button variant="secondary" type="submit">Save guardrails</Button>
            </form>
          </Card>
        )}
        {isAdmin && (
          <Card title="Your voice">
            <form action={voiceAction} className="space-y-3">
              <Field label="Past posts" hint="Separate posts with a line of three dashes (---). Used only as style reference."><Textarea name="samples" className="min-h-40" defaultValue={samples.join("\n---\n")} /></Field>
              <Button variant="secondary" type="submit">Save samples</Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
