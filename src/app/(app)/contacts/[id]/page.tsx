import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { enrichOneAction, roleAction, confirmChannelAction, dncAction, duplicateAction, taskAction, interactionAction, archiveAction } from "@/modules/contacts/actions";
import { Chip, ROLE, REL, host } from "@/modules/contacts/ui/parts";
import { completeness } from "@/modules/contacts/rules";

export const metadata = { title: "Contact" };
type Row = Record<string, any>;
const sel = "min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm";
const d = (s?: string | null) => (s ? new Date(s).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("viewer");
  const { data: p } = await ctx.db.from("person").select("*, employment(id, title, start_date, end_date, is_current, fact_status, updated_at, org:org_id(id, display_name)), contact_method(id, method_type, value, verify_status, verify_evidence, source_name, source_url, observed_on, verified_on, suppressed, last_checked_at), contact_role_assessment(role_class, cre_relevance, department, reason, source, evidence, created_at, active)").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!p) notFound();
  const [{ data: links }, { data: score }, { data: items }, { data: stake }, { data: audit }] = await Promise.all([
    ctx.db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, subject, is_meaningful)").eq("workspace_id", ctx.workspaceId).eq("entity_type", "person").eq("entity_id", id).limit(50),
    ctx.db.from("score_result").select("score, band, confidence").eq("workspace_id", ctx.workspaceId).eq("model_key", "contact").eq("entity_id", id).eq("is_current", true).maybeSingle(),
    ctx.db.from("enrichment_item").select("id, created_at, decision, fields, job_id").eq("workspace_id", ctx.workspaceId).eq("person_id", id).order("created_at", { ascending: false }).limit(10),
    ctx.db.from("stakeholder").select("role, requirement:requirement_id(id, title)").eq("workspace_id", ctx.workspaceId).eq("person_id", id).is("archived_at", null),
    ctx.db.from("audit_event").select("action, entity_type, created_at").eq("workspace_id", ctx.workspaceId).eq("entity_id", id).order("created_at", { ascending: false }).limit(10),
  ]);
  const emps = ((p.employment ?? []) as Row[]).sort((a, b) => Number(b.is_current) - Number(a.is_current) || String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")));
  const cur = emps.find((e) => e.is_current);
  const ra = ((p.contact_role_assessment ?? []) as Row[]).find((r) => r.active);
  const methods = (p.contact_method ?? []) as Row[];
  const ints = ((links ?? []) as Row[]).map((l) => l.interaction).filter(Boolean).sort((a: Row, b: Row) => b.occurred_at.localeCompare(a.occurred_at));
  const fieldRows = [
    { field: "full_name", label: "Name", value: p.full_name, status: "reported" },
    { field: "employer", label: "Employer", value: cur?.org?.display_name ?? null, status: cur ? (cur.fact_status === "currently_confirmed" ? "verified" : "reported") : "missing" },
    { field: "designation", label: "Designation", value: cur?.title ?? null, status: cur?.title ? (cur.fact_status === "currently_confirmed" ? "verified" : "reported") : "missing" },
    { field: "department", label: "Department", value: ra?.department ?? null, status: ra?.department ? (ra.source === "user" ? "user_provided" : "inferred") : "unknown" },
    { field: "email", label: "Email", value: methods.find((m) => m.method_type === "email")?.value ?? null, status: methods.find((m) => m.method_type === "email")?.verify_status ?? "missing" },
    { field: "phone", label: "Phone", value: methods.find((m) => m.method_type === "phone")?.value ?? null, status: methods.find((m) => m.method_type === "phone")?.verify_status ?? "missing" },
    { field: "profile", label: "Profile", value: p.public_profile_url, status: p.public_profile_url ? "reported" : "missing" },
    { field: "cre_role", label: "CRE role", value: ra ? ROLE[ra.role_class] : null, status: ra ? (ra.source === "user" ? "user_provided" : "inferred") : "unknown" },
  ];
  const comp = completeness(fieldRows as never);
  const editor = hasRole(ctx, "editor");
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link href="/contacts" className="text-sm text-ink-soft hover:text-ink">Contacts</Link>
      <header className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{p.full_name}</h1>
          <p className="mt-1 text-ink-soft">{cur ? <>{cur.title ?? "No designation"} at <Link className="text-ink underline-offset-2 hover:underline" href={`/contacts/company/${cur.org?.id}`}>{cur.org?.display_name}</Link></> : "No current employer"}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-canvas px-2.5 py-1">{comp}% of profile known</span>
            <span className="rounded-full bg-canvas px-2.5 py-1">Last enriched {d(p.last_enriched_at)}</span>
            <span className="rounded-full bg-canvas px-2.5 py-1">Next check {d(p.next_review_on)}</span>
            {p.do_not_contact ? <span className="rounded-full bg-rose-50 px-2.5 py-1 font-medium text-rose-700">Do not contact</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {score ? <Link href={`/scoring/contact/${id}`} className="rounded-xl bg-canvas px-4 py-2 text-center"><span className="text-2xl font-bold tabular-nums">{score.score}</span><span className="text-ink-soft">/100</span><span className="block text-xs text-ink-soft">Contact relevance · {score.band}</span></Link> : null}
          {editor ? <ActionForm action={enrichOneAction.bind(null, id)}><Submit>Enrich now</Submit></ActionForm> : null}
          {editor ? <Link href={`/people/${id}/edit`} className="inline-flex min-h-10 items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold">Edit</Link> : null}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">What we know, field by field</h2>
            <table className="mt-3 w-full text-sm"><tbody className="divide-y divide-line">
              {fieldRows.map((f) => <tr key={f.field}><th scope="row" className="w-28 py-2 text-left font-normal text-ink-soft">{f.label}</th><td className="py-2">{f.value ?? <span className="text-ink-soft">—</span>}</td><td className="py-2 text-right"><Chip s={f.status} /></td></tr>)}
            </tbody></table>
            <p className="mt-2 text-xs text-ink-soft">Each field has its own status. One verified field does not make the whole profile verified.</p>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Business contact details</h2>
            {methods.length ? <ul className="mt-3 divide-y divide-line">
              {methods.map((m) => (
                <li key={m.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className={m.suppressed ? "line-through text-ink-soft" : "font-medium"}>{m.value}</span><span className="flex items-center gap-2"><span className="text-xs capitalize text-ink-soft">{m.method_type}</span><Chip s={m.verify_status ?? (m.verified_on ? "verified" : "unknown")} /></span></div>
                  <p className="mt-1 text-xs text-ink-soft">{m.source_url ? <>Source: <a className="underline" href={m.source_url} target="_blank" rel="noreferrer noopener">{m.source_name || host(m.source_url)}</a>{m.observed_on ? `, ${d(m.observed_on)}` : ""}</> : m.source_name ? `Source: ${m.source_name}` : "Source not recorded"}{m.last_checked_at ? ` · checked ${d(m.last_checked_at)}` : ""}</p>
                  {(m.verify_evidence ?? []).length ? <ul className="mt-1 text-xs text-ink-soft">{(m.verify_evidence as Row[]).map((e, i) => <li key={i}>{e.ok === true ? "✓" : e.ok === false ? "✗" : "•"} {e.note}</li>)}</ul> : null}
                  {editor && m.verify_status !== "verified" && !m.suppressed ? <ActionForm action={confirmChannelAction.bind(null, id, m.id)} className="mt-2 flex gap-2"><input name="how" placeholder="How confirmed? (e.g. replied from it)" aria-label="How confirmed" className={`${sel} flex-1`} /><Submit variant="secondary">Mark verified</Submit></ActionForm> : null}
                </li>
              ))}
            </ul> : <p className="mt-2 text-sm text-ink-soft">No business email or phone recorded. Enrichment never guesses addresses.</p>}
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Employment history</h2>
            <ol className="mt-3 space-y-3">
              {emps.map((e) => <li key={e.id} className="text-sm"><span className="font-medium">{e.title ?? "No designation"}</span> at {e.org?.display_name}<span className="block text-xs text-ink-soft">{e.start_date ? d(e.start_date) : "Start unknown"} – {e.is_current ? "now" : e.end_date ? d(e.end_date) : "ended"} · {String(e.fact_status).replace(/_/g, " ")}</span></li>)}
              {!emps.length ? <li className="text-sm text-ink-soft">No employment recorded.</li> : null}
            </ol>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Relationship</h2>
            <p className="mt-1 text-sm text-ink-soft">{ints.length} interaction(s){ints[0] ? `, last ${d(ints[0].occurred_at)}` : ""}. {(stake ?? []).length ? `Stakeholder on ${(stake ?? []).map((s: Row) => s.requirement?.title).join(", ")}.` : ""}</p>
            <ul className="mt-2 space-y-1 text-sm">{ints.slice(0, 8).map((i: Row) => <li key={i.id}>{d(i.occurred_at)} · {i.channel}{i.subject ? ` — ${i.subject}` : ""}</li>)}</ul>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Evidence and history</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {((items ?? []) as Row[]).map((it) => { const s = (it.fields as Row[]).find((f) => f.source_url); return <li key={it.id}>{d(it.created_at)} · enrichment {it.decision}{s ? <> · <a className="underline" href={s.source_url} target="_blank" rel="noreferrer noopener">{s.source_name || host(s.source_url)}</a></> : null}</li>; })}
              {((audit ?? []) as Row[]).map((a, i) => <li key={i} className="text-ink-soft">{d(a.created_at)} · {a.action}</li>)}
              {!(items ?? []).length && !(audit ?? []).length ? <li className="text-ink-soft">No history yet.</li> : null}
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">CRE relevance</h2>
            {ra ? <><p className="mt-1 text-lg font-semibold">{ROLE[ra.role_class]}</p><p className="text-sm">{REL[ra.cre_relevance]}{ra.department ? ` · ${ra.department}` : ""}</p><p className="mt-2 text-xs text-ink-soft">{ra.source === "user" ? "Set by your team" : "Assessed from title"}: {ra.reason}</p></> : <p className="mt-1 text-sm text-ink-soft">Not assessed yet.</p>}
            {editor ? (
              <ActionForm action={roleAction.bind(null, id)} className="mt-4 space-y-2">
                <select name="role" defaultValue={ra?.role_class ?? "unknown"} aria-label="Role" className={sel}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <select name="relevance" defaultValue={ra?.cre_relevance ?? "unknown"} aria-label="CRE relevance" className={sel}>{Object.entries(REL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input name="reason" placeholder="Why? (required)" aria-label="Reason" className={sel} />
                <Submit variant="secondary">Correct role</Submit>
              </ActionForm>
            ) : null}
          </section>
          {editor ? (
            <>
              <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="font-semibold">Log an interaction</h2>
                <ActionForm action={interactionAction.bind(null, id)} className="mt-3 space-y-2">
                  <select name="channel" aria-label="Type" className={sel}><option value="call">Call</option><option value="meeting">Meeting</option><option value="email">Email</option><option value="visit">Site visit</option><option value="note">Note</option></select>
                  <input name="subject" placeholder="Subject" aria-label="Subject" className={sel} /><input name="when" type="datetime-local" aria-label="When" className={sel} />
                  <Submit variant="secondary">Save</Submit>
                </ActionForm></section>
              <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="font-semibold">Create a task</h2>
                <ActionForm action={taskAction.bind(null, id)} className="mt-3 space-y-2"><input name="title" placeholder="e.g. Ask about Pune expansion" aria-label="Task" className={sel} /><Submit variant="secondary">Create task</Submit></ActionForm></section>
              <details className="rounded-2xl border border-line bg-surface p-5"><summary className="cursor-pointer font-semibold">More actions</summary>
                <div className="mt-3 space-y-4">
                  <ActionForm action={duplicateAction.bind(null, id)} className="space-y-2"><p className="text-sm font-medium">Flag duplicate</p><input name="dup_id" placeholder="Duplicate contact ID (from its URL)" aria-label="Duplicate ID" className={sel} /><input name="reason" placeholder="Why? (same email, same company…)" aria-label="Reason" className={sel} /><Submit variant="secondary">Propose merge</Submit></ActionForm>
                  <ActionForm action={dncAction.bind(null, id, !p.do_not_contact)} className="space-y-2"><p className="text-sm font-medium">{p.do_not_contact ? "Remove do-not-contact" : "Mark do-not-contact"}</p>{!p.do_not_contact ? <input name="reason" placeholder="Reason" aria-label="Reason" className={sel} /> : null}<Submit variant={p.do_not_contact ? "secondary" : "danger"}>{p.do_not_contact ? "Remove" : "Do not contact"}</Submit></ActionForm>
                  <ActionForm action={archiveAction.bind(null, id)} className="space-y-2"><p className="text-sm font-medium">Archive contact</p><input name="reason" placeholder="Reason" aria-label="Reason" className={sel} /><Submit variant="secondary">Propose archive</Submit></ActionForm>
                </div>
              </details>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
