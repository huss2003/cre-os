import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Button, ButtonLink, Card, PageHeader, StaleBanner, Stat, Table, Td } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { adapterLabel, batchDetail, batchSteward, mappableRoles } from "@/modules/imports/service";
import { type Counts, Loading, ReconcileLine, SeverityBadge, StatusBadge, n } from "@/modules/imports/ui";
import { approveMappingAction, decideMatchAction, reprocessAction, resolveExceptionAction } from "../actions";
import { MappingForm } from "./mapping-form";
import { importSummary } from "@/modules/imports/summary";
import { ApplySafeButton } from "@/modules/imports/apply-safe-button";

export const metadata = { title: "Import batch" };

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

interface SheetInfo {
  sheet: string; status: string; adapter: string | null; role: string | null; header_row: number; signature: string; mapping_source: string | null;
  headers: string[]; suggestions: { adapter: string; role: string; label: string; positional: boolean; columnMap: Record<string, number> }[];
  extra_columns: string[]; rows_considered: number; layout_rows: number;
}

const TYPE_PLAIN: Record<string, string> = { organisation: "Companies", person: "People", asset: "Buildings", geography: "Locations", lease: "Lease updates", employment: "Job links (person ↔ company)" };
const ENTITY_LINK: Record<string, string> = { organisation: "/companies", asset: "/buildings", person: "/people" };

