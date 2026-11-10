import Link from "next/link";
import { notFound } from "next/navigation";
import { HelpFor } from "@/components/ui";
import { Legend, MissingNote, Status, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { ApprovalsSection, BudgetSection, ClientSection, CompletenessBar, GapsSection, LocationSection, SectionNav, SpaceSection, TimelineSection } from "@/modules/toolkit/ui/brief/sections";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { approveAnalysisAction, saveBriefSnapshotAction } from "@/modules/toolkit/actions-core";
import { loadBriefFor } from "@/modules/toolkit/deliverables";
import { getAnalysis } from "@/modules/toolkit/store";

function H({ children }: { children: string }) {
  return <h2 className="flex items-center font-serif text-xl text-ink">{children}<HelpFor k={children} /></h2>;
}

export default async function BriefPage({ params }: { params: Promise<{ requirementId: string }> }) {
  const { requirementId } = await params;
  const app = await requirePageContext();
  let brief;
  try { brief = await loadBriefFor(app.db, app.workspaceId, requirementId); } catch { notFound(); }
  const snap = (await app.db.from("deal_analysis").select("id").eq("workspace_id", app.workspaceId).eq("kind", "brief").eq("requirement_id", requirementId).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data as { id: string } | null;
  const analysis = snap ? (await getAnalysis(app.db, app.workspaceId, snap.id)) as (Record<string, any> & { versions: Record<string, any>[] }) | null : null;
  const canEdit = app.role !== "viewer";
  const back = `/toolkit/brief/${requirementId}`;
  const ctx = { requirementId, rowVersion: brief.rowVersion, canEdit };
  const topQs = [...brief.openQuestions].sort((x, y) => (x.priority === y.priority ? 0 : x.priority === "mandatory" ? -1 : 1)).slice(0, 5);
  const approvedAt = analysis?.approved_at ? String(analysis.approved_at).slice(0, 10) : null;
  const st = analysis ? String(analysis.status) : null;
  const step = st === "approved" ? 3 : st === "ready" ? 2 : 0;
  const snapshotActions = canEdit && (
    <div className="flex flex-wrap items-end gap-2">
      <ActionForm action={saveBriefSnapshotAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="requirement_id" value={requirementId} />
        <label className="sr-only" htmlFor="snap-note">Snapshot note (optional)</label>
        <input id="snap-note" name="note" placeholder="✎ Note (optional)" className={`${inputCls} sm:w-52`} />
        <Submit>Save brief snapshot</Submit>
      </ActionForm>
      {analysis && analysis.status === "ready" && (
        <ActionForm action={approveAnalysisAction}>
          <input type="hidden" name="analysis_id" value={analysis.id} />
          <input type="hidden" name="back" value={back} />
          <Submit variant="secondary">Approve snapshot v{analysis.current_version}</Submit>
        </ActionForm>
      )}
    </div>
  );
  return (
    <div className="mx-auto max-w-6xl pb-16 motion-safe:scroll-smooth">
      <ToolHeader back={{ href: "/toolkit/brief", label: "Client briefs" }} eyebrow={brief.organisation ?? "No organisation linked"} title={brief.title}
        purpose="Everything the client needs, each item marked Confirmed, Estimated, Assumption or Missing. Click any value to change it."
        steps={["Fill the gaps", "Save a snapshot", "Approve it", "Use in client documents"]} current={step}
        action={snapshotActions || undefined} />
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <Link className={btn.link} href={`/requirements/${requirementId}`}>Open requirement</Link>
        {analysis ? <span className="flex items-center gap-2">Latest snapshot version {analysis.current_version} <Status s={String(analysis.status)} />{approvedAt ? <span className="text-ink-soft">approved {approvedAt}</span> : null}</span> : <Status s="draft" label="No snapshot yet" />}
      </div>
      <div className="mt-4"><Legend /></div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold">How complete is this brief</p>
          <div className="mt-2"><CompletenessBar counts={brief.counts} /></div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold">Ask the client next</p>
          {topQs.length === 0 ? <p className="mt-2 text-sm text-ink-soft">Nothing left to ask.</p> : (
            <ol className="mt-2 space-y-2 text-sm">{topQs.map((q, i) => (
              <li key={q.key} className="flex gap-3"><span className="font-semibold text-brand">{i + 1}</span><span>{q.question}{q.priority === "mandatory" && <span className="ml-1 text-xs font-medium text-rose-700">· must have</span>}</span></li>))}</ol>
          )}
          {brief.openQuestions.length > topQs.length && <a href="#sec-G" className={`mt-2 inline-block text-sm ${btn.link}`}>See all {brief.openQuestions.length} open questions</a>}
        </div>
      </div>

      <div className="mt-6 lg:grid lg:grid-cols-[12rem_1fr] lg:gap-12">
        <aside className="lg:self-start lg:sticky lg:top-6"><SectionNav brief={brief} /></aside>
        <div className="mt-8 space-y-16 lg:mt-2">
          <ClientSection brief={brief} ctx={ctx} />
          <SpaceSection brief={brief} ctx={ctx} />
          <LocationSection brief={brief} ctx={ctx} />
          <BudgetSection brief={brief} ctx={ctx} />
          <TimelineSection brief={brief} ctx={ctx} approvedAt={approvedAt} />
          <ApprovalsSection brief={brief} ctx={ctx} />
          <GapsSection brief={brief} />

      <section>
        <H>Meeting outcomes</H>
        {brief.meetings.length === 0 ? <p className="py-3 text-sm text-ink-soft">No meeting outcomes linked to this requirement yet. Record outcomes after meetings in Meetings.</p> : (
          <ul className="divide-y divide-line">{brief.meetings.map((m, i) => (
            <li key={i} className="py-3 text-sm">
              <p className="font-medium">{m.title} <span className="font-normal text-ink-soft">· {m.date ?? "no date"}{m.outcome ? ` · ${m.outcome}` : ""}</span></p>
              {m.summary && <p className="mt-1 text-ink-soft">{m.summary}</p>}
              {m.decisionProcess && <p className="mt-1 text-xs">Decision process: {m.decisionProcess}</p>}
              {m.commitments.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">{m.commitments.map((c) => <li key={c}>{c}</li>)}</ul>}
            </li>))}</ul>
        )}
      </section>

      <section>
        <H>Brief snapshots</H>
        <p className="mt-2 text-sm text-ink-soft">A snapshot freezes this brief (formula brief-1.0) so proposals can cite exactly what was known. It can be approved only when no mandatory item is missing.</p>
        {analysis && (
          <div className="mt-3 space-y-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">Latest: version {analysis.current_version} <Status s={String(analysis.status)} />{analysis.approved_at ? <span className="text-ink-soft">approved {String(analysis.approved_at).slice(0, 10)}</span> : null}</p>
            <MissingNote items={(analysis.missing ?? []) as string[]} what="add these before the snapshot can be approved" />
          </div>
        )}
        <p className="mt-3 text-xs text-ink-soft">Save and approve snapshots with the buttons at the top of the page.</p>
        {analysis && analysis.versions.length > 0 && (
          <ul className="mt-4 space-y-1 text-xs text-ink-soft">{analysis.versions.map((v: Record<string, any>) => <li key={v.version}>v{v.version} · {v.formula_version} · {String(v.created_at).slice(0, 16).replace("T", " ")}{v.note ? ` · ${v.note}` : ""}</li>)}</ul>
        )}
      </section>
        </div>
      </div>
    </div>
  );
}
