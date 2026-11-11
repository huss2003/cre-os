import { z } from "zod";
import type { ToolDef } from "../types";
import { defineTool } from "./shared";
import { searchCaptures } from "@/modules/capture/input-engine/service";

/**
 * Module 10 → Module 12: the assistant can find what was captured (notes, voice notes, uploaded files) and the
 * source-linked observations extracted from them. Read-only; RLS applies (user client). Group: "documents".
 */
export const captureTools: ToolDef[] = [
  defineTool({
    id: "search_captures", module: "documents", category: "A",
    description: "Search recently captured notes, voice notes and uploaded documents (business cards, quotations, leases, recordings) and the facts extracted from them, each with its source (capture link, page or timestamp), fact class (confirmed / estimate / assumption / hypothesis / commitment / task / preference) and verification status. Use for 'what did I note about…', 'what was in the quotation I uploaded', 'recent captures'. Estimates and unverified items must be presented as such.",
    input: z.object({ query: z.string().max(200).default(""), days: z.number().int().min(1).max(730).default(90) }),
    run: async (i, t) => {
      const r = await searchCaptures(t.ctx.db, t.ctx.workspaceId, i.query, { days: i.days, limit: 10 });
      const n = r.captures.length + r.documents.length;
      return {
        ok: true,
        summary: n || r.observations.length ? `${r.captures.length} notes, ${r.documents.length} files, ${r.observations.length} extracted items.` : "Nothing captured matches that.",
        data: r,
        sources: [
          ...r.captures.map((c) => ({ label: `Capture ${String(c.captured_at).slice(0, 10)}`, href: c.href, observedAt: c.captured_at, status: "reported" as const })),
          ...r.documents.map((d) => ({ label: `File: ${d.file}`, href: d.href, observedAt: d.uploaded_at, status: "reported" as const })),
        ],
        missing: n ? [] : ["No matching captures in this period"],
      };
    },
  }),
];
