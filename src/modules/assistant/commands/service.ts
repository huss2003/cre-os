import "server-only";
import { z } from "zod";
import type { AppContext } from "@/lib/auth/context";
import { nextCronRun, parseCron } from "./cron";

/**
 * Saved (reusable) assistant commands — spec §14. Owned by the user who created them; RLS + explicit workspace filter.
 * Scheduling is opt-in: schedule_enabled only becomes true with an explicit confirmation, which stamps
 * schedule_authorised_at. Editing the prompt of a scheduled command revokes the authorisation (must re-confirm).
 */
export type CmdCtx = Pick<AppContext, "db" | "workspaceId" | "userId">;
export class CommandError extends Error {}

export const commandInput = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/, "input keys: lowercase letters, digits, _"), label: z.string().min(1), required: z.boolean().default(false), default: z.string().nullish() });
export type CommandInput = z.infer<typeof commandInput>;
export const commandFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  prompt: z.string().trim().min(1).max(4000),
  inputs: z.array(commandInput).default([]),
  defaults: z.record(z.string(), z.string()).default({}),
  tools: z.array(z.string()).default([]),
  output_format: z.enum(["chat", "brief", "table", "report"]).default("chat"),
});
export type CommandFields = z.input<typeof commandFields>;

export interface CommandRow {
  id: string; workspace_id: string; owner_user_id: string | null; name: string; description: string | null; prompt: string;
  inputs: CommandInput[]; defaults: Record<string, string>; tools: string[]; output_format: string; version: number;
  schedule_cron: string | null; schedule_enabled: boolean; schedule_authorised_at: string | null; last_run_at: string | null; next_run_at: string | null;
  created_at: string; updated_at: string; archived_at: string | null;
}

/** Built-in templates (spec §14). Offered with an "Add" button; never auto-created. */
export const TEMPLATES: (CommandFields & { key: string; suggestedCron?: string })[] = [
  { key: "morning_brief", name: "Morning CRE briefing", description: "Today's meetings, due tasks, lease events and new signals.", prompt: "Prepare my morning CRE briefing for today: meetings, overdue and due tasks, upcoming lease events in the next {{days}} days, and new market signals. Flag anything stale.", inputs: [{ key: "days", label: "Lease look-ahead (days)", required: false, default: "90" }], output_format: "brief", suggestedCron: "30 7 * * 1-5" },
  { key: "priority_accounts", name: "Review my priority accounts", description: "Top accounts by lead score with the next best action.", prompt: "Review my top {{count}} priority accounts. For each: why it matters now, last interaction, open commitments and the next best action.", inputs: [{ key: "count", label: "How many accounts", required: false, default: "10" }], output_format: "table" },
  { key: "meeting_briefs", name: "Prepare tomorrow's meeting briefs", description: "One brief per meeting tomorrow.", prompt: "Prepare briefs for all my meetings tomorrow: attendees, company context, open requirements, previous commitments and suggested questions.", inputs: [], output_format: "brief", suggestedCron: "0 18 * * 0-4" },
  { key: "weekly_opportunities", name: "Weekly opportunity report", description: "Pipeline movement over the last week.", prompt: "Generate a weekly opportunity report: stage changes in the last 7 days, deals at risk, next steps due and expected fees (from recorded fee milestones only).", inputs: [], output_format: "report", suggestedCron: "0 9 * * 1" },
  { key: "overdue_commitments", name: "Show overdue client commitments", description: "Promises to clients that are past due.", prompt: "Show all overdue client commitments and tasks, grouped by client, with how late each one is and a suggested next step.", inputs: [], output_format: "table" },
  { key: "active_deals", name: "Review all active deals", description: "Status of every open deal.", prompt: "Review all active deals: stage, last activity, blockers, missing information and the next action for each.", inputs: [], output_format: "table" },
  { key: "pune_expansion", name: "Find new expansion signals", description: "Recent expansion signals in a market.", prompt: "Find new expansion signals in {{city}} from the last {{days}} days and rank the companies by how relevant they are to my book.", inputs: [{ key: "city", label: "City", required: true, default: "Pune" }, { key: "days", label: "Look-back (days)", required: false, default: "14" }], output_format: "table" },
];

/** Fill {{key}} placeholders from values → defaults → input default. Missing required inputs are reported, never invented. */
export function fillPrompt(cmd: Pick<CommandRow, "prompt" | "inputs" | "defaults">, values: Record<string, string | undefined> = {}): { prompt: string; missing: string[] } {
  const missing: string[] = [];
  const val = (k: string) => {
    const spec = (cmd.inputs ?? []).find((i) => i.key === k);
    const v = values[k]?.trim() || cmd.defaults?.[k] || spec?.default || "";
    if (!v && (spec?.required ?? true)) missing.push(spec?.label ?? k);
    return v;
  };
  const prompt = cmd.prompt.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, k: string) => val(k) || `[${k}: not given]`);
  return { prompt, missing: [...new Set(missing)] };
}

const SEL = "*";
export async function listCommands(ctx: CmdCtx): Promise<CommandRow[]> {
  const { data, error } = await ctx.db.from("assistant_command").select(SEL).eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name");
  if (error) throw new CommandError(error.message);
  return (data ?? []) as CommandRow[];
}
export async function getCommand(ctx: CmdCtx, id: string): Promise<CommandRow | null> {
  const { data } = await ctx.db.from("assistant_command").select(SEL).eq("workspace_id", ctx.workspaceId).eq("id", id).is("archived_at", null).maybeSingle();
  return (data as CommandRow) ?? null;
}
async function must(ctx: CmdCtx, id: string) {
  const c = await getCommand(ctx, id);
  if (!c) throw new CommandError("Command not found.");
  return c;
}

