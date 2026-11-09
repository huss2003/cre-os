import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { ensureModels } from "@/modules/scoring/service";
import { MODELS, MODEL_KEYS } from "@/modules/scoring/models";
import { saveModelAction, activateVersionAction, toggleModelAction } from "@/modules/scoring/actions";
import type { ModelKey, FactorDef, Band } from "@/modules/scoring/engine";

export const metadata = { title: "Scoring rules" };
type Row = Record<string, any>;
const UNKNOWN: Record<string, string> = { exclude: "Leave out (not negative)", neutral: "Count as half", zero: "Count as zero" };
const SAMPLE: Record<ModelKey, [string, string, string]> = {
  company: ["organisation", "id, display_name", "display_name"], lead: ["organisation", "id, display_name", "display_name"], relationship: ["organisation", "id, display_name", "display_name"],
  contact: ["person", "id, full_name", "full_name"], requirement: ["requirement", "id, title", "title"], opportunity: ["opportunity", "id, name", "name"],
};

export default async function Page({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext("viewer");
  if (!hasRole(ctx, "admin")) return <p className="p-6">Only admins can change scoring rules.</p>;
  const models = await ensureModels(ctx.db, ctx.workspaceId);
  const key = (MODEL_KEYS.includes(sp.m as ModelKey) ? sp.m : "company") as ModelKey;
  const m = models[key];
  const { data: versions } = await ctx.db.from("scoring_model_version").select("id, version, factors, bands, config, note, created_at").eq("model_id", m.id).order("version", { ascending: false });
  const active = (versions ?? []).find((v: Row) => v.id === m.active_version_id) as Row;
  const [t, cols, label] = SAMPLE[key];
  const { data: samples } = await ctx.db.from(t).select(cols).eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(200);
  const factors = active.factors as FactorDef[];
  const total = factors.reduce((a, f) => a + f.weight, 0);
  const input = "min-h-10 rounded-xl border border-line bg-surface px-3 text-sm";
  return (
    <div className="space-y-6">
      <Link href="/scoring" className="text-sm text-ink-soft hover:text-ink">Scoring</Link>
      <header><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Scoring rules</h1><p className="mt-1 max-w-2xl text-ink-soft">Change weights and thresholds without code. Each save creates a new version; older versions stay so past scores can be explained, and you can switch back any time.</p></header>
      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-line pb-px">
        {MODEL_KEYS.map((k) => <Link key={k} href={`/scoring/models?m=${k}`} aria-current={k === key ? "page" : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-sm ${k === key ? "border-ink font-semibold" : "border-transparent text-ink-soft"}`}>{MODELS[k].name}</Link>)}
      </nav>
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <ActionForm action={saveModelAction.bind(null, key)} className="space-y-6">
          <section className="rounded-2xl border border-line bg-surface">
            <div className="flex items-baseline justify-between px-5 pt-5"><h2 className="font-semibold">Factors — version {active.version}</h2><span className="text-sm text-ink-soft">Weights total {total} (they are scaled to 100)</span></div>
            <p className="px-5 text-sm text-ink-soft">{MODELS[key].purpose}</p>
            <ul className="mt-3 divide-y divide-line">
              {factors.map((f) => (
                <li key={f.key} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_6rem_12rem] sm:items-center">
                  <span><span className="block font-medium">{f.label}</span><span className="block text-xs text-ink-soft">{f.description}</span></span>
                  <label className="text-xs text-ink-soft">Weight<input name={`w_${f.key}`} type="number" min={0} max={100} step={1} defaultValue={f.weight} className={`${input} mt-1 w-full`} /></label>
                  <label className="text-xs text-ink-soft">If unknown<select name={`u_${f.key}`} defaultValue={f.unknown} className={`${input} mt-1 w-full`}>{Object.entries(UNKNOWN).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid gap-4 sm:grid-cols-2">
            <label className="block rounded-2xl border border-line bg-surface p-5"><span className="font-semibold">Priority thresholds</span><span className="mt-1 block text-xs text-ink-soft">One per line: lowest score = label. One must start at 0.</span>
              <textarea name="bands" rows={6} defaultValue={(active.bands as Band[]).map((b) => `${b.min}=${b.label}`).join("\n")} className="mt-2 w-full rounded-xl border border-line bg-surface p-3 font-mono text-sm" /></label>
            {key === "company" ? (
              <label className="block rounded-2xl border border-line bg-surface p-5"><span className="font-semibold">Industry weights</span><span className="mt-1 block text-xs text-ink-soft">One per line: sector word = 0 to 1. GCCs always count as 1.</span>
                <textarea name="industry" rows={6} defaultValue={Object.entries((active.config?.industry_weights ?? {}) as Record<string, number>).map(([k, v]) => `${k}=${v}`).join("\n")} className="mt-2 w-full rounded-xl border border-line bg-surface p-3 font-mono text-sm" />
                <span className="mt-3 block text-sm font-semibold">Focus cities</span><input name="focus" defaultValue={((active.config?.focus_cities ?? ["Pune"]) as string[]).join(", ")} className={`${input} mt-1 w-full`} /></label>
            ) : null}
          </section>
          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 sm:flex-row sm:items-end">
            <label className="flex-1 text-sm"><span className="font-semibold">Try on a record</span><select name="sample" defaultValue="" className={`${input} mt-1 w-full`}><option value="">Choose…</option>{(samples ?? []).map((s: Row) => <option key={s.id} value={s.id}>{s[label]}</option>)}</select></label>
            <Submit variant="secondary" name="intent" value="preview">Preview</Submit>
          </section>
          <section className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1 text-sm"><span className="font-semibold">What changed?</span><input name="note" placeholder="e.g. Growth matters more this quarter" className={`${input} mt-1 w-full`} /></label>
            <Submit name="intent" value="save">Save as new version</Submit>
          </section>
        </ActionForm>
        <aside className="space-y-4">
          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Status</h2>
            <p className="mt-1 text-sm text-ink-soft">{m.active ? "On — scores are calculated." : "Off — no new scores are calculated."}</p>
            <ActionForm action={toggleModelAction.bind(null, key, !m.active)} className="mt-3"><Submit variant="secondary">{m.active ? "Switch off" : "Switch on"}</Submit></ActionForm>
          </section>
          <section className="rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-semibold">Versions</h2>
            <ol className="mt-3 space-y-3">
              {(versions ?? []).map((v: Row) => (
                <li key={v.id} className="text-sm">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">v{v.version}{v.id === m.active_version_id ? " — active" : ""}</span>
                    {v.id !== m.active_version_id ? <ActionForm action={activateVersionAction.bind(null, key, v.id)}><Submit variant="ghost">Use this</Submit></ActionForm> : null}</div>
                  <p className="text-xs text-ink-soft">{new Date(v.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}{v.note ? ` — ${v.note}` : ""}</p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
