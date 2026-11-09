import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { companyPeople } from "@/modules/contacts/queries";
import { discoverAction, managerAction } from "@/modules/contacts/actions";
import { classify, DEPARTMENTS } from "@/modules/contacts/rules";
import { Chip, ROLE, REL } from "@/modules/contacts/ui/parts";

export const metadata = { title: "Company contacts" };
type Row = Record<string, any>;
const ORDER = ["Business Leadership", "Corporate Real Estate", "Facilities & Administration", "Procurement", "Finance", "Human Resources", "Other"];

export default async function Page({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const ctx = await requirePageContext("viewer");
  const { data: org } = await ctx.db.from("organisation").select("id, display_name, sector").eq("workspace_id", ctx.workspaceId).eq("id", orgId).maybeSingle();
  if (!org) notFound();
  const { people, lines } = await companyPeople(ctx.db, ctx.workspaceId, orgId);
  const byId = new Map(people.map((e) => [e.person?.id, e]));
  const groups = new Map<string, Row[]>();
  for (const e of people) {
    if (!e.person) continue;
    const ra = (e.person.contact_role_assessment ?? []).find((r: Row) => r.active);
    const dept = ra?.department ?? classify(e.title).department ?? "Other";
    groups.set(dept, [...(groups.get(dept) ?? []), { ...e, ra }]);
  }
  const editor = hasRole(ctx, "editor");
  return (
    <div className="space-y-6">
      <Link href="/contacts" className="text-sm text-ink-soft hover:text-ink">Contacts</Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-2xl font-bold">{org.display_name}</h1><p className="text-ink-soft">{people.length} people by team. Reporting lines are shown only when someone has set them — never guessed from titles.</p></div>
        {editor ? <ActionForm action={discoverAction}><input type="hidden" name="org_id" value={orgId} /><Submit>Find more people</Submit></ActionForm> : null}
      </header>
      {!people.length ? <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-ink-soft">No people recorded at this company yet. Press <b>Find more people</b>.</div> : null}
      {ORDER.filter((g) => groups.has(g)).map((g) => (
        <section key={g}>
          <h2 className="mb-2 font-semibold">{g} <span className="font-normal text-ink-soft">({groups.get(g)!.length})</span></h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.get(g)!.map((e) => {
              const p = e.person; const mgr = lines.find((l) => l.person_id === p.id);
              const ch = (p.contact_method ?? []).filter((m: Row) => !m.suppressed);
              return (
                <li key={p.id} className="rounded-2xl border border-line bg-surface p-4">
                  <Link href={`/contacts/${p.id}`} className="font-medium hover:text-brand">{p.full_name}</Link>
                  <p className="text-sm text-ink-soft">{e.title ?? "No designation"}</p>
                  <p className="mt-2 text-xs">{e.ra ? `${ROLE[e.ra.role_class]} · ${REL[e.ra.cre_relevance]}` : "Role not assessed"}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">{ch.length ? ch.map((m: Row) => <span key={m.id} className="flex items-center gap-1 text-xs"><span className="capitalize text-ink-soft">{m.method_type}</span><Chip s={m.verify_status ?? "unknown"} /></span>) : <span className="text-xs text-ink-soft">No business channels</span>}</div>
                  <p className="mt-2 text-xs text-ink-soft">{p.do_not_contact ? "Do not contact · " : ""}Employment {String(e.fact_status).replace(/_/g, " ")}{mgr ? ` · reports to ${byId.get(mgr.manager_person_id)?.person?.full_name ?? "—"}` : ""}</p>
                  {editor && people.length > 1 ? (
                    <details className="mt-2"><summary className="cursor-pointer text-xs text-brand">Set manager</summary>
                      <ActionForm action={managerAction.bind(null, orgId, p.id)} className="mt-2 space-y-2">
                        <select name="manager_id" defaultValue={mgr?.manager_person_id ?? ""} aria-label="Manager" className="min-h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"><option value="">No manager set</option>{people.filter((x) => x.person && x.person.id !== p.id).map((x) => <option key={x.person.id} value={x.person.id}>{x.person.full_name}</option>)}</select>
                        <input name="note" placeholder="How do you know? (e.g. org chart from client)" aria-label="Note" className="min-h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm" />
                        <Submit variant="secondary">Save</Submit>
                      </ActionForm></details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="text-xs text-ink-soft">Teams come from each person&apos;s role assessment, or their title ({DEPARTMENTS.map((d) => d.label).join(", ")}).</p>
    </div>
  );
}