export async function createCommand(ctx: CmdCtx, fields: CommandFields): Promise<CommandRow> {
  const f = commandFields.parse(fields);
  const { data, error } = await ctx.db.from("assistant_command").insert({ ...f, description: f.description ?? null, workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, version: 1 }).select(SEL).single();
  if (error) throw new CommandError(error.message);
  return data as CommandRow;
}

export async function addTemplate(ctx: CmdCtx, key: string): Promise<CommandRow> {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) throw new CommandError("Unknown template.");
  const { key: _k, suggestedCron: _c, ...fields } = t;
  return createCommand(ctx, fields);
}

/** Edit → version + 1. A prompt change on a scheduled command revokes its authorisation. */
export async function updateCommand(ctx: CmdCtx, id: string, fields: Partial<CommandFields>): Promise<CommandRow> {
  const cur = await must(ctx, id);
  const f = commandFields.partial().parse(fields);
  const patch: Record<string, unknown> = { ...f, version: cur.version + 1 };
  if (f.prompt !== undefined && f.prompt !== cur.prompt && cur.schedule_enabled) {
    Object.assign(patch, { schedule_enabled: false, schedule_authorised_at: null, next_run_at: null });
  }
  const { data, error } = await ctx.db.from("assistant_command").update(patch).eq("workspace_id", ctx.workspaceId).eq("id", id).eq("version", cur.version).select(SEL).maybeSingle();
  if (error) throw new CommandError(error.message);
  if (!data) throw new CommandError("This command was changed elsewhere. Reload and try again.");
  return data as CommandRow;
}

export async function duplicateCommand(ctx: CmdCtx, id: string): Promise<CommandRow> {
  const c = await must(ctx, id);
  return createCommand(ctx, { name: `${c.name} (copy)`.slice(0, 120), description: c.description, prompt: c.prompt, inputs: c.inputs, defaults: c.defaults, tools: c.tools, output_format: c.output_format as "chat" });
}

export async function archiveCommand(ctx: CmdCtx, id: string): Promise<void> {
  await must(ctx, id);
  const { error } = await ctx.db.from("assistant_command").update({ archived_at: new Date().toISOString(), schedule_enabled: false, next_run_at: null }).eq("workspace_id", ctx.workspaceId).eq("id", id);
  if (error) throw new CommandError(error.message);
}

/**
 * Set or clear a schedule. Enabling requires `confirm === true` (the user ticked "I authorise this to run automatically").
 * Cron is evaluated in IST (workspace timezone).
 */
export async function setSchedule(ctx: CmdCtx, id: string, opts: { cron: string | null; enabled: boolean; confirm?: boolean; tz?: string; now?: Date }): Promise<CommandRow> {
  const c = await must(ctx, id);
  const now = opts.now ?? new Date();
  let patch: Record<string, unknown>;
  if (!opts.enabled) {
    patch = { schedule_cron: opts.cron ?? c.schedule_cron, schedule_enabled: false, schedule_authorised_at: null, next_run_at: null };
  } else {
    if (!opts.cron) throw new CommandError("Pick a time for the schedule.");
    try { parseCron(opts.cron); } catch (e) { throw new CommandError((e as Error).message); }
    if (opts.confirm !== true) throw new CommandError("Tick the box to authorise this command to run automatically.");
    const next = nextCronRun(opts.cron, now, opts.tz ?? "Asia/Kolkata");
    patch = { schedule_cron: opts.cron, schedule_enabled: true, schedule_authorised_at: now.toISOString(), next_run_at: next?.toISOString() ?? null };
  }
  const { data, error } = await ctx.db.from("assistant_command").update(patch).eq("workspace_id", ctx.workspaceId).eq("id", id).select(SEL).single();
  if (error) throw new CommandError(error.message);
  return data as CommandRow;
}

export interface CommandRunRow { id: string; status: string; request: string; result_summary: string | null; error: string | null; created_at: string; finished_at: string | null; conversation_id: string | null }
export async function commandHistory(ctx: CmdCtx, id: string, limit = 20): Promise<CommandRunRow[]> {
  const { data } = await ctx.db.from("assistant_run").select("id, status, request, result_summary, error, created_at, finished_at, conversation_id")
    .eq("workspace_id", ctx.workspaceId).eq("command_id", id).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as CommandRunRow[];
}

/** Run now (from API / page). Missing required inputs → error listing them, nothing runs. */
export async function runCommand(ctx: AppContext, id: string, values: Record<string, string> = {}, opts: { idempotencyKey?: string; conversationId?: string | null } = {}) {
  const c = await must(ctx, id);
  const { prompt, missing } = fillPrompt(c, values);
  if (missing.length) throw new CommandError(`Missing input: ${missing.join(", ")}`);
  const { runAssistant } = await import("../engine/run");
  const r = await runAssistant({ ctx, request: prompt, commandId: c.id, conversationId: opts.conversationId ?? null, idempotencyKey: opts.idempotencyKey });
  await ctx.db.from("assistant_command").update({ last_run_at: new Date().toISOString() }).eq("workspace_id", ctx.workspaceId).eq("id", id);
  return r;
}
