import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { createAction } from "@/modules/meetings/actions";
import { MEETING_TYPES } from "@/modules/meetings/rules";

export const metadata = { title: "New meeting" };
type Row = Record<string, any>;
const f = "mt-1 min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm";

export default async function Page({ searchParams }: { searchParams: Promise<{ org?: string; person?: string; opportunity?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext("editor");
  const [{ data: orgs }, { data: opps }, { data: reqs }, { data: people }, { data: assets }] = await Promise.all([
    ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("display_name").limit(1000),
    ctx.db.from("opportunity").select("id, name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).eq("outcome", "open").order("name").limit(500),
    ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("title").limit(500),
    ctx.db.from("person").select("id, full_name, employment(is_current, org:org_id(display_name))").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("full_name").limit(1000),
    ctx.db.from("asset").select("id, name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(1000),
  ]);
  const d = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/meetings" className="text-sm text-ink-soft hover:text-ink">← Meetings</Link>
      <h1 data-tour="meetings-new-form" className="text-2xl font-bold">New meeting</h1>
      <ActionForm action={createAction} className="space-y-4 rounded-2xl border border-line bg-surface p-5">
        <label className="block text-sm font-medium">Title<input name="title" required placeholder="e.g. VertexNova — requirement discussion" className={f} /></label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm font-medium">Date<input type="date" name="date" required defaultValue={d} className={f} /></label>
          <label className="block text-sm font-medium">Time<input type="time" name="time" required defaultValue="11:00" className={f} /></label>
          <label className="block text-sm font-medium">Minutes<input type="number" name="minutes" defaultValue={60} min={15} step={15} className={f} /></label>
        </div>
        <label className="block text-sm font-medium">Type<select name="type" className={f} defaultValue="discovery">{Object.entries(MEETING_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label className="block text-sm font-medium">Company<select name="org_id" defaultValue={sp.org ?? ""} className={f}><option value="">—</option>{((orgs ?? []) as Row[]).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>
        <label className="block text-sm font-medium">Contacts attending<select name="person_id" multiple defaultValue={sp.person ? [sp.person] : []} className={`${f} h-32`}>{((people ?? []) as Row[]).map((p) => { const e = (p.employment ?? []).find((x: Row) => x.is_current); return <option key={p.id} value={p.id}>{p.full_name}{e?.org ? ` — ${e.org.display_name}` : ""}</option>; })}</select><span className="text-xs font-normal text-ink-soft">Hold Ctrl (or ⌘) to pick several.</span></label>
        <label className="block text-sm font-medium">Other attendees<textarea name="external" rows={2} placeholder={"One per line: Name email@company.com"} className={`${f} py-2`} /></label>
        <details className="rounded-xl bg-canvas p-3"><summary className="cursor-pointer text-sm font-medium">More details (optional)</summary>
          <div className="mt-3 space-y-3">
            <label className="block text-sm font-medium">Purpose<textarea name="purpose" rows={2} className={`${f} py-2`} /></label>
            <label className="block text-sm font-medium">Location<input name="location" className={f} /></label>
            <label className="block text-sm font-medium">Deal<select name="opportunity_id" defaultValue={sp.opportunity ?? ""} className={f}><option value="">—</option>{((opps ?? []) as Row[]).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
            <label className="block text-sm font-medium">Requirement<select name="requirement_id" className={f}><option value="">—</option>{((reqs ?? []) as Row[]).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}</select></label>
            <label className="block text-sm font-medium">Properties to discuss / visit<select name="asset_id" multiple className={`${f} h-28`}>{((assets ?? []) as Row[]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label className="block text-sm font-medium">Notes<textarea name="notes" rows={2} className={`${f} py-2`} /></label>
          </div>
        </details>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="prepare" value="1" defaultChecked /> Prepare the brief now</label>
        <Submit>Create meeting</Submit>
      </ActionForm>
    </div>
  );
}
