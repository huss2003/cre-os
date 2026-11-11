import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Badge, EmptyState, Field, Input, Select, Textarea, ButtonLink } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { listCommands, getCommand, commandHistory, TEMPLATES, type CommandRow } from "@/modules/assistant/commands/service";
import { saveCommandAction, addTemplateAction, duplicateAction, deleteAction, scheduleAction } from "@/modules/assistant/commands/actions";
import { fmt } from "@/lib/util/time";

export const metadata = { title: "Saved commands" };
type SP = { edit?: string; new?: string; prompt?: string };
const RUN_STATUS: Record<string, "ok" | "warn" | "bad" | "neutral"> = { completed: "ok", partial: "warn", failed: "bad", waiting_approval: "warn", running: "neutral", queued: "neutral" };

function CommandForm({ c, prompt }: { c?: CommandRow; prompt?: string }) {
  return (
    <ActionForm action={saveCommandAction.bind(null, c?.id ?? null)} className="space-y-3">
      <Field label="Name"><Input name="name" defaultValue={c?.name} required maxLength={120} /></Field>
      <Field label="Description"><Input name="description" defaultValue={c?.description ?? ""} maxLength={500} /></Field>
      <Field label="What to ask" hint="Write it as you'd ask the assistant. Use {{city}}-style placeholders for things that change each time."><Textarea name="prompt" defaultValue={c?.prompt ?? prompt?.slice(0, 2000)} required className="min-h-32" /></Field>
      <Field label="Inputs" hint="One per line: key | Label | required | default. Example: city | City | required | Pune">
        <Textarea name="inputs" defaultValue={(c?.inputs ?? []).map((i) => [i.key, i.label, i.required ? "required" : "", i.default ?? ""].join(" | ")).join("\n")} placeholder="city | City | required | Pune" />
      </Field>
      <Field label="Output"><Select name="output_format" defaultValue={c?.output_format ?? "chat"}><option value="chat">Chat answer</option><option value="brief">Brief</option><option value="table">Table</option><option value="report">Report</option></Select></Field>
      <Submit>{c ? `Save (becomes version ${c.version + 1})` : "Create command"}</Submit>
    </ActionForm>
  );
}

function ScheduleForm({ c }: { c: CommandRow }) {
  const [mm, hh, , , dw] = (c.schedule_cron ?? "0 8 * * 1-5").split(" ");
  const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return (
    <ActionForm action={scheduleAction.bind(null, c.id)} className="space-y-3">
      <p className="text-sm text-ink-soft">{c.schedule_enabled ? <>Runs automatically <b>{c.schedule_cron}</b> (IST). Next: <b>{c.next_run_at ? fmt(c.next_run_at) : "—"}</b>. Authorised {fmt(c.schedule_authorised_at)}.</> : "Not scheduled. It only runs when you press Run now."}</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Time (IST)"><Input type="time" name="time" defaultValue={time} /></Field>
        <Field label="Days"><Select name="days" defaultValue={dw === "*" ? "daily" : dw === "1" ? "monday" : "weekdays"}><option value="weekdays">Mon–Fri</option><option value="daily">Every day</option><option value="monday">Mondays</option></Select></Field>
      </div>
      <Field label="Advanced: cron (optional)" hint="5 parts: minute hour day month weekday, in IST. Overrides time and days."><Input name="cron" placeholder="30 7 * * 1-5" /></Field>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" value="1" className="mt-1" /> I authorise this command to run automatically on this schedule. It only reads data and prepares drafts — nothing is sent.</label>
      <input type="hidden" name="enabled" value="1" />
      <div className="flex flex-wrap gap-2"><Submit>{c.schedule_enabled ? "Update schedule" : "Turn on schedule"}</Submit></div>
    </ActionForm>
  );
}

