import Link from "next/link";
import { Suspense } from "react";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { overview } from "@/modules/contacts/queries";
import { sources } from "@/modules/contacts/service";
import { discoverAction, bulkAction, approveAction, rejectAction, retryAction } from "@/modules/contacts/actions";
import { Chip, ROLE, REL, STAGE, host } from "@/modules/contacts/ui/parts";
import { DEPARTMENTS } from "@/modules/contacts/rules";

export const metadata = { title: "Contacts" };
type Row = Record<string, any>;
type SP = { tab?: string; q?: string; dept?: string; org?: string; loc?: string };
const TABS = [["review", "To review"], ["research", "Find people"], ["decision", "Decision-makers"], ["enrich", "Enrich"], ["missing", "Missing info"], ["changes", "Job changes"], ["duplicates", "Duplicates"], ["sources", "Sources"], ["history", "History"]] as const;
const sel = "min-h-10 rounded-xl border border-line bg-surface px-3 text-sm";

function FieldTable({ fields }: { fields: Row[] }) {
  const show = fields.filter((f) => f.field !== "full_name");
  const L: Record<string, string> = { employer: "Employer", designation: "Designation", department: "Department", location: "Location", profile: "Profile", email: "Email", phone: "Phone", cre_role: "CRE role" };
  return (
    <table className="w-full text-sm"><tbody className="divide-y divide-line">
      {show.map((f, i) => (
        <tr key={i} className="align-top">
          <th scope="row" className="w-28 py-2 pr-3 text-left font-normal text-ink-soft">{L[f.field] ?? f.field}</th>
          <td className="py-2 pr-3">{f.field === "cre_role" ? ROLE[f.value] ?? f.value : f.display ?? f.value ?? <span className="text-ink-soft">—</span>}
            {f.note ? <span className="block text-xs text-ink-soft">{f.note}</span> : null}
            {(f.evidence ?? []).length ? <span className="block text-xs text-ink-soft">{(f.evidence as Row[]).map((e) => e.note).join(" · ")}</span> : null}</td>
          <td className="py-2 text-right"><Chip s={f.status} /></td>
        </tr>
      ))}
    </tbody></table>
  );
}

