import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, PageHeader, Badge, Field, Input, MoreFields, Textarea, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { signalDetail } from "@/modules/signals/service";
import { signalAction } from "@/modules/signals/actions";
import { CATEGORY_LABEL, type Category } from "@/modules/signals/engine";
import { STATUS_LABEL, VERIFY_LABEL, CAT_COLOR, URGENCY, StrengthBars } from "@/modules/signals/ui/card";
import { researchNowAction } from "@/modules/signals/actions";

export const metadata = { title: "Signal" };
type Row = Record<string, any>;

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (<div className="border-t border-line py-3 first:border-t-0"><h3 className="text-sm font-semibold">{n}. {title}</h3><div className="mt-1 text-sm">{children}</div></div>);
}
const none = <span className="text-ink-soft">Nothing on record.</span>;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("viewer");
  const d = await signalDetail(ctx.db, ctx.workspaceId, id);
  if (!d) notFound();
  const s = d.signal; const c = (s.context_json ?? {}) as Row;
  const support = d.evidence.filter((e) => e.role === "support");
  const counter = [...(c.counter_evidence ?? []) as string[]];
  const editor = ctx.role !== "viewer";
  const [orgs, opps] = editor ? await Promise.all([
    ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("display_name").limit(500).then((r) => r.data ?? []),
    ctx.db.from("opportunity").select("id, name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(300).then((r) => r.data ?? []),
  ]) : [[], []];
  const act = signalAction.bind(null, id);
  const Btn = ({ a, children, v = "secondary" }: { a: string; children: React.ReactNode; v?: "primary" | "secondary" | "danger" }) => <Submit name="action" value={a} variant={v}>{children}</Submit>;
  return (
    <>
      <Link href="/signals" className="text-sm text-ink-soft hover:text-ink">Signals</Link>
      <header className="mt-2 mb-6 flex overflow-hidden rounded-2xl border border-line bg-surface">
        <span className={`w-2 shrink-0 ${CAT_COLOR[s.category]?.rail ?? "bg-stone-400"}`} aria-hidden />
        <div className="flex-1 p-5 sm:p-6">
          <p className={`text-sm font-medium ${CAT_COLOR[s.category]?.text ?? ""}`}>{CATEGORY_LABEL[s.category as Category]}</p>
          <h1 className="mt-1 text-xl font-bold leading-tight sm:text-2xl">{s.title}</h1>
          <p className="mt-2 text-ink-soft">
            {s.org_id ? <Link className="text-ink underline-offset-2 hover:underline" href={`/companies/${s.org_id}`}>{s.org?.display_name}</Link> : s.person_id ? <Link className="text-ink hover:underline" href={`/people/${s.person_id}`}>{s.person?.full_name}</Link> : <span className="text-warn">Company not matched{s.entity_name_raw ? ` (${s.entity_name_raw})` : ""}</span>}
            {s.location_text ? `, ${s.location_text}` : ""}{s.event_date ? ` — event ${s.event_date}` : ""}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
            <span className={`rounded-full px-3 py-1 font-medium ring-1 ${(URGENCY[s.priority_band] ?? URGENCY.low).cls}`}>{(URGENCY[s.priority_band] ?? URGENCY.low).label}</span>
            <span className="flex items-center gap-2"><StrengthBars level={s.confidence} size="lg" /><span>Evidence {s.confidence}</span></span>
            <span>{VERIFY_LABEL[s.verification]}</span>
            <span className="text-ink-soft">{STATUS_LABEL[s.status] ?? s.status}</span>
          </div>
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            <Section n={1} title="What happened?">{s.summary ?? none}</Section>
            <Section n={2} title="Why it matters">{s.cre_relevance ?? none} <span className="text-ink-soft">(interpretation, not a fact)</span></Section>
            <Section n={3} title="Supporting evidence">{support.length ? <ul className="space-y-2">{support.map((e) => (
              <li key={e.id}><p>“{e.excerpt ?? e.note}”</p><p className="text-xs text-ink-soft">{e.source_name ?? "Source"}{e.published_on ? ` · ${e.published_on}` : ""}{e.evidence_tier ? ` · ${e.evidence_tier.replace(/_/g, " ")}` : ""}{e.fact_status ? ` · ${e.fact_status.replace(/_/g, " ")}` : ""}{e.source_url ? <> · <a className="underline" href={e.source_url} target="_blank" rel="noreferrer noopener">open</a></> : null}</p></li>))}</ul> : none}
              <p className="mt-1 text-xs text-ink-soft">{(s.confidence_reasons ?? []).join(" ")}</p></Section>
            <Section n={4} title="Related company records">{c.company ? <>{c.company}{c.sector ? ` · ${c.sector}` : ""}{(c.opportunities ?? []).length ? <ul className="mt-1">{(c.opportunities as Row[]).map((o) => <li key={o.id}>Deal: {o.name} ({o.stage}, {o.outcome})</li>)}</ul> : null}</> : none}</Section>
            <Section n={5} title="Known office locations">{(c.locations ?? []).length ? (c.locations as string[]).join(", ") : none}</Section>
            <Section n={6} title="Existing occupancy">{(c.leases ?? []).length ? <ul>{(c.leases as Row[]).map((l) => <li key={l.id}>{l.asset ?? "Building"} · {l.area_sf ? `${Number(l.area_sf).toLocaleString("en-IN")} sq ft` : "area unknown"} · expiry {l.expiry ?? "unknown"}</li>)}</ul> : none}<p className="text-xs text-ink-soft">Spare capacity is not recorded — unverified.</p></Section>
            <Section n={7} title="Relevant lease events">{(c.lease_events ?? []).length ? <ul>{(c.lease_events as Row[]).map((e, i) => <li key={i}>{String(e.type).replace(/_/g, " ")}: {e.date ?? "no date"} ({e.basis}{e.confirmed ? ", confirmed" : ""})</li>)}</ul> : none}</Section>
            <Section n={8} title="Related contacts">{(c.contacts ?? []).length ? <ul>{(c.contacts as Row[]).map((p) => <li key={p.person_id}><Link className="underline" href={`/people/${p.person_id}`}>{p.name}</Link>{p.title ? ` — ${p.title}` : ""}</li>)}</ul> : none}{c.last_interaction_on ? <p className="text-xs text-ink-soft">Last interaction {c.last_interaction_on}</p> : null}</Section>
            <Section n={9} title="Existing requirements">{(c.requirements ?? []).length ? <ul>{(c.requirements as Row[]).map((r) => <li key={r.id}><Link className="underline" href={`/requirements/${r.id}`}>{r.title}</Link></li>)}</ul> : none}</Section>
            <Section n={10} title="Counter-evidence">{counter.length ? <ul className="list-disc pl-5">{counter.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="text-ink-soft">None found yet — that does not mean there is none.</span>}</Section>
            <Section n={11} title="Missing information">{(s.missing_info ?? []).length ? <ul className="list-disc pl-5">{(s.missing_info as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul> : none}</Section>
            <Section n={12} title="Suggested next step"><p>{s.recommended_action}</p>{s.task_id ? <p className="text-xs"><Link className="underline" href="/tasks">Task created</Link></p> : null}</Section>
          </Card>
          <Card title="Priority — why"><ul className="list-disc pl-5 text-sm">{(s.priority_reasons as string[]).map((r, i) => <li key={i}>{r}</li>)}</ul></Card>
          <Card title="History">{d.history.length ? <ul className="text-sm">{d.history.map((h) => <li key={h.id}>{String(h.created_at).slice(0, 16).replace("T", " ")} · {h.action.replace(/_/g, " ")}{h.reason ? ` — ${h.reason}` : ""}</li>)}</ul> : none}</Card>
        </div>
        {editor ? (
          <div className="space-y-4">
            <Card title="Decide">
              <ActionForm action={act} className="space-y-2">
                <Field label="Reason" hint="Needed to reject or dismiss"><Input name="reason" /></Field>
                <div className="flex flex-wrap gap-2">
                  <Btn a="approve" v="primary">Approve + task</Btn><Btn a="investigate">Investigate</Btn><Btn a="assign_me">Assign to me</Btn>
                  <Btn a="known">Already known</Btn><Btn a="reject" v="danger">Reject</Btn><Btn a="dismiss">Dismiss</Btn>
                  {["dismissed", "rejected", "known", "snoozed"].includes(s.status) ? <Btn a="reopen">Reopen</Btn> : null}
                </div>
              </ActionForm>
              <ActionForm action={act} className="mt-3 flex items-end gap-2"><Field label="Snooze until"><Input name="until" type="date" required /></Field><Btn a="snooze">Snooze</Btn></ActionForm>
            </Card>
            <Card title="Task">
              <ActionForm action={act} className="space-y-2"><Field label="Task title"><Input name="title" defaultValue={s.recommended_action?.split(". On record")[0] ?? ""} /></Field><Btn a="create_task">Create task</Btn></ActionForm>
            </Card>
            <Card title="Deal">
              <ActionForm action={act} className="space-y-2"><Field label="Link to existing deal"><Select name="opportunity_id" defaultValue={s.opportunity_id ?? ""}><option value="">Pick…</option>{opps.map((o: Row) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field><Btn a="link_opportunity">Link</Btn></ActionForm>
              <ActionForm action={act} className="mt-3 space-y-2"><Field label="Or propose new deal" hint="Goes to Review"><Input name="name" placeholder={s.title} /></Field><Btn a="propose_opportunity">Propose deal</Btn></ActionForm>
            </Card>
            {s.org_id ? <Card title="Research"><ActionForm action={researchNowAction.bind(null, s.org_id)}><p className="mb-3 text-sm text-ink-soft">Search the web for recent news about this company (uses a small amount of AI credit).</p><Submit variant="secondary">Research this company</Submit></ActionForm></Card> : null}
            <Card title="Company">
              <ActionForm action={act} className="space-y-2"><Field label="Correct company"><Select name="org_id" defaultValue={s.org_id ?? ""}><option value="">Pick…</option>{orgs.map((o: Row) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</Select></Field><Btn a="correct_company">Save company</Btn></ActionForm>
            </Card>
            <Card title="Evidence">
              <ActionForm action={act} className="space-y-2">
                <Field label="Text"><Textarea name="text" rows={3} /></Field>
                <Field label="Source"><Input name="source" /></Field>
                <MoreFields>
                  <Field label="Date"><Input name="published_on" type="date" /></Field>
                  <Field label="Link"><Input name="url" type="url" /></Field>
                </MoreFields>
                <div className="flex gap-2"><Btn a="add_evidence">Add supporting</Btn><Btn a="add_counter">Add counter</Btn></div>
              </ActionForm>
            </Card>
            <Card title="Override priority">
              <ActionForm action={act} className="space-y-2">
                <Field label="Priority"><Select name="band" defaultValue={s.priority_band}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></Select></Field>
                <Field label="Reason"><Input name="reason" required /></Field>
                <MoreFields><Field label="Review on"><Input name="review_on" type="date" /></Field></MoreFields>
                <Btn a="override_priority">Save override</Btn>
              </ActionForm>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
