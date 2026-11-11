import { z } from "zod";
import type { ToolCategory, ToolDef } from "../types";
import { databaseTools } from "./database";
import { activityTools } from "./activity";
import { documentTools } from "./documents";
import { researchTools } from "./research";
import { toolkitTools } from "./toolkit";
import { actionTools } from "./actions";
import { changeTools } from "./changes";
import { memoryTools } from "./memory";
import { commandTools } from "./commands";
import { briefsTools } from "./briefs";
import { documents2Tools } from "./documents2";
import { outputsTools } from "./outputs";
import { dataTools } from "./data";
import { search2Tools } from "./search2";
import { toolkit2Tools } from "./toolkit2";

/**
 * Cross-module tool registry for the AI assistant (Module 12). Tools wrap the EXISTING module services and tables;
 * none duplicates business logic. Category A = read (auto), B = internal low-risk write (auto + logged),
 * C = consequential (engine shows an approval card from plan(), runs run() only after approval).
 */
export const TOOLS: ToolDef[] = [
  ...databaseTools, ...activityTools, ...documentTools, ...researchTools, ...toolkitTools, ...actionTools, ...changeTools,
  ...memoryTools, ...commandTools, ...briefsTools, ...documents2Tools, ...outputsTools, ...dataTools, ...search2Tools, ...toolkit2Tools,
];

const BY_ID = new Map<string, ToolDef>();
for (const t of TOOLS) {
  if (BY_ID.has(t.id)) throw new Error(`duplicate assistant tool id ${t.id}`);
  if (t.category === "C" && !t.plan) throw new Error(`category C tool ${t.id} needs plan()`);
  BY_ID.set(t.id, t);
}

export function getTool(id: string): ToolDef | undefined {
  return BY_ID.get(id);
}

export interface AnthropicTool { name: string; description: string; input_schema: Record<string, unknown> }

const SUFFIX: Record<ToolCategory, string> = {
  A: "",
  B: " [Runs automatically and is logged.]",
  C: " [Requires the user's approval before it runs.]",
};

/** Anthropic tool JSON (draft-7 JSON Schema, no $schema key). Pass ids to restrict the set. */
export function toolsForModel(ids?: string[]): AnthropicTool[] {
  const list = ids?.length ? ids.map((id) => BY_ID.get(id)).filter((t): t is ToolDef => !!t) : TOOLS;
  return list.map((t) => {
    const schema = z.toJSONSchema(t.input, { target: "draft-7", unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    if (schema.type !== "object") return { name: t.id, description: t.description + SUFFIX[t.category], input_schema: { type: "object", properties: {}, ...schema } };
    return { name: t.id, description: t.description + SUFFIX[t.category], input_schema: schema };
  });
}

/** Documentation list (rendered in TOOLS.md and help screens). */
export const TOOL_DOCS: { id: string; module: ToolDef["module"]; category: ToolCategory; description: string }[] = TOOLS.map((t) => ({
  id: t.id, module: t.module, category: t.category, description: t.description,
}));

export function toolDocsMarkdown(): string {
  const cat = { A: "A — read (automatic)", B: "B — internal write (automatic, logged)", C: "C — needs approval" };
  return TOOL_DOCS.map((d) => `| \`${d.id}\` | ${d.module} | ${cat[d.category]} | ${d.description.replace(/\|/g, "\\|")} |`).join("\n");
}
