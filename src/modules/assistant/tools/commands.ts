import { z } from "zod";
import type { ToolDef } from "../types";
import { defineTool } from "./shared";
import * as C from "../commands/service";

/** Saved-command tools. Scheduling can only be switched on from the Commands page (explicit opt-in), never by the model. */
export const commandTools: ToolDef[] = [
  defineTool({
    id: "list_saved_commands", module: "assistant", category: "A",
    description: "List the user's saved commands (reusable requests) with their inputs and schedule status.",
    input: z.object({}),
    run: async (_i, t) => {
      const cs = await C.listCommands(t.ctx);
      return { ok: true, summary: `${cs.length} saved commands.`, data: cs.map((c) => ({ id: c.id, name: c.name, description: c.description, inputs: c.inputs.map((x) => x.key), scheduled: c.schedule_enabled ? c.schedule_cron : null })) };
    },
  }),
  defineTool({
    id: "save_command", module: "assistant", category: "B",
    description: "Save a request as a reusable command when the user asks (e.g. 'save this as my Monday pipeline review'). Use {{key}} placeholders for inputs. Does not schedule it.",
    input: z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional(), prompt: z.string().min(1).max(4000), inputs: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string(), required: z.boolean().default(false), default: z.string().optional() })).default([]) }),
    run: async (i, t) => {
      const c = await C.createCommand(t.ctx, { name: i.name, description: i.description ?? null, prompt: i.prompt, inputs: i.inputs });
      return { ok: true, summary: `Saved command "${c.name}". Schedule it from Assistant → Commands if you want it to run automatically.`, data: { id: c.id }, blocks: [{ kind: "download", label: `Open "${c.name}"`, href: `/assistant/commands?edit=${c.id}` }] };
    },
  }),
];
