import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { HelpFor } from "@/components/ui";
import { buildContext, warmPaths, duplicateCheck, OutreachError } from "@/modules/outreach/service";
import { createAction } from "@/modules/outreach/actions";
import { SCENARIOS, CHANNEL_LABEL, LEVEL_LABEL, ROLE_FOCUS, type Channel, type Scenario } from "@/modules/outreach/rules";

export const metadata = { title: "New outreach" };
type Row = Record<string, any>;
const sel = "min-h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm";
const box = "rounded-2xl border border-line bg-surface p-5";

export default async function Page({ searchParams }: { searchParams: Promise<{ person?: string; signal?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext("editor");
  if (!sp.person) {
    const { data } = await ctx.db.from("person").select("id, full_name, do_not_contact, employment(title, is_current, org:org_id(display_name))").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("full_name").limit(1000);
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Link href="/outreach" className="text-sm text-ink-soft hover:text-ink">← Outreach</Link>
        <h1 className="text-2xl font-bold">Who do you want to contact?</h1>
        <form method="get" className={`${box} space-y-3`}>
          <select name="person" required className={sel} defaultValue=""><option value="" disabled>Choose a contact</option>{((data ?? []) as Row[]).filter((p) => !p.do_not_contact).map((p) => { const e = (p.employment ?? []).find((x: Row) => x.is_current); return <option key={p.id} value={p.id}>{p.full_name}{e ? ` — ${e.title ?? ""} ${e.org?.display_name ? `at ${e.org.display_name}` : ""}` : ""}</option>; })}</select>
          <button className="min-h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-white">Continue</button>
        </form>
      </div>
    );
  }
  let c; try { c = await buildContext(ctx.db, ctx.workspaceId, sp.person, { signalId: sp.signal }); } catch (e) { return <p className="text-bad">{e instanceof OutreachError ? e.message : "Couldn't load this contact."}</p>; }
  const [paths, warn] = await Promise.all([warmPaths(ctx.db, ctx.workspaceId, ctx.userId, sp.person), duplicateCheck(ctx.db, ctx.workspaceId, sp.person, ctx.userId)]);
  const blocked = c.blocked.all;
  const avail: Record<Channel, string | null> = { email: c.channels.email ? null : "no email saved", whatsapp: c.channels.phone ? null : "no phone saved", linkedin: null, call: c.channels.phone ? null : "no phone saved", introduction: paths.length ? null : "no mutual contact recorded", meeting_followup: c.lastInteraction ? null : "no meeting recorded" };
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/outreach" className="text-sm text-ink-soft hover:text-ink">← Outreach</Link>
      <header><h1 className="text-2xl font-bold">{c.person.full_name}</h1><p className="text-sm text-ink-soft">{c.title ?? "Designation unknown"} · {c.org?.display_name ?? "Company unknown"} · {LEVEL_LABEL[c.level]}</p></header>
      {blocked ? <p className="rounded-xl bg-bad/10 px-4 py-3 text-sm text-bad">{blocked}. No outreach can be prepared.</p> : null}
      {warn.length ? <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><p className="font-semibold">Someone may already be in touch</p><ul className="mt-1 list-disc pl-5">{warn.map((w, i) => <li key={i}>{w.text}</li>)}</ul><p className="mt-1 text-xs">You can still continue if a separate message is justified.</p></div> : null}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <section className={box}>
          <h2 className="flex items-center font-semibold">Prepare drafts<HelpFor k="Prepare drafts" /></h2>
          {!blocked && c.level !== "not_interested" ? (
            <ActionForm action={createAction} className="mt-4 space-y-4">
              <input type="hidden" name="person_id" value={sp.person} />{sp.signal ? <input type="hidden" name="signal_id" value={sp.signal} /> : null}
              <label className="block text-sm font-medium">Situation<select name="scenario" className={`${sel} mt-1`} defaultValue=""><option value="">Pick automatically from records</option>{(Object.keys(SCENARIOS) as Scenario[]).map((k) => <option key={k} value={k}>{SCENARIOS[k].label}</option>)}</select></label>
              <fieldset><legend className="text-sm font-medium">Channels (one draft each, written for that channel)</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">{(["email", "whatsapp", "linkedin", "call", "meeting_followup"] as Channel[]).map((ch) => <label key={ch} className={`flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm ${avail[ch] ? "text-ink-soft" : ""}`}><input type="checkbox" name="channel" value={ch} defaultChecked={ch === "email" && !avail.email} disabled={!!avail[ch] && ch !== "linkedin"} /> {CHANNEL_LABEL[ch]}{avail[ch] ? <span className="text-xs">— {avail[ch]}</span> : null}</label>)}</div>
              </fieldset>
              <label className="block text-sm font-medium">Language<select name="language" className={`${sel} mt-1`}><option value="en">English</option><option value="hinglish">Hinglish</option><option value="hi">Hindi</option></select></label>
              <Submit>Prepare drafts</Submit>
            </ActionForm>
          ) : c.level === "not_interested" ? <p className="mt-2 text-sm">They said they're not interested. Respect that unless something genuinely new has happened — log it in Capture first.</p> : null}
          {paths.length && !blocked ? (
            <div className="mt-6 border-t border-line pt-4">
              <h3 className="flex items-center font-semibold">Warm introduction<HelpFor k="Warm introduction" /></h3>
              <ul className="mt-2 space-y-2">{paths.slice(0, 4).map((p) => (
                <li key={p.personId} className="flex flex-wrap items-center gap-3 rounded-xl bg-canvas p-3 text-sm">
                  <span className="min-w-0 flex-1"><b>{p.name}</b><span className="block text-xs text-ink-soft">Knows them: {p.theirLink} · You: {p.yourLink}{p.introPermission ? " · has agreed to introduce before" : ""}</span></span>
                  <ActionForm action={createAction}><input type="hidden" name="person_id" value={sp.person} /><input type="hidden" name="via" value={p.personId} /><input type="hidden" name="channel" value="introduction" /><Submit variant="secondary">Ask {p.name.split(" ")[0]}</Submit></ActionForm>
                </li>))}</ul>
            </div>
          ) : null}
        </section>
        <aside className={`${box} space-y-3 text-sm`}>
          <h2 className="flex items-center font-semibold">What we know<HelpFor k="What we know" /></h2>
          <ul className="space-y-1.5">{c.facts.map((f, i) => <li key={i}>{f.text}</li>)}{!c.facts.length ? <li className="text-ink-soft">Nothing on record yet.</li> : null}</ul>
          {c.unknowns.length ? <p className="text-ink-soft">Unknown: {c.unknowns.join(", ")}</p> : null}
          <p><span className="text-ink-soft">They care about:</span> {(ROLE_FOCUS[c.roleKey] ?? ROLE_FOCUS.other).focus.join(", ")}</p>
          {c.leadScore !== null ? <p><span className="text-ink-soft">Lead score:</span> {c.leadScore}/100</p> : null}
        </aside>
      </div>
    </div>
  );
}
