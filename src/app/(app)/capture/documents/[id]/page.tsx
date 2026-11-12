import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Field, PageHeader, Select, Textarea, StaleBanner, Skeleton } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { getDocument, linkOptions, mmss, type Segment } from "@/modules/capture/docs/service";
import { reprocessDocAction } from "@/modules/capture/docs/actions";
import { DOC_TYPES, ROUTE, TYPE_LABEL, type DocType } from "@/modules/capture/docs/detect";
import { StateBadge } from "@/modules/capture/ui/parts";
import { observationsFor } from "@/modules/capture/input-engine/service";
import { ObservationList } from "@/modules/capture/input-engine/ui/observations";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const metadata = { title: "File" };
type Props = { params: Promise<{ id: string }> };

const LINKS: [string, string, string][] = [
  ["organisation", "organisation_id", "Company"], ["person", "person_id", "Person"], ["asset", "asset_id", "Building"],
  ["requirement", "requirement_id", "Requirement"], ["meeting", "meeting_prep_id", "Meeting / visit"],
];

async function Body({ params }: Props) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const got = await getDocument(ctx.db, ctx.workspaceId, id);
  if (!got) notFound();
  const { doc, proposals, transcript, originalUrl } = got;
  const observations = await observationsFor(ctx.db, ctx.workspaceId, { documentId: id });
  const r = (doc.result ?? {}) as Row;
  const det = (doc.detection ?? {}) as Row;
  const editor = hasRole(ctx, "editor");
  const options = editor ? await linkOptions(ctx.db, ctx.workspaceId) : null;
  const links = (doc.links ?? {}) as Record<string, string>;
  const type = doc.detected_type as DocType;
  return (
    <div className="space-y-4">
      <PageHeader title={doc.file_name} subtitle={<span>{TYPE_LABEL[type] ?? type} → {ROUTE[type] ?? "—"} · {fmt(doc.created_at)}</span>}
        actions={originalUrl ? <a href={originalUrl} className="text-sm text-brand underline" target="_blank" rel="noreferrer">Original file</a> : null} />
      {doc.status === "failed" || doc.status === "unsupported" ? <StaleBanner>{doc.error ?? "Processing failed."} The original file is kept.</StaleBanner> : null}
      {r.format_note && r.format_note !== doc.error ? <StaleBanner>{r.format_note}</StaleBanner> : null}
      {doc.status === "needs_input" ? <Card><p className="text-sm">{doc.error}</p></Card> : null}

      <Card title="What CRE OS found">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge>{det.method === "user" ? "type chosen by you" : det.method === "model" ? "type guessed by AI" : "type from file + keywords"}</Badge>
          {typeof det.confidence === "number" ? <Badge>confidence {Math.round(det.confidence * 100)}%</Badge> : null}
          {det.ocr_mocked ? <Badge tone="warn">photo text not read (AI not set up)</Badge> : null}
          {r.mocked ? <Badge tone="warn">pattern matching — check every value</Badge> : null}
        </div>
        {det.signals?.length ? <p className="mt-2 text-xs text-ink-soft">Signals: {(det.signals as string[]).join(", ")}</p> : null}

        {r.card ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-soft">Name</dt><dd>{r.card.name ?? "— (not on card)"}</dd>
            <dt className="text-ink-soft">Title</dt><dd>{r.card.title ?? "—"}</dd>
            <dt className="text-ink-soft">Company</dt><dd>{r.card.company ?? "—"}</dd>
            <dt className="text-ink-soft">Emails</dt><dd>{r.card.emails?.join(", ") || "—"}</dd>
            <dt className="text-ink-soft">Phones</dt><dd>{(r.card.phones ?? []).map((p: Row) => `${p.value} (${p.type})`).join(", ") || "—"}</dd>
            <dt className="text-ink-soft">Website</dt><dd>{r.card.website ?? "—"}</dd>
            <dt className="text-ink-soft">Address</dt><dd>{r.card.address ?? "—"}</dd>
          </dl>
        ) : null}
        {r.contact_methods_pending ? <p className="mt-2 text-xs text-ink-soft">{r.contact_methods_pending}</p> : null}
        {r.person_match ? (
          <p className="mt-2 text-xs">
            <Badge tone={r.person_match.tier === "high" ? "ok" : r.person_match.tier === "none" ? "neutral" : "warn"}>{r.person_match.tier === "none" ? "No existing contact" : `${r.person_match.tier} confidence match`}</Badge>{" "}
            {r.person_match.tier === "none" ? String(r.person_match.reason ?? "").replace(/^no existing contact\s*[—-]\s*/i, "").replace(/^./, (c: string) => c.toUpperCase()) : r.person_match.reason}{(r.person_match.candidates as Row[] | undefined)?.length ? <> — {(r.person_match.candidates as Row[]).map((c) => <Link key={c.id} className="text-brand underline" href={`/people/${c.id}`}>{c.label} </Link>)}</> : null}
            {r.person_match.tier === "medium" || r.person_match.tier === "low" ? " If it is the same person, pick them in the link picker and press Process again; nothing is merged automatically." : null}
          </p>
        ) : null}
        {(r.uncertain_fields as Row[] | undefined)?.length ? (
          <ul className="mt-2 list-disc pl-5 text-xs text-warn">{(r.uncertain_fields as Row[]).map((u, i) => <li key={i}>Check {u.field}: {u.reason}</li>)}</ul>
        ) : null}
        {r.company_matches?.length ? <p className="mt-2 text-xs">Possible existing company: {(r.company_matches as Row[]).map((c) => <Link key={c.id} className="text-brand underline" href={`/companies/${c.id}`}>{c.display_name ?? c.legal_name}</Link>)} — pick it in the link picker and press Process again if it is the same.</p> : null}

        {r.terms ? (
          <ul className="mt-3 divide-y divide-line text-sm">
            {Object.entries(r.terms as Record<string, Row>).filter(([, t]) => t.value != null).map(([k, t]) => (
              <li key={k} className="py-1"><span className="text-ink-soft">{t.label}:</span> {String(t.value)}{t.source ? <span className="text-xs text-ink-soft"> — p.{t.source.page} “{t.source.snippet}”</span> : <span className="text-xs text-warn"> — not located on a page</span>}</li>
            ))}
          </ul>
        ) : null}
        {r.lease_terms ? (
          <ul className="mt-3 divide-y divide-line text-sm">
            {(r.lease_terms as Row[]).map((t) => (
              <li key={t.field} className="py-1"><span className="text-ink-soft">{t.label}:</span> {t.verified ? <>p.{t.page} “{t.snippet}”</> : <span className="text-ink-soft">unknown{t.flag ? ` (${t.flag.replace(/_/g, " ")})` : ""}</span>}</li>
            ))}
          </ul>
        ) : null}
        {r.capture_id ? <p className="mt-3 text-sm"><Link className="text-brand underline" href={`/capture/${r.capture_id}`}>Open the capture review</Link> — confirm people, answer questions; record changes go to Review.</p> : null}
        {r.import_batch_id ? <p className="mt-3 text-sm"><Link className="text-brand underline" href={`/imports/${r.import_batch_id}`}>Open the import summary</Link> ({r.import_status}).</p> : null}
        {r.attachments ? <p className="mt-3 text-sm">Attached{r.attachments.asset_id ? <> to <Link className="text-brand underline" href={`/buildings/${r.attachments.asset_id}`}>the building</Link></> : null}{r.attachments.meeting_material_id ? " and to the visit's materials" : ""}. {r.note}</p> : null}
      </Card>

      <Card title={`Extracted information (${observations.length})`} help="Every value keeps its original wording and page. Carpet, chargeable and super built-up areas are never converted; rent is never assumed to include CAM.">
        <ObservationList items={observations} editor={hasRole(ctx, "editor")} />
      </Card>

      {transcript ? (
        <Card title="Transcript" help="Who said what is uncertain unless the recording was split by speaker. Times are from the recording when available.">
          {transcript.has_timestamps ? (
            <ul className="space-y-1 text-sm">{(transcript.segments as Segment[]).map((s, i) => <li key={i}><span className="font-mono text-xs text-ink-soft">[{mmss(s.start)}]</span> {s.text}</li>)}</ul>
          ) : <p className="whitespace-pre-wrap text-sm">{transcript.text}</p>}
          <p className="mt-2 text-xs text-ink-soft">{transcript.model === "manual" ? "Typed notes (no transcription)." : transcript.has_timestamps ? "" : "No timestamps returned by the transcription service."} Speakers: not identified.</p>
        </Card>
      ) : null}

      <Card title={`Proposals (${proposals.length})`} help="Nothing here has changed a record. Approve or reject each one in Review.">
        {proposals.length === 0 ? <p className="text-sm text-ink-soft">No record changes proposed from this file.</p> : (
          <ul className="divide-y divide-line">{proposals.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0"><StateBadge state={p.state} /> {proposalLabel(p.operation, p.target_type)}<span className="block truncate text-xs text-ink-soft">{p.reason}</span></span>
              <Link className="shrink-0 text-brand underline" href="/approvals?tab=records">Review</Link>
            </li>
          ))}</ul>
        )}
      </Card>

      {editor && options ? (
        <Card title="Fix and process again" help="Same file, same proposals — processing again never duplicates anything.">
          <ActionForm action={reprocessDocAction} className="space-y-3">
            <input type="hidden" name="id" value={doc.id} />
            <Field label="What is it?">
              <Select name="doc_type" defaultValue={det.user_type ?? ""}>
                <option value="">Detect automatically</option>
                {DOC_TYPES.filter((t) => t !== "unknown").map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              {LINKS.map(([k, name, label]) => (
                <Field key={name} label={label}>
                  <Select name={name} defaultValue={links[name] ?? ""}>
                    <option value="">—</option>
                    {(options as Record<string, { id: string; label: string }[]>)[k].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            <Field label={type === "audio" ? "Your notes from the recording" : "Text (if the file couldn't be read)"} hint="Typed text is used instead of the file's text.">
              <Textarea name="typed_text" rows={4} defaultValue={r.typed_text ?? ""} />
            </Field>
            <Submit>Process again</Submit>
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<Skeleton variant="detail" />}><Body {...props} /></Suspense>;
}

const OP_LABEL: Record<string, string> = { create: "New", update: "Update", merge: "Merge", link: "Link", archive: "Archive", delete: "Remove" };
const TARGET_LABEL: Record<string, string> = { organisation: "company", person: "contact", contact_method: "contact detail", employment: "job / employment", interaction: "interaction", task: "task", requirement: "requirement", lease: "lease", asset: "building", availability: "availability" };
/** Plain proposal label, e.g. "New company" instead of "create organisation" (B11). */
function proposalLabel(op: string, target: string) {
  return `${OP_LABEL[op] ?? (op ? op.charAt(0).toUpperCase() + op.slice(1).replace(/_/g, " ") : "Change")} ${TARGET_LABEL[target] ?? String(target ?? "").replace(/_/g, " ")}`;
}
