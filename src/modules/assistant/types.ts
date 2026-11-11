/**
 * Module 12 — shared contracts. Every assistant sub-part (engine, tools, memory, UI, commands)
 * builds against these types. Change only with care: renderers depend on Block shapes.
 */
import type { z, ZodType } from "zod";
import type { AppContext } from "@/lib/auth/context";

/** A = read-only (auto). B = low-risk internal write (auto + logged). C = consequential (needs approval). */
export type ToolCategory = "A" | "B" | "C";

export type EntityType =
  | "company" | "person" | "asset" | "space" | "requirement" | "opportunity" | "lease"
  | "meeting" | "outreach" | "analysis" | "document" | "task" | "signal";

export interface EntityRef { type: EntityType; id: string; label: string; href?: string }

export interface SourceRef {
  label: string;               // "Lease record", "Meeting 12 Oct", "Economic Times"
  href?: string;               // in-app route or external url
  observedAt?: string | null;  // ISO date when the fact was observed/published
  retrievedAt?: string;        // ISO when we fetched it
  status?: "verified" | "reported" | "inferred" | "unknown";
}

/** Structured blocks the UI renders (src/modules/assistant/ui/blocks.tsx). */
export type Block =
  | { kind: "text"; markdown: string }
  | { kind: "entity_card"; entity: EntityRef; fields: { label: string; value: string | null; status?: SourceRef["status"] }[]; sources?: SourceRef[] }
  | { kind: "table"; title?: string; columns: string[]; rows: (string | number | null)[][]; note?: string; sources?: SourceRef[] }
  | { kind: "ranked_list"; title?: string; items: { rank: number; entity: EntityRef; score?: number | null; why: string; next?: string }[] }
  | { kind: "brief"; title: string; sections: { heading: string; bullets: string[] }[]; href?: string }
  | { kind: "tasks"; title?: string; items: { title: string; due?: string | null; done?: boolean; entity?: EntityRef; href?: string }[] }
  | { kind: "sources"; items: SourceRef[] }
  | { kind: "missing"; items: string[] }
  | { kind: "approval"; approvalId: string; title: string; explanation: string; affected: EntityRef[]; diff: { field: string; before: unknown; after: unknown }[]; status: string }
  | { kind: "draft"; draftHref: string; channel: string; subject?: string | null; preview: string }
  | { kind: "status"; done: string[]; pending: string[]; blocked: string[] }
  | { kind: "download"; label: string; href: string }
  /** "Attach extracted lease terms" panel shown under an extract_lease_terms result. */
  | { kind: "lease_attach"; extractionId: string; file: string; suggestions: { id: string; label: string }[] }
  | { kind: "map"; title?: string; points: MapPoint[]; lines?: { label: string; coords: [number, number][] }[]; rings?: { centerId: string; radiiKm: number[] }[]; note: string };

/** A map marker. Coordinates come from stored records only — never geocoded or guessed by a model. */
export interface MapPoint { id: string; label: string; lat: number; lon: number; kind: "building" | "station" | "company" | "other"; href?: string }

export interface ToolContext {
  ctx: AppContext;             // authenticated user; ctx.db is RLS-scoped. NEVER use the admin client in tools.
  runId: string;
  conversationId: string | null;
  /** Records the page passed in (contextual assistant). */
  focus?: EntityRef | null;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  /** Compact JSON fed back to the model (keep small: ids, labels, key figures, source dates). */
  data?: T;
  /** One-line human summary shown in the step trail. */
  summary: string;
  blocks?: Block[];
  sources?: SourceRef[];
  entities?: EntityRef[];
  /** What could not be found/checked — surfaced to the user, never hidden. */
  missing?: string[];
  /** Coverage honesty for list/search tools: e.g. {checked: 40, withData: 22, note: "18 companies have no lease record"} */
  coverage?: { checked: number; withData: number; note?: string };
  error?: string;
}

/** For category C tools: describe the change; engine creates an approval instead of executing. */
export interface ApprovalPlan {
  title: string;
  explanation: string;
  affected: EntityRef[];
  diff: { field: string; before: unknown; after: unknown }[];
}

export interface ToolDef<S extends ZodType = ZodType> {
  id: string;                  // snake_case, unique
  module: "database" | "research" | "scoring" | "contacts" | "outreach" | "meetings" | "toolkit" | "assistant" | "documents" | "tasks" | "geo";
  description: string;         // written for the model: when to use, what it returns
  category: ToolCategory;
  minRole?: "viewer" | "member" | "admin" | "owner";
  input: S;
  timeoutMs?: number;          // default 20_000
  retry?: number;              // only for category A; default 1
  run: (input: z.infer<S>, t: ToolContext) => Promise<ToolResult>;
  /** Required for category C. Read current state and describe the exact change. */
  plan?: (input: z.infer<S>, t: ToolContext) => Promise<ApprovalPlan>;
}

export type RunStatus = "queued" | "running" | "waiting_info" | "waiting_approval" | "partial" | "completed" | "failed" | "cancelled";

/** Server-sent event payloads streamed by POST /api/v1/assistant/chat. */
export type StreamEvent =
  | { type: "run"; runId: string; conversationId: string; route: "fast" | "deep" }
  | { type: "step"; step: number; toolId: string; label: string; status: "running" | "ok" | "error" | "denied" | "needs_approval"; summary?: string }
  | { type: "text"; delta: string }
  | { type: "blocks"; blocks: Block[] }
  | { type: "done"; status: RunStatus; messageId: string }
  | { type: "error"; message: string };

export interface ContextPackage {
  user: { id: string; name: string | null; role: string };
  workspace: { id: string; name: string; timezone: string };
  now: string;                 // ISO, plus IST display
  request: string;
  focus: EntityRef | null;
  resolved: EntityRef[];       // entities identified from the request + conversation
  records: Record<string, unknown>[]; // compact facts with source + observed dates
  memories: { id: string; category: string; content: string; stated: boolean; confidence: number; capturedAt: string; stale: boolean }[];
  conversation: { summary: string | null; recent: { role: string; content: string }[] };
  attachments: { id: string; name: string; excerpt: string }[];
  missing: string[];
  tools: { id: string; category: ToolCategory }[];
}