export default async function CommandsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const editor = hasRole(ctx, "editor");
  const cmds = await listCommands(ctx);
  const cur = sp.edit && /^[0-9a-f-]{36}$/i.test(sp.edit) ? await getCommand(ctx, sp.edit) : null;
  const history = cur ? await commandHistory(ctx, cur.id) : [];
  const have = new Set(cmds.map((c) => c.name));
  return (
    <div className="space-y-5">
      <PageHeader title="Saved commands" subtitle="Requests you run often, saved with their inputs. Scheduling is off unless you switch it on and authorise it." actions={<>{editor ? <ButtonLink href="/assistant/commands?new=1">New command</ButtonLink> : null}<ButtonLink href="/assistant" variant="secondary">Back to assistant</ButtonLink></>} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-5">
          <Card title="Your commands">
            {!cmds.length ? <EmptyState title="No saved commands yet">Add one of the ready-made commands below, press New command, or ask the assistant to &ldquo;save this as a command&rdquo;.</EmptyState> : (
              <ul className="divide-y divide-line">
                {cmds.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 py-3">
                    <Link href={`/assistant/commands?edit=${c.id}`} className={`min-w-0 flex-1 hover:text-brand ${cur?.id === c.id ? "text-brand" : ""}`}>
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-ink-soft">v{c.version}{c.description ? ` · ${c.description}` : ""}{c.last_run_at ? ` · last run ${fmt(c.last_run_at)}` : ""}</span>
                    </Link>
                    {c.schedule_enabled ? <Badge tone="brand" title={`Next ${fmt(c.next_run_at)}`}>Scheduled</Badge> : null}
                    <ButtonLink href={`/assistant?command=${c.id}`} variant="secondary">Run now</ButtonLink>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {editor ? (
            <Card title="Ready-made commands">
              <ul className="divide-y divide-line">
                {TEMPLATES.map((t) => (
                  <li key={t.key} className="flex flex-wrap items-center gap-2 py-3">
                    <span className="min-w-0 flex-1"><span className="block font-medium">{t.name}</span><span className="block text-xs text-ink-soft">{t.description}</span></span>
                    {have.has(t.name) ? <Badge tone="ok">Added</Badge> : <ActionForm action={addTemplateAction.bind(null, t.key)}><Submit variant="secondary">Add</Submit></ActionForm>}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
        <div className="space-y-5">
          {sp.new && editor ? <Card title="New command"><CommandForm prompt={sp.prompt} /></Card> : null}
          {cur ? (
            <>
              <Card title={cur.name} actions={<ButtonLink href={`/assistant?command=${cur.id}`}>Run now</ButtonLink>}>
                {editor ? <CommandForm c={cur} /> : <p className="whitespace-pre-wrap text-sm">{cur.prompt}</p>}
                {editor ? (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                    <ActionForm action={duplicateAction.bind(null, cur.id)}><Submit variant="secondary">Duplicate</Submit></ActionForm>
                    <ActionForm action={deleteAction.bind(null, cur.id)}><Submit variant="danger" confirm="Delete this command? Its run history is kept.">Delete</Submit></ActionForm>
                  </div>
                ) : null}
              </Card>
              {editor ? (
                <Card title="Schedule">
                  <ScheduleForm c={cur} />
                  {cur.schedule_enabled ? <ActionForm action={scheduleAction.bind(null, cur.id)} className="mt-3"><input type="hidden" name="enabled" value="0" /><Submit variant="secondary">Turn off schedule</Submit></ActionForm> : null}
                </Card>
              ) : null}
              <Card title="Run history">
                {!history.length ? <p className="text-sm text-ink-soft">Not run yet. Press Run now to try it.</p> : (
                  <ul className="divide-y divide-line">
                    {history.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                        <span className="min-w-0 flex-1"><span className="block">{fmt(r.created_at)}</span><span className="block truncate text-xs text-ink-soft">{r.error ?? r.result_summary ?? r.request}</span></span>
                        <Badge tone={RUN_STATUS[r.status] ?? "neutral"}>{r.status.replace("_", " ")}</Badge>
                        {r.conversation_id ? <Link href={`/assistant/${r.conversation_id}`} className="text-brand hover:underline">Open</Link> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          ) : !sp.new ? <EmptyState title="Pick a command">Choose a command on the left to edit it, schedule it or see its run history.</EmptyState> : null}
        </div>
      </div>
    </div>
  );
}
