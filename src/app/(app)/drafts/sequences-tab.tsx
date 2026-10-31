import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "@/components/ui";
import type { requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { SEQUENCE_TEMPLATES, type SequenceStep } from "@/modules/integrations/sequences";
import { enrollmentAction, enrolAction } from "./sequence-actions";

type Ctx = Awaited<ReturnType<typeof requirePageContext>>;

const STATUS_TONE: Record<string, "neutral" | "brand" | "ok" | "warn" | "bad" | "accent"> = {
  proposed: "accent", active: "ok", paused: "warn", completed: "neutral", cancelled: "neutral",
};
const PAUSE_LABEL: Record<string, string> = {
  reply: "they replied", opt_out: "opted out", wrong_contact: "wrong contact", active_negotiation: "active negotiation",
  contrary_info: "contrary information", suppressed: "contact suppressed", collision: "colleague is approaching this account", manual: "paused by hand",
};
const PERSONAS = [["", "— not set —"], ["cfo", "CFO / finance"], ["admin", "Admin / facilities"], ["hr", "HR"], ["real_estate", "Real estate / workplace head"]];
const esc = (s: string) => s.replace(/[%_,()]/g, " ").trim();

/**
 * Sequences tab (workflow 13): enrol ONE person at a time into a proposed 3-touch / 21-day sequence with a one-line value
 * proposition, see enrollments, activate, pause / resume by hand, cancel. Every step is a draft the user sends manually.
 */
export async function SequencesTab({ ctx, sp, canEdit }: { ctx: Ctx; sp: Record<string, string | string[] | undefined>; canEdit: boolean }) {
  const ws = ctx.workspaceId;
  const status = typeof sp.status === "string" ? sp.status : "live";
  let q = ctx.db.from("sequence_enrollment")
    .select("id, status, current_step, next_due_at, enrolled_at, activated_at, pause_reason, pause_detail, paused_at, value_proposition, person_id, org_id, opportunity_id, person(full_name), organisation(display_name), opportunity(name, stage), outreach_sequence(name, steps)")
    .eq("workspace_id", ws).order("enrolled_at", { ascending: false }).limit(100);
  q = status === "live" ? q.in("status", ["proposed", "active", "paused"]) : q.in("status", ["completed", "cancelled"]);
  const { data: enrollments } = await q;
  const query = typeof sp.q === "string" ? sp.q.trim().slice(0, 80) : "";
  const personId = typeof sp.person === "string" && /^[0-9a-f-]{36}$/i.test(sp.person) ? sp.person : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-2 text-sm">
          {[["live", "Live"], ["done", "Finished"]].map(([k, l]) => (
            <Link key={k} href={`/drafts?tab=sequences&status=${k}`} className={`rounded-full border px-3 py-1 ${k === status ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft"}`}>{l}</Link>
          ))}
        </div>
        {(enrollments ?? []).length === 0 ? (
          <EmptyState title={status === "live" ? "No one is enrolled in a sequence" : "No finished sequences"}>
            Find a person with the form, write one useful proposition for them, and enrol. CRE OS drafts the first touch for your approval;
            later touches are drafted only after you send the previous one. Replies, opt-outs, active negotiations and contrary information pause the sequence automatically.
          </EmptyState>
        ) : (enrollments ?? []).map((e) => {
          const person = e.person as unknown as { full_name: string } | null;
          const org = e.organisation as unknown as { display_name: string } | null;
          const opp = e.opportunity as unknown as { name: string; stage: string } | null;
          const seq = e.outreach_sequence as unknown as { name: string; steps: SequenceStep[] } | null;
          const steps = seq?.steps ?? [];
          const next = steps.find((s) => s.step > e.current_step);
          return (
            <Card key={e.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status}</Badge>
                {e.pause_reason && e.status === "paused" ? <Badge tone="warn">{PAUSE_LABEL[e.pause_reason] ?? e.pause_reason}</Badge> : null}
                <span className="ml-auto text-xs text-ink-soft">Enrolled {fmt(e.enrolled_at, "dd MMM", ctx.timezone)}</span>
              </div>
              <div className="mt-2 text-sm font-medium break-words">{person?.full_name ?? "(person)"}{org ? <span className="font-normal text-ink-soft"> · {org.display_name}</span> : null}</div>
              <div className="text-xs text-ink-soft break-words">{seq?.name ?? "sequence"}{opp ? ` · ${opp.name} (${opp.stage.replace(/_/g, " ")})` : ""}</div>
              {e.value_proposition ? <p className="mt-2 text-sm">“{e.value_proposition}”</p> : null}
              <p className="mt-2 text-xs text-ink-soft">
                Sent {e.current_step} of {steps.length || 3}
                {next ? ` · next: step ${next.step} by ${next.channel}${e.next_due_at ? ` on ${fmt(e.next_due_at, "dd MMM", ctx.timezone)}` : e.status === "active" || e.status === "proposed" ? " (after you send the current draft)" : ""}` : ""}
              </p>
              {e.status === "paused" && e.pause_detail ? <p className="mt-1 text-xs text-ink-soft break-words">Why: {e.pause_detail}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link className="rounded-lg border border-line px-3 py-2 text-sm" href={`/drafts?tab=all`}>See drafts</Link>
                {canEdit && e.status === "proposed" ? <ActionButton id={e.id} action="activate" label="Activate" /> : null}
                {canEdit && e.status === "active" ? <ActionButton id={e.id} action="pause" label="Pause" variant="secondary" /> : null}
                {canEdit && e.status === "paused" ? <ActionButton id={e.id} action="resume" label="Resume" /> : null}
                {canEdit && ["proposed", "active", "paused"].includes(e.status) ? <ActionButton id={e.id} action="cancel" label="Cancel" variant="ghost" /> : null}
              </div>
            </Card>
          );
        })}
      </div>
      <div className="space-y-4">
        {canEdit ? <EnrolCard ctx={ctx} query={query} personId={personId} /> : <Card title="Enrol"><p className="text-sm text-ink-soft">Editors can enrol people in sequences.</p></Card>}
        <Card title="Channels and limits">
          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-soft">
            <li>Email: max 3 in 21 days. LinkedIn: max 2 in 21 days. WhatsApp: max 1 in 14 days, and only to a number the person shared for work.</li>
            <li>WhatsApp and LinkedIn steps open wa.me / LinkedIn with the text ready — you send it. No bulk messaging.</li>
            <li>Max 2 touches per account per week across the team.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ActionButton({ id, action, label, variant = "primary" }: { id: string; action: string; label: string; variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <form action={enrollmentAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      <Button type="submit" variant={variant}>{label}</Button>
    </form>
  );
}

async function EnrolCard({ ctx, query, personId }: { ctx: Ctx; query: string; personId: string | null }) {
  const ws = ctx.workspaceId;
  const { data: found } = query
    ? await ctx.db.from("person").select("id, full_name").eq("workspace_id", ws).is("archived_at", null).ilike("full_name", `%${esc(query)}%`).order("full_name").limit(10)
    : { data: [] as { id: string; full_name: string }[] };
  let selected: { id: string; full_name: string; orgId: string | null; orgName: string | null } | null = null;
  if (personId) {
    const { data: p } = await ctx.db.from("person").select("id, full_name").eq("workspace_id", ws).eq("id", personId).maybeSingle();
    if (p) {
      const { data: emp } = await ctx.db.from("employment").select("org_id, organisation(display_name)").eq("workspace_id", ws).eq("person_id", p.id).eq("is_current", true).limit(1);
      const e = emp?.[0];
      selected = { id: p.id, full_name: p.full_name, orgId: e?.org_id ?? null, orgName: (e?.organisation as unknown as { display_name: string } | null)?.display_name ?? null };
    }
  }
  const { data: seqs } = await ctx.db.from("outreach_sequence").select("id, name").eq("workspace_id", ws).eq("status", "active").order("name");
  const templateNames = new Set(Object.values(SEQUENCE_TEMPLATES).map((t) => t.name));
  let opps: { id: string; name: string; org_id: string | null }[] = [];
  if (selected) {
    const { data } = await ctx.db.from("opportunity").select("id, name, org_id").eq("workspace_id", ws).eq("outcome", "open").is("archived_at", null).order("name").limit(200);
    opps = (data ?? []).sort((a, b) => Number(b.org_id === selected!.orgId) - Number(a.org_id === selected!.orgId));
  }
  return (
    <Card title="Enrol a person">
      <form method="get" action="/drafts" className="flex gap-2">
        <input type="hidden" name="tab" value="sequences" />
        <Input name="q" defaultValue={query} placeholder="Search people by name" aria-label="Search people" />
        <Button type="submit" variant="secondary">Find</Button>
      </form>
      {query && !(found ?? []).length ? <p className="mt-2 text-sm text-ink-soft">No one matches “{query}”. Add people under <Link className="text-brand underline" href="/people">People</Link>.</p> : null}
      {(found ?? []).length ? (
        <ul className="mt-2 divide-y divide-line text-sm">
          {(found ?? []).map((p) => (
            <li key={p.id}><Link className="block py-2 text-brand" href={`/drafts?tab=sequences&person=${p.id}`}>{p.full_name}</Link></li>
          ))}
        </ul>
      ) : null}
      {selected ? (
        <form action={enrolAction} className="mt-4 grid gap-3 border-t border-line pt-4">
          <input type="hidden" name="personId" value={selected.id} />
          <p className="text-sm"><span className="font-medium">{selected.full_name}</span>{selected.orgName ? <span className="text-ink-soft"> · {selected.orgName}</span> : null}</p>
          <Field label="Sequence">
            <Select name="sequence" defaultValue="tpl:default">
              {Object.entries(SEQUENCE_TEMPLATES).map(([k, t]) => <option key={k} value={`tpl:${k}`}>{t.name}</option>)}
              {(seqs ?? []).filter((s) => !templateNames.has(s.name)).map((s) => <option key={s.id} value={`seq:${s.id}`}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Opportunity (optional)">
            <Select name="opportunityId" defaultValue="">
              <option value="">— none —</option>
              {opps.map((o) => <option key={o.id} value={o.id}>{o.name}{o.org_id && o.org_id === selected!.orgId ? " (their company)" : ""}</option>)}
            </Select>
          </Field>
          <Field label="Persona"><Select name="persona" defaultValue="">{PERSONAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="One-line value proposition" hint="One useful, true thing you can offer this person. It is used in every draft.">
            <Input name="valueProposition" required minLength={5} maxLength={200} placeholder="a sourced note on Grade A rents in Baner vs Kharadi" />
          </Field>
          <label className="flex items-start gap-2 text-xs text-ink-soft"><input type="checkbox" name="override" value="yes" className="mt-0.5" /> A colleague is already in touch and I have agreed this with them</label>
          <Button type="submit">Enrol and draft first touch</Button>
          <p className="text-xs text-ink-soft">Nothing is sent. The first touch appears in Drafts for your approval.</p>
        </form>
      ) : <p className="mt-3 text-xs text-ink-soft">Search, then pick one person. Enrolment is one person at a time.</p>}
    </Card>
  );
}