async function Body({ params, searchParams }: { params: Params; searchParams: SP }) {
  const ctx = await requirePageContext("editor");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await batchDetail(ctx, id);
  if (!d) notFound();
  const { batch, source, exceptions, quarantined, candidates } = d;
  const [steward, sum] = await Promise.all([batchSteward(ctx, batch.id, batch.source_object_id ?? null), importSummary(ctx.db, ctx.workspaceId, batch)]);
  const c = (batch.counts ?? {}) as Counts;
  const sheets = (batch.sheets ?? []) as SheetInfo[];
  const unknown = sheets.filter((s) => s.status === "unknown");
  const open = exceptions.filter((e: { status: string }) => e.status === "open");
  const closed = exceptions.length - open.length;
  const isAdmin = hasRole(ctx, "admin");
  const diff = batch.diff as null | { changed: number; added: number; removed: number; unchanged: number; samples: { kind: string; key: string; locator: string; previous_locator?: string; fields?: { field: string; before: unknown; after: unknown }[] }[] };
  const pending = candidates.filter((x: { decision: string }) => x.decision === "pending");
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <>
      <PageHeader
        title={batch.file_name}
        subtitle={<>v{source?.version ?? 1} · SHA-256 {String(source?.sha256 ?? "").slice(0, 16)}… · {adapterLabel(batch.adapter)} · {fmt(batch.created_at)}</>}
        actions={
          <>
            <StatusBadge status={batch.status} />
            <form action={reprocessAction}>
              <input type="hidden" name="batch_id" value={batch.id} />
              <Button variant="secondary" type="submit" disabled={batch.status === "processing"}>Re-process</Button>
            </form>
            <ButtonLink variant="ghost" href="/imports">All imports</ButtonLink>
          </>
        }
      />
      {error ? <StaleBanner>{error}</StaleBanner> : null}
      {batch.status === "failed" ? <StaleBanner>Processing failed: {batch.error ?? "unknown error"}. The original is untouched; fix the cause and re-process.</StaleBanner> : null}
      {batch.status === "awaiting_source" ? <StaleBanner>Quarantined: {batch.error ?? "the source of this file is not approved."} The original is stored read-only; nothing has been read into CRE OS. <Link className="underline" href="/imports/sources">Review import sources</Link>.</StaleBanner> : null}
      {batch.status === "registered" || batch.status === "processing" ? <StaleBanner>This batch is {batch.status === "processing" ? "being processed" : "queued"}; numbers below may be incomplete.{batch.error ? ` ${batch.error}` : ""}</StaleBanner> : null}

      {(() => {
        const addedTiles = sum.tiles.filter((t) => t.added + t.linked > 0);
        const checkItems = [
          { n: sum.check.identity, href: "#identity", text: "possible duplicates — same company, person or building twice?" },
          { n: sum.check.conflicts, href: "#conflicts", text: "values that differ from what you already have" },
          { n: sum.check.duplicatePeople, href: "#people", text: "new people whose name already exists" },
        ].filter((x) => x.n > 0);
        const problemItems = [
          { n: sum.problems.quarantined, href: "#quarantined", text: "rows could not be read" },
          { n: sum.problems.issues, href: "#issues", text: "rows have a problem to fix" },
        ].filter((x) => x.n > 0);
        const step = (num: number, title: string, tone: string) => (
          <div className="mb-3 flex items-center gap-3"><span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold text-white ${tone}`}>{num}</span><h3 className="text-base font-semibold">{title}</h3></div>
        );
        return (
          <section className="mb-6 space-y-5 rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <p className="text-sm text-ink-soft">This file had <b className="text-ink">{n(c.rows_considered)} rows</b>. Here is what happened to them, in three steps.</p>

            <div>
              {step(1, "Already added to your records", "bg-ok")}
              {addedTiles.length === 0 ? <p className="text-sm text-ink-soft">Nothing was added directly.</p> : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {addedTiles.map((t) => (
                    <div key={t.type} className="rounded-2xl bg-canvas p-4">
                      <div className="text-3xl font-bold tabular-nums">{(t.added + t.linked).toLocaleString("en-IN")}</div>
                      <div className="text-sm font-medium">{t.label}</div>
                      <div className="mt-1 text-xs text-ink-soft">{t.added.toLocaleString("en-IN")} new · {t.linked.toLocaleString("en-IN")} you already had</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              {step(2, "Needs your OK", sum.safe.count + checkItems.length ? "bg-brand" : "bg-ok")}
              {sum.safe.count === 0 && checkItems.length === 0 ? <p className="text-sm text-ok">✓ Nothing waiting — everything from this file is in your records.</p> : null}
              {sum.safe.count > 0 ? (
                <div className="rounded-2xl border border-ok/30 bg-ok/5 p-4">
                  <p className="text-sm"><b>{sum.safe.count.toLocaleString("en-IN")} rows are safe to add</b> — {Object.entries(sum.safe.byType).map(([k, v]) => `${v.toLocaleString("en-IN")} ${(TYPE_PLAIN[k] ?? k).toLowerCase()}`).join(", ")}. No duplicates, no conflicts.</p>
                  <div className="mt-3">{isAdmin ? <ApplySafeButton batchId={batch.id} total={sum.safe.count} /> : <p className="text-xs text-ink-soft">An owner or admin can add these in one click.</p>}</div>
                </div>
              ) : null}
              {checkItems.length ? (
                <div className="mt-3 rounded-2xl border border-warn/30 bg-warn/5 p-4">
                  <p className="text-sm font-semibold">Decide these yourself (never added automatically):</p>
                  <ul className="mt-2 space-y-1.5">{checkItems.map((x) => (
                    <li key={x.href}><a href={x.href} className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm hover:border-brand"><b>{x.n}</b> {x.text} <span className="text-brand">Review →</span></a></li>
                  ))}</ul>
                </div>
              ) : null}
            </div>

            {problemItems.length ? (
              <div>
                {step(3, "Could not be imported", "bg-bad")}
                <ul className="space-y-1.5">{problemItems.map((x) => (
                  <li key={x.href}><a href={x.href} className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm hover:border-brand"><b>{x.n}</b> {x.text} <span className="text-brand">See why →</span></a></li>
                ))}</ul>
                <p className="mt-2 text-xs text-ink-soft">These rows are kept with the reason, so nothing is lost. Fix the file and re-import, or ignore them.</p>
              </div>
            ) : null}
          </section>
        );
      })()}

      <details className="mb-4"><summary className="cursor-pointer text-sm font-medium text-ink-soft">Technical details (reconciliation, sheets, mapping)</summary><div className="mt-3">
      <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Rows considered" value={n(c.rows_considered)} hint={`${n(c.layout_rows)} header/title rows not counted`} />
        <Stat label="Accepted" value={n(c.accepted)} hint={`${n(c.duplicates)} duplicate observations`} />
        <Stat label="Quarantined" value={n(c.quarantined)} hint={Object.entries(c.quarantine_reasons ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} />
        <Stat label="Excluded" value={n(c.excluded)} hint={Object.entries(c.excluded_reasons ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} />
      </section>
      <p className="mb-4 text-sm"><ReconcileLine c={c} /></p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Master records (unique entities)">
          {Object.keys(c.masters ?? {}).length === 0 ? <p className="text-sm text-ink-soft">No buildings, companies or geographies touched.</p> : (
            <Table head={["Type", "New", "Linked to existing"]}>
              {Object.entries(c.masters ?? {}).map(([k, v]) => <tr key={k}><Td>{k}</Td><Td>{n(v.new)}</Td><Td>{n(v.existing_linked)}</Td></tr>)}
            </Table>
          )}
          <p className="mt-2 text-xs text-ink-soft">Rows that linked to an already-known master: {n(c.rows_linked_to_existing_master)}. Masters are counted once, however many rows observe them.</p>
        </Card>
        <Card title="Observations">
          {Object.keys(c.observations ?? {}).length === 0 ? <p className="text-sm text-ink-soft">{c.reference_rows ? `${n(c.reference_rows)} reference rows staged for reading only (not imported as facts).` : "None."}</p> : (
            <Table head={["Type", "New", "Already present"]}>
              {Object.entries(c.observations ?? {}).map(([k, v]) => <tr key={k}><Td>{k}</Td><Td>{n(v.new)}</Td><Td>{n(v.existing)}</Td></tr>)}
            </Table>
          )}
        </Card>
      </div>

      <Card title="Sheets" className="mt-4">
        <Table head={["Sheet", "Status", "Adapter / role", "Rows", "Accepted", "Quarantined", "Excluded"]}>
          {sheets.map((s) => {
            const b = c.by_sheet?.find((x) => x.sheet === s.sheet);
            return (
              <tr key={s.sheet}>
                <Td><div className="font-medium">{s.sheet}</div><div className="text-xs text-ink-soft" title={s.signature}>{s.signature.slice(0, 32)}{s.mapping_source === "approved_mapping" ? " · approved map" : ""}</div></Td>
                <Td><StatusBadge status={s.status} /></Td>
                <Td>{s.adapter ? `${s.adapter} / ${s.role}` : "—"}</Td>
                <Td>{n(s.rows_considered)}</Td>
                <Td>{n(b?.accepted)}</Td>
                <Td>{n(b?.quarantined)}</Td>
                <Td>{n(b?.excluded)}</Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      {unknown.length ? (
        <Card title="Mapping review" className="mt-4">
          {isAdmin ? (
            <div className="space-y-6">
              {unknown.map((s) => (
                <div key={s.sheet} className="rounded-lg border border-line p-3">
                  <h3 className="mb-2 font-medium">{s.sheet}</h3>
                  <MappingForm batchId={batch.id} sheet={s.sheet} headers={s.headers ?? []} headerRow={s.header_row} suggestions={s.suggestions ?? []}
                    roles={mappableRoles()} action={approveMappingAction} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-soft">{unknown.length} sheet(s) have an unrecognised layout and are quarantined. Ask a workspace admin to review and approve a column mapping; nothing from these sheets is imported until then.</p>
          )}
        </Card>
      ) : null}

      {c.controls?.length ? (
        <Card title="Reconciliation controls" className="mt-4">
          <Table head={["Control", "Cell", "Source", "Computed", "Result"]}>
            {c.controls.map((x) => (
              <tr key={x.locator + x.name}><Td>{x.name}</Td><Td>{x.locator}</Td><Td>{n(x.expected)}</Td><Td>{n(x.actual)}</Td>
                <Td className={x.ok ? "text-ok" : "text-bad"}>{x.ok ? "OK" : "Mismatch"}<div className="text-xs text-ink-soft">{x.note}</div></Td></tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {diff ? (
        <Card title="Changes vs previous version" className="mt-4">
          <p className="mb-2 text-sm">{n(diff.changed)} changed · {n(diff.added)} added · {n(diff.removed)} removed · {n(diff.unchanged)} unchanged. Earlier observations are kept; masters are never overwritten by an import.</p>
          {diff.samples.length ? (
            <Table head={["Change", "Row", "Fields"]}>
              {diff.samples.map((s, i) => (
                <tr key={i}><Td>{s.kind}</Td><Td>{s.locator}{s.previous_locator && s.previous_locator !== s.locator ? ` (was ${s.previous_locator})` : ""}</Td>
                  <Td className="text-xs">{(s.fields ?? []).map((f) => <div key={f.field}><span className="font-medium">{f.field}</span>: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}</div>)}</Td></tr>
              ))}
            </Table>
          ) : null}
        </Card>
      ) : null}

      </div></details>

      <div id="issues" />
      <Card title={`Rows with a problem (${open.length} open${closed ? `, ${closed} fixed` : ""})`} className="mt-4">
        {open.length === 0 ? <p className="text-sm text-ink-soft">Nothing waiting. Fractional tenures, stale formula caches, size boundaries, unknown layouts and failed controls appear here.</p> : (
          <div className="space-y-2">
          {Object.entries(Object.groupBy(open as { id: string; kind: string; severity: string; message: string; locator: string | null; sheet: string | null }[], (e) => e.kind)).map(([kind, rows]) => (
          <details key={kind} className="rounded-xl border border-line px-4 py-2">
            <summary className="cursor-pointer py-1 text-sm"><b>{kind.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}</b> · {rows!.length} row{rows!.length > 1 ? "s" : ""} <span className="text-ink-soft">— e.g. {rows![0].message.slice(0, 110)}</span></summary>
          <ul className="divide-y divide-line">
            {rows!.slice(0, 50).map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm"><SeverityBadge severity={e.severity} /><span className="text-xs text-ink-soft">{e.locator ?? e.sheet}</span></div>
                <p className="mt-1 text-sm">{e.message}</p>
                <form action={resolveExceptionAction} className="mt-2 flex flex-wrap gap-2">
                  <input type="hidden" name="batch_id" value={batch.id} />
                  <input type="hidden" name="exception_id" value={e.id} />
                  <input name="note" placeholder="Resolution note" className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm" />
                  <Button variant="secondary" type="submit" name="status" value="resolved">Resolved</Button>
                  <Button variant="ghost" type="submit" name="status" value="dismissed">Dismiss</Button>
                </form>
              </li>
            ))}
          </ul>
          {rows!.length > 50 ? <p className="py-2 text-xs text-ink-soft">Showing the first 50 of {rows!.length}.</p> : null}
          </details>
          ))}
          </div>
        )}
      </Card>

      <div id="identity" />
      <Card title={`Possible duplicates (${pending.length} to decide)`} className="mt-4">
        {candidates.length === 0 ? <p className="text-sm text-ink-soft">No look-alike names found.</p> : (() => {
          type M = { id: string; entity_type: string; left_id: string; right_id: string; right_raw: Record<string, string>; score: number; suggested: string; decision: string; change_proposal_id: string | null };
          const NOUN: Record<string, string> = { organisation: "company", asset: "building", person: "person", geography: "place" };
          const open = (candidates as M[]).filter((m) => m.decision === "pending");
          const done = (candidates as M[]).filter((m) => m.decision !== "pending");
          const Pair = ({ m }: { m: M }) => {
            const href = (id: string) => `${ENTITY_LINK[m.entity_type] ?? "/search"}/${id}`;
            const related = m.suggested === "relate_group" || m.suggested === "relate_campus";
            return (
              <li className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-sm font-medium text-ink">{related ? (m.suggested === "relate_campus" ? "Is this tower part of the campus?" : "Are these in the same group?") : `Are these the same ${NOUN[m.entity_type] ?? "record"}?`}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                  <Link href={href(m.left_id)} className="rounded-xl bg-canvas px-3 py-2.5 text-sm font-medium hover:text-brand">{m.right_raw?.left_name ?? "Saved record"}</Link>
                  <span className="text-center text-ink-soft" aria-hidden>≈</span>
                  <Link href={href(m.right_id)} className="rounded-xl bg-canvas px-3 py-2.5 text-sm font-medium hover:text-brand">{m.right_raw?.name ?? "From file"}{m.right_raw?.locality ? <span className="block text-xs font-normal text-ink-soft">{m.right_raw.locality}</span> : null}</Link>
                </div>
                {m.decision === "pending" ? (
                  <form action={decideMatchAction} className="mt-3 flex gap-2">
                    <input type="hidden" name="batch_id" value={batch.id} />
                    <input type="hidden" name="candidate_id" value={m.id} />
                    <Button type="submit" name="decision" value={related ? "related" : "link"} className="flex-1 sm:flex-none">{related ? "Yes, link them" : "Yes, same"}</Button>
                    <Button variant="secondary" type="submit" name="decision" value="keep_separate" className="flex-1 sm:flex-none">No, different</Button>
                  </form>
                ) : <p className="mt-2 text-xs text-ink-soft">{m.decision === "keep_separate" ? "Kept separate." : m.change_proposal_id ? <>Sent to <Link className="underline" href="/approvals">Review</Link>.</> : "Decided."}</p>}
              </li>
            );
          };
          return (
            <div className="space-y-4">
              {open.length ? <ul className="space-y-3">{open.map((m) => <Pair key={m.id} m={m} />)}</ul> : <p className="text-sm text-ok">All decided.</p>}
              {done.length ? <details><summary className="cursor-pointer text-sm text-ink-soft">Already decided ({done.length})</summary><ul className="mt-3 space-y-3">{done.map((m) => <Pair key={m.id} m={m} />)}</ul></details> : null}
            </div>
          );
        })()}
      </Card>

      <div id="conflicts" />
      <Card title={`Values that differ from your records (${steward.conflicts.filter((x: { status: string }) => x.status === "open" || x.status === "proposed").length} open)`} className="mt-4">
        {steward.conflicts.length === 0 ? <p className="text-sm text-ink-soft">No value in this file disagrees with an existing record. Existing records are never overwritten by an import; disagreements are listed here and in <Link className="underline" href="/approvals/conflicts">Approvals → Conflicts</Link>.</p> : (
          <ul className="space-y-3">
            {steward.conflicts.map((x: { id: string; entity_type: string; entity_id: string; field: string; master_value: unknown; source_value: unknown; material: boolean; source_locator: string; status: string; change_proposal_id: string | null }) => (
              <li key={x.id} className="rounded-2xl border border-line p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <Link className="font-medium hover:text-brand" href={`/approvals/evidence?type=${x.entity_type}&id=${x.entity_id}`}>{x.field.replace(/_/g, " ")}</Link>
                  <StatusBadge status={x.status} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-canvas px-3 py-2"><p className="text-xs text-ink-soft">Saved</p><p className="font-medium">{x.master_value === null ? "Unknown" : String(x.master_value)}</p></div>
                  <div className="rounded-xl bg-warn/10 px-3 py-2"><p className="text-xs text-ink-soft">In file</p><p className="font-medium">{String(x.source_value)}</p></div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div id="people" />
      <Card title={`New people from this file (${steward.personProposals.length})`} className="mt-4">
        {steward.personProposals.length === 0 ? <p className="text-sm text-ink-soft">No representative/contact names were found, or they were already proposed by an earlier import.</p> : (
          <ul className="divide-y divide-line text-sm">
            {steward.personProposals.map((p: { id: string; patch: { path: string; value: unknown }[]; state: string; reason: string | null }) => (
              <li key={p.id} className="py-2">
                <span className="font-medium">{String(p.patch.find((x) => x.path === "/full_name")?.value ?? "—")}</span> <StatusBadge status={p.state} />
                <p className="text-xs text-ink-soft">{p.reason}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-soft">People are only proposed — never merged with a same-name record. Apply them in <Link className="underline" href="/approvals?tab=records">Approvals</Link>; the company link is then proposed for approval.</p>
      </Card>

      <div id="quarantined" />
      <Card title={`Rows that could not be read${quarantined.length >= 100 ? " (first 100)" : ""}`} className="mt-4">
        {quarantined.length === 0 ? <p className="text-sm text-ink-soft">No rows are quarantined.</p> : (
          <Table head={["Row", "Reason", "Source cells (value / formula)"]}>
            {quarantined.map((q: { id: string; locator: string; reason: string | null; raw_json: Record<string, { v: unknown; f?: string }> }) => (
              <tr key={q.id}><Td className="whitespace-nowrap">{q.locator}</Td><Td>{q.reason}</Td>
                <Td className="text-xs">{Object.entries(q.raw_json ?? {}).slice(0, 14).map(([col, cell]) => <span key={col} className="mr-2 inline-block"><span className="text-ink-soft">{col}</span> {String(cell.v ?? "")}{cell.f ? <span className="text-ink-soft"> ({cell.f})</span> : null}</span>)}</Td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

export default function Page({ params, searchParams }: { params: Params; searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body params={params} searchParams={searchParams} /></Suspense>;
}