async function Review({ db, ws, editor }: { db: Row; ws: string; editor: boolean }) {
  const { data } = await db.from("enrichment_item").select("*, org:org_id(display_name)").eq("workspace_id", ws).eq("decision", "pending").order("created_at", { ascending: false }).limit(40);
  const items = (data ?? []) as Row[];
  if (!items.length) return <Empty title="Nothing to review" text="Use Find people to research a company, or Enrich to refresh existing contacts." />;
  return (
    <ul className="space-y-4">
      {items.map((it) => {
        const src = (it.fields as Row[]).find((f) => f.source_url);
        return (
          <li key={it.id} className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">{it.full_name}</p>
                <p className="text-sm text-ink-soft">{it.org?.display_name}{src ? <> · from <a className="underline" href={src.source_url} target="_blank" rel="noreferrer noopener">{src.source_name || host(src.source_url)}</a></> : null}</p>
              </div>
              <div className="flex flex-wrap gap-1.5"><span className="rounded-full bg-canvas px-2.5 py-0.5 text-xs">{STAGE[it.stage]}</span><span className="rounded-full bg-canvas px-2.5 py-0.5 text-xs">{ROLE[it.role_class ?? "unknown"]}</span><span className="rounded-full bg-canvas px-2.5 py-0.5 text-xs">{it.completeness}% complete</span></div>
            </div>
            <p className={`mt-3 rounded-xl px-3 py-2 text-sm ${it.match_kind === "new" ? "bg-canvas" : "bg-amber-50 text-amber-900"}`}>{it.match_reason}</p>
            <div className="mt-3"><FieldTable fields={it.fields} /></div>
            {editor ? (
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <ActionForm action={approveAction.bind(null, it.id)} className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end">
                  {it.match_kind === "possible_duplicate" || it.match_kind === "job_change" ? (
                    <label className="flex-1 text-sm">This person is…<select name="as" required defaultValue="" className={`${sel} mt-1 w-full`}><option value="" disabled>Choose</option><option value="new">A new person</option>{(it.match_candidates as Row[]).map((m) => <option key={m.id} value={m.id}>Same as {m.name} ({m.why})</option>)}</select></label>
                  ) : null}
                  <Submit>Approve</Submit>
                </ActionForm>
                <ActionForm action={rejectAction.bind(null, it.id)} className="flex gap-2"><input name="reason" placeholder="Why reject?" aria-label="Reason" className={sel} /><Submit variant="secondary">Reject</Submit></ActionForm>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

async function Research({ db, ws, editor }: { db: Row; ws: string; editor: boolean }) {
  const { data: orgs } = await db.from("organisation").select("id, display_name").eq("workspace_id", ws).is("archived_at", null).order("display_name").limit(1000);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="rounded-2xl border border-line bg-surface p-5">
        <h2 className="font-semibold">Find the right people at a company</h2>
        <p className="mt-1 text-sm text-ink-soft">Searches the company&apos;s website, leadership pages and press releases for real estate, facilities, admin, procurement, finance, HR and site leadership. Only published details are kept, each with its source. Nothing is saved until you approve it.</p>
        {editor ? (
          <ActionForm action={discoverAction} className="mt-4 space-y-3">
            <select name="org_id" required defaultValue="" aria-label="Company" className={`${sel} w-full`}><option value="" disabled>Choose a company</option>{(orgs ?? []).map((o: Row) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="force" value="1" /> Run again even if researched today</label>
            <Submit>Find people</Submit>
          </ActionForm>
        ) : null}
      </section>
      <section className="rounded-2xl border border-line bg-surface p-5 text-sm">
        <h2 className="font-semibold">Roles we look for</h2>
        <ul className="mt-2 space-y-1">{DEPARTMENTS.map((d) => <li key={d.key}>{d.label} <span className="text-ink-soft">— {REL[d.relevance].toLowerCase()}</span></li>)}</ul>
      </section>
    </div>
  );
}

async function People({ db, ws, sp, mode }: { db: Row; ws: string; sp: SP; mode: "decision" | "missing" | "enrich" }) {
  let q = db.from("person").select("id, full_name, last_enriched_at, next_review_on, do_not_contact, employment(title, is_current, org:org_id(id, display_name)), contact_method(method_type, verify_status, suppressed), contact_role_assessment(role_class, cre_relevance, active)").eq("workspace_id", ws).is("archived_at", null);
  if (sp.q) q = q.ilike("full_name", `%${sp.q}%`);
  const { data } = await q.order("full_name").limit(1000);
  let people: Row[] = ((data ?? []) as Row[]).map((p): Row => {
    const e = (p.employment ?? []).find((x: Row) => x.is_current); const ra = (p.contact_role_assessment ?? []).find((x: Row) => x.active);
    const ch = (p.contact_method ?? []).filter((m: Row) => !m.suppressed);
    return { ...p, cur: e, ra, hasEmail: ch.some((m: Row) => m.method_type === "email" && !["invalid"].includes(m.verify_status)), hasPhone: ch.some((m: Row) => m.method_type === "phone" && m.verify_status !== "invalid") };
  });
  if (sp.org) people = people.filter((p) => p.cur?.org?.id === sp.org);
  if (sp.dept) { const d = DEPARTMENTS.find((x) => x.key === sp.dept); if (d) people = people.filter((p) => d.re.test(p.cur?.title ?? "")); }
  if (mode === "decision") people = people.filter((p) => ["high", "medium"].includes(p.ra?.cre_relevance)).sort((a, b) => (a.ra.cre_relevance === "high" ? 0 : 1) - (b.ra.cre_relevance === "high" ? 0 : 1));
  if (mode === "missing") people = people.filter((p) => !p.hasEmail || !p.hasPhone || !p.cur?.title || !p.cur);
  if (mode === "enrich") people = people.filter((p) => !p.do_not_contact && (!p.last_enriched_at || (p.next_review_on && p.next_review_on <= new Date().toISOString().slice(0, 10))));
  const list = people.slice(0, 200);
  const filters = (
    <form method="get" className="mb-3 flex flex-wrap gap-2">
      <input type="hidden" name="tab" value={sp.tab} />
      <input name="q" defaultValue={sp.q} placeholder="Name" aria-label="Name" className={`${sel} min-w-40 flex-1`} />
      <select name="dept" defaultValue={sp.dept ?? ""} aria-label="Department" className={sel}><option value="">Any department</option>{DEPARTMENTS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select>
      <button className="min-h-10 rounded-xl bg-ink px-4 text-sm font-semibold text-white">Filter</button>
    </form>
  );
  if (!list.length) return <>{filters}<Empty title={mode === "decision" ? "No decision-makers identified yet" : mode === "missing" ? "No gaps found" : "Nothing waiting"} text={mode === "decision" ? "Approve people from the review queue — their role and CRE relevance are recorded here." : "All contacts in this view are up to date."} /></>;
  const rows = list.map((p) => (
    <li key={p.id} className="flex items-center gap-3 px-4 py-3">
      {mode === "enrich" ? <input type="checkbox" name="person_id" value={p.id} defaultChecked aria-label={`Select ${p.full_name}`} /> : null}
      <Link href={`/contacts/${p.id}`} className="min-w-0 flex-1 hover:text-brand"><span className="block truncate font-medium">{p.full_name}{p.do_not_contact ? <span className="ml-2 text-xs text-rose-700">do not contact</span> : null}</span><span className="block truncate text-xs text-ink-soft">{p.cur ? `${p.cur.title ?? "No designation"} · ${p.cur.org?.display_name ?? ""}` : "No current employer"}</span></Link>
      <span className="hidden text-xs sm:block">{p.ra ? `${ROLE[p.ra.role_class]} · ${REL[p.ra.cre_relevance]}` : "Not assessed"}</span>
      {mode === "missing" ? <span className="text-xs text-amber-800">{[!p.cur && "employer", p.cur && !p.cur.title && "designation", !p.hasEmail && "email", !p.hasPhone && "phone"].filter(Boolean).join(", ")}</span> : null}
    </li>
  ));
  if (mode === "enrich") return (
    <>{filters}
      <ActionForm action={bulkAction} className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="web" value="1" /> Also search the web (about 1–2 searches per contact)</label>
          <Submit>Enrich selected</Submit>
          <span className="text-xs text-ink-soft">Without web search: emails and phones are re-checked (format, domain, MX). Up to 200 at a time.</span>
        </div>
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{rows}</ul>
      </ActionForm>
    </>
  );
  return <>{filters}<ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{rows}</ul></>;
}

async function Changes({ db, ws }: { db: Row; ws: string }) {
  const [{ data: items }, { data: props }] = await Promise.all([
    db.from("enrichment_item").select("id, full_name, match_reason, match_candidates, org:org_id(display_name), decision, created_at").eq("workspace_id", ws).eq("match_kind", "job_change").order("created_at", { ascending: false }).limit(50),
    db.from("change_proposal").select("id, reason, state, created_at").eq("workspace_id", ws).like("idempotency_key", "contacts.move:%").order("created_at", { ascending: false }).limit(50),
  ]);
  if (!items?.length && !props?.length) return <Empty title="No job changes detected" text="When enrichment finds a contact at a different company, it shows here. The old role is kept as history and the change waits for approval." />;
  return (
    <div className="space-y-4">
      {(items ?? []).map((it: Row) => <div key={it.id} className="rounded-2xl border border-line bg-surface p-4 text-sm"><p className="font-medium">{it.full_name} → {it.org?.display_name}</p><p className="text-ink-soft">{it.match_reason}</p><p className="mt-1 text-xs">Status: {it.decision === "pending" ? "waiting for your review (To review tab)" : it.decision}</p></div>)}
      {(props ?? []).length ? <p className="text-sm"><Link className="font-semibold text-brand underline" href="/approvals">{props!.filter((p: Row) => !["applied", "rejected"].includes(p.state)).length} employment change(s) waiting in Review</Link></p> : null}
    </div>
  );
}

async function Duplicates({ db, ws }: { db: Row; ws: string }) {
  const { data } = await db.from("person").select("id, full_name, employment(is_current, org:org_id(display_name)), contact_method(value, method_type)").eq("workspace_id", ws).is("archived_at", null).limit(3000);
  const groups = new Map<string, Row[]>();
  for (const p of (data ?? []) as Row[]) { const k = String(p.full_name).toLowerCase().replace(/[^a-z]/g, ""); if (k.length < 5) continue; groups.set(k, [...(groups.get(k) ?? []), p]); }
  const dup = [...groups.values()].filter((g) => g.length > 1).slice(0, 50);
  if (!dup.length) return <Empty title="No possible duplicates" text="Contacts with the same name show here for a side-by-side check. Nothing is merged automatically." />;
  return (
    <ul className="space-y-4">
      {dup.map((g, i) => (
        <li key={i} className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-ink-soft">Same name — check employer and email before merging. Name alone is never enough.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {g.slice(0, 4).map((p) => { const e = (p.employment ?? []).find((x: Row) => x.is_current); return (
              <Link key={p.id} href={`/contacts/${p.id}`} className="rounded-xl bg-canvas p-3 text-sm hover:ring-1 hover:ring-brand/30"><span className="block font-medium">{p.full_name}</span><span className="block text-xs text-ink-soft">{e?.org?.display_name ?? "No current employer"}</span><span className="block text-xs text-ink-soft">{(p.contact_method ?? []).filter((m: Row) => m.method_type === "email").map((m: Row) => m.value).join(", ") || "No email"}</span></Link>
            ); })}
          </div>
        </li>
      ))}
    </ul>
  );
}

async function History({ db, ws, editor }: { db: Row; ws: string; editor: boolean }) {
  const { data } = await db.from("enrichment_job").select("id, kind, label, status, total, done, failed, usd, error, created_at, sites").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(50);
  if (!data?.length) return <Empty title="No enrichment runs yet" text="Runs appear here with what they searched, the sites they read and the result." />;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {(data as Row[]).map((j) => (
        <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <span className={`h-2.5 w-2.5 rounded-full ${j.status === "done" ? "bg-emerald-500" : j.status === "running" ? "bg-brand" : j.status === "partial" ? "bg-amber-400" : "bg-rose-500"}`} aria-hidden />
          <Link href={`/contacts/job/${j.id}`} className="min-w-0 flex-1 hover:text-brand"><span className="block font-medium">{j.label}</span><span className="block text-xs text-ink-soft">{new Date(j.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {j.done}/{j.total} done{j.failed ? `, ${j.failed} failed` : ""} · {(j.sites ?? []).length} sites{Number(j.usd) ? ` · $${Number(j.usd).toFixed(3)}` : ""}{j.error ? ` · ${j.error}` : ""}</span></Link>
          {editor && ["failed", "partial"].includes(j.status) ? <ActionForm action={retryAction.bind(null, j.id)}><Submit variant="secondary">Retry</Submit></ActionForm> : null}
        </li>
      ))}
    </ul>
  );
}

function Sources() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {sources().map((s) => (
        <li key={s.key} className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-2"><p className="font-medium">{s.label}</p><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.available ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{s.available ? "Available" : "Not connected"}</span></div>
          <p className="text-xs text-ink-soft">{s.kind}</p><p className="mt-2 text-sm">{s.note}</p>
        </li>
      ))}
    </ul>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center"><p className="font-semibold">{title}</p><p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{text}</p></div>;
}

async function Body({ sp }: { sp: SP }) {
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  const o = await overview(ctx.db, ctx.workspaceId);
  const tab = sp.tab ?? (o.review ? "review" : "research");
  const tiles: [string, number][] = [["Contacts", o.total], ["Found this week", o.fresh], ["Enriched", o.enriched], ["Verified channels", o.verifiedPeople], ["To review", o.review], ["Partly enriched", o.partial], ["Due for re-check", o.outdated], ["Possible duplicates", o.dups], ["Failed runs", o.failedJobs]];
  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Contacts</h1><p className="mt-1 max-w-2xl text-ink-soft">Find the people who decide on office space, check their details against real sources, and keep every field labelled with how sure we are.</p></header>
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-9">
        {tiles.map(([l, n]) => <div key={l} className="bg-surface p-3"><dt className="text-xs text-ink-soft">{l}</dt><dd className="mt-1 text-xl font-bold tabular-nums">{n.toLocaleString("en-IN")}</dd></div>)}
      </dl>
      <nav aria-label="Contact sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-line pb-px">
        {TABS.map(([k, l]) => <Link key={k} href={`/contacts?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm ${tab === k ? "border-ink font-semibold" : "border-transparent text-ink-soft hover:text-ink"}`}>{l}{k === "review" && o.review ? <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs text-white">{o.review}</span> : null}</Link>)}
      </nav>
      {tab === "review" ? <Review db={ctx.db} ws={ctx.workspaceId} editor={editor} />
        : tab === "research" ? <Research db={ctx.db} ws={ctx.workspaceId} editor={editor} />
        : tab === "decision" || tab === "missing" || tab === "enrich" ? <People db={ctx.db} ws={ctx.workspaceId} sp={{ ...sp, tab }} mode={tab} />
        : tab === "changes" ? <Changes db={ctx.db} ws={ctx.workspaceId} />
        : tab === "duplicates" ? <Duplicates db={ctx.db} ws={ctx.workspaceId} />
        : tab === "sources" ? <Sources /> : <History db={ctx.db} ws={ctx.workspaceId} editor={editor} />}
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return <Suspense fallback={<Loading />}><Body sp={sp} /></Suspense>;
}
