import { FOCUS_MODE } from "@/lib/nav";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, StaleBanner, Textarea, Skeleton } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { ChangeError } from "@/lib/services/changes";
import { getReview } from "@/modules/capture/service";
import { StatusBadge } from "@/modules/capture/ui/parts";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { ProposalCard } from "@/modules/changes/ui/proposal-card";
import { fieldLabel, formatValue } from "@/modules/changes/display";
import { reviewAction } from "@/modules/capture/actions";
import { EnginePanel } from "@/modules/capture/input-engine/ui/engine-panel";
import { engineData } from "@/modules/capture/input-engine/ui/data";
import { captureKindLabel, interactionLogWording, languageLabel } from "@/modules/capture/input-engine/ui/labels";

export const metadata = { title: "Review capture" };
type Props = { params: Promise<{ id: string }> };

async function Body({ params }: Props) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  let r: Awaited<ReturnType<typeof getReview>>;
  try { r = await getReview(ctx.db, ctx.workspaceId, id); }
  catch (e) { if (e instanceof ChangeError && e.code === "not_found") notFound(); throw e; }
  const c = r.capture;
  const ex = r.extraction;
  const editor = hasRole(ctx, "editor");
  const text = c.transcript ?? c.raw_text ?? "";
  const entityQs = r.open.filter((a) => a.kind === "entity" && a.mention_index != null);
  const otherQs = r.open.filter((a) => !(a.kind === "entity" && a.mention_index != null));
  const lang = languageLabel(r.language, c.language_hint);
  const eng = await engineData(ctx.db, ctx.workspaceId, c.id, editor);

  return (
    <div className="space-y-4">
      <PageHeader title="Review capture" subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={c.status} /><Badge>{captureKindLabel(c.kind)}</Badge>{lang ? <Badge tone="neutral" title="Language of the note">{lang}</Badge> : null}{fmt(c.source_at)}{r.mocked ? <Badge tone="accent" title="Read by pattern rules (no AI used) — check each value">rule extractor</Badge> : null}</span>}
        actions={<ButtonLink variant="secondary" href="/capture">New capture</ButtonLink>} />
      {c.status === "failed" ? <StaleBanner>Processing failed: {c.error}. Correct the note below and save to retry.</StaleBanner> : null}
      {c.error && c.status !== "failed" ? <StaleBanner>{c.error}</StaleBanner> : null}
      {r.warnings.length ? <StaleBanner>Some items were not created: {r.warnings.join("; ")}</StaleBanner> : null}

      <Card title="Note">
        <p className="whitespace-pre-wrap text-sm">{text || <span className="text-ink-soft">No text yet.</span>}</p>
        {editor ? (
          <details className="mt-2"><summary className="cursor-pointer text-sm text-brand">Correct the note / transcript</summary>
            <ActionForm action={reviewAction} className="mt-2 space-y-2">
              <input type="hidden" name="capture_id" value={c.id} />
              <Textarea name="text" aria-label="Capture text" rows={4} defaultValue={text} />
              <Submit variant="secondary">Save and re-extract</Submit>
            </ActionForm>
          </details>
        ) : null}
      </Card>

      <EnginePanel engine={eng.engine} observations={eng.observations} corrections={eng.corrections} editor={editor} original={eng.original} linkOptions={eng.links} />

      {!ex ? (
        <Card><EmptyState title="Still processing">Extraction runs in the background. Refresh in a moment.</EmptyState></Card>
      ) : (
        <>
          {editor && r.open.length ? (
            <Card title={`Questions before anything material changes (${r.open.length})`}>
              <ActionForm action={reviewAction} className="space-y-4">
                <input type="hidden" name="capture_id" value={c.id} />
                {entityQs.map((a) => {
                  const m = ex.mentions[a.mention_index!];
                  return (
                    <fieldset key={a.index} className="space-y-1">
                      <legend className="text-sm font-medium">{a.question}</legend>
                      {a.options.map((o) => (
                        <label key={String(o.value)} className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name={`resolve:${a.mention_index}`} value={String(o.value)} /> {o.label}</label>
                      ))}
                      {m.kind !== "geography" ? <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name={`resolve:${a.mention_index}`} value="create" /> Create new {m.kind} “{m.text}”</label> : null}
                      {m.kind === "geography" && !a.options.length ? <p className="text-xs text-ink-soft">Unknown locality — add it under Settings → Geography, then save again.</p> : null}
                    </fieldset>
                  );
                })}
                {otherQs.map((a) => (
                  <fieldset key={a.index} className="space-y-1">
                    <legend className="text-sm font-medium">{a.question}</legend>
                    {a.options.map((o) => (
                      <label key={String(o.value)} className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name={`answer:${a.index}`} value={String(o.value)} /> {o.label}</label>
                    ))}
                    <p className="text-xs text-ink-soft">“{text.slice(a.start, a.end) || "—"}”</p>
                  </fieldset>
                ))}
                <Submit>Save answers</Submit>
              </ActionForm>
            </Card>
          ) : null}

          <Card title="Who and where">
            {ex.mentions.length === 0 ? <p className="text-sm text-ink-soft">No people, companies or localities recognised.</p> : (
              <ul className="space-y-1 text-sm">{ex.mentions.map((m, i) => {
                const rid = r.resolved[String(i)];
                const label = rid ? r.candidates.flatMap((x) => x.candidates).find((x) => x.id === rid)?.label ?? m.text : null;
                const href = rid ? (m.kind === "organisation" ? `/companies/${rid}` : m.kind === "person" ? `/people/${rid}` : null) : null;
                return <li key={i} className="flex flex-wrap items-center gap-2"><Badge>{m.kind}</Badge>“{m.text}” →
                  {rid ? (href ? <Link className="text-brand" href={href}>{label}</Link> : <span>{label}</span>) : <Badge tone="warn">unresolved</Badge>}</li>;
              })}</ul>
            )}
            <p className="mt-2 text-xs text-ink-soft">{interactionLogWording(c.kind, ex.interaction?.channel, c.status === "reviewed")}</p>
            {r.inferredOrg ? <p className="mt-1 text-xs text-ink-soft">No company was named: using <Link className="underline" href={`/companies/${r.inferredOrg.org_id}`}>{r.inferredOrg.label}</Link>, the confirmed person&apos;s only current employer. Proposals still need approval.</p> : null}
            {r.ocr ? <p className="mt-1 text-xs text-ink-soft">{r.ocr.length ? `Photo text read (${r.ocr.mocked ? "mock — no OCR configured" : r.ocr.model}). It is evidence for context only, never proof of legal or commercial terms; facts from it are tentative.` : "No legible text was read from the photo (or OCR is not configured); the caption is the content."}</p> : null}
          </Card>

          {c.status !== "reviewed" ? (
            <Card title="What will be added when you press Reviewed" help="Nothing has been saved to your records yet. Check this list, answer any questions above, then press Reviewed — the meeting, tasks and record changes are added to their sections in one go.">
              <ul className="space-y-2 text-sm">
                <li className="flex gap-2"><Badge tone="brand">Meeting log</Badge><span>{ex.interaction?.channel ?? "note"} — {(ex.interaction?.summary ?? "").slice(0, 160) || "summary of your note"}</span></li>
                {r.factPreview.map((f) => <li key={`f${f.index}`} className="flex gap-2"><Badge tone="accent">Requirement</Badge><span>{FIELD_LABEL[f.field] ?? fieldLabel(f.field)}: <b>{f.value == null ? "?" : formatValue(f.field, f.value)}</b>{f.unit && f.unit !== "date" && !/date/.test(f.field) ? ` ${f.unit}` : ""} <span className="text-ink-soft">(from “{f.raw_text}”)</span></span></li>)}
                {ex.details.map((d, i) => <li key={`d${i}`} className="flex gap-2"><Badge tone="accent">Requirement</Badge><span>{d.key.replace(/_/g, " ")}: <b>{String(d.value ?? "—")}</b></span></li>)}
                {ex.stakeholders.map((st, i) => <li key={`s${i}`} className="flex gap-2"><Badge>Stakeholder</Badge><span>{ex.mentions[st.mention_index]?.text} as {st.role}</span></li>)}
                {ex.tasks.map((t, i) => <li key={`t${i}`} className="flex gap-2"><Badge tone="ok">Task</Badge><span>{t.description}{t.due_date ? <span className="text-ink-soft"> · due {t.due_date}</span> : null}</span></li>)}
                {ex.promises.map((pr, i) => <li key={`p${i}`} className="flex gap-2"><Badge tone="ok">Promise</Badge><span>{pr.who === "me" ? "You" : pr.who}: {pr.what}</span></li>)}
                {ex.objections.map((o, i) => <li key={`o${i}`} className="flex gap-2"><Badge tone="warn">Objection</Badge><span>“{o.text}”</span></li>)}
              </ul>
              {r.open.length ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">Answer the {r.open.length} question(s) above first.</p> : null}
              {editor ? (
                <ActionForm action={reviewAction} className="mt-4">
                  <input type="hidden" name="capture_id" value={c.id} />
                  <input type="hidden" name="done" value="1" />
                  <Submit>Reviewed — add to records</Submit>
                </ActionForm>
              ) : null}
            </Card>
          ) : (<>
          {ex.promises.length || ex.objections.length ? (
            <Card title="Promises and objections">
              {ex.promises.length ? (
                <ul className="space-y-1 text-sm">{((r.interaction?.promises ?? []) as { key: string; who: string; what: string; due: string | null; due_tentative?: string | null; status: string }[]).map((p) => (
                  <li key={p.key}>• <span className="font-medium">{p.who === "me" ? "You" : p.who}</span>: {p.what} <span className="text-ink-soft">{p.due ? `due ${p.due}` : p.due_tentative ? `due ${p.due_tentative}? (confirm above)` : "no due date"} · {p.status}</span></li>
                ))}</ul>
              ) : null}
              {ex.objections.length ? (
                <ul className="mt-2 space-y-1 text-sm">{ex.objections.map((o, i) => <li key={i}><Badge tone="warn">objection</Badge> “{o.text}”</li>)}</ul>
              ) : null}
              <p className="mt-2 text-xs text-ink-soft">Stored on the interaction; overdue promises show up in your brief.</p>
            </Card>
          ) : null}

          {ex.stakeholders.length || ex.details.length ? (
            <Card title="Roles and requirement details">
              {ex.stakeholders.length ? (
                <ul className="space-y-1 text-sm">{ex.stakeholders.map((s, i) => (
                  <li key={i}>• {ex.mentions[s.mention_index]?.text} — <Badge>{s.role}</Badge>{r.resolved[String(s.mention_index)] ? null : <span className="text-xs text-ink-soft"> (confirm who this is above)</span>}</li>
                ))}</ul>
              ) : null}
              {ex.details.length ? (
                <ul className="mt-2 space-y-1 text-sm">{ex.details.map((d, i) => <li key={i}>• <span className="font-mono text-xs">{d.key}</span>: {String(d.value ?? "—")} <span className="text-xs text-ink-soft">(estimated)</span></li>)}</ul>
              ) : null}
              <p className="mt-2 text-xs text-ink-soft">Roles and details are proposed against the company&apos;s requirement once the company and requirement are known.</p>
            </Card>
          ) : null}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Facts for approval</h2>
            {r.proposals.length === 0 ? (
              <Card><p className="text-sm text-ink-soft">{ex.facts.length ? "Facts are waiting on the questions above (which company, which date, which number) before they can be proposed." : "No requirement facts in this note."}</p></Card>
            ) : r.proposals.map((p) => <ProposalCard key={p.id} role={ctx.role} p={{ ...p, capture_id: null, proposed_by_kind: "model" } as never} />)}
          </section>

          <Card title="Tasks">
            {r.tasks.length === 0 ? <p className="text-sm text-ink-soft">No tasks.</p> : (
              <ul className="space-y-1 text-sm">{r.tasks.map((t) => <li key={t.id}>• {t.title} <span className="text-ink-soft">{t.due_at ? `due ${fmt(t.due_at, "EEE dd MMM")}` : "no due date"} · {t.status}</span></li>)}</ul>
            )}
            {FOCUS_MODE ? null : <Link className="mt-2 inline-block text-sm text-brand" href="/tasks">Open tasks</Link>}
          </Card>

          <Card title="Drafts (you send them yourself)">
            {r.drafts.length === 0 ? <p className="text-sm text-ink-soft">No drafts.</p> : (
              <ul className="space-y-2 text-sm">{r.drafts.map((d) => (
                <li key={d.id}><Link className="text-brand" href={`/drafts/${d.id}`}>{d.subject ?? d.channel} → {d.recipient_display ?? "recipient to choose"}</Link>
                  <span className="text-ink-soft"> · {d.state}{d.recipient_person_id ? "" : " · recipient not linked"}</span></li>
              ))}</ul>
            )}
          </Card>

          </>)}
        </>
      )}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = { area_target_sf: "Area needed (sq ft)", seats_target: "Seats", budget_max: "Budget (max)", occupation_date: "Move-in date", decision_date: "Decision date", preferred_geography: "Preferred location" };

export default function Page(props: Props) {
  return <Suspense fallback={<Skeleton variant="detail" />}><Body {...props} /></Suspense>;
}
