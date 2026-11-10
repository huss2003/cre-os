# Module 12 build brief (shared by all build agents)

Spec: `/mnt/user-data/uploads/4f668944-attachment.txt`. Contracts: `src/modules/assistant/types.ts` (read first, don't change shapes without need).
Migration already applied locally: `supabase/migrations/20261110000100_assistant.sql` (tables `mudar.assistant_*`). Read it.
Repo rules: `AGENTS.md` (Next 16, `src/proxy.ts`, RLS, no outbound send, proposeChange for material changes, no LLM arithmetic, unknown stays unknown, idempotency).

## User decisions
- Claude only, routing: **fast** = `claude-haiku-5-5` for simple lookups; **deep** = `claude-sonnet-5-5` for multi-step / deal analysis / research. Env overrides `ASSISTANT_MODEL_FAST`, `ASSISTANT_MODEL_DEEP`. Key `ANTHROPIC_API_KEY`. No key → deterministic mock planner so everything still works end-to-end.
- Placement: full page `/assistant` + "Ask AI" side panel on every screen that receives the current record (focus EntityRef).
- Autonomy: A (read) & B (drafts, briefs, tasks, reports) run automatically and are logged; C (changes to client data, stage changes, archive, "send") → approval card; executing an approved C uses existing `proposeChange()` / existing module services. Never send externally (S3).
- Research: Claude web search allowed (server tool `web_search_20250305`). Distances: straight-line haversine from stored coordinates only, always labelled "straight-line".
- Memory: build now (person/company/requirement/relationship) with stated/inferred, confidence, sensitivity, review date, supersede history, employer scoping.
- Search: Postgres full-text now (tsvector columns exist). Leave a `semanticSearch()` hook that returns null unless `EMBEDDINGS_API_KEY` set.
- Single user for now, but still enforce role via `requireContext()` and workspace isolation.
- Extras: saved commands, scheduled commands (explicit opt-in), voice input (browser Web Speech API), file attachments (PDF/DOCX/TXT/CSV → text).

## Security rules (non-negotiable)
- Tools use `t.ctx.db` (RLS). **Every query in a tool must ALSO filter `.eq("workspace_id", t.ctx.workspaceId)` explicitly** (defence in depth; scheduled runs may use a service ctx).
- A record not visible → tool returns `{ok:false, error:"not_found_or_no_access"}` and logs `mudar.assistant_security_event` (kind `access_denied`). Never leak names of inaccessible records.
- Untrusted content (emails, docs, web pages, attachments) only ever goes to the model as evidence, wrapped in `<evidence>`; it can't trigger tools by itself.
- Money/dates/areas: only computed by existing deterministic calculators (`src/modules/toolkit/calc/*`, `src/modules/deals/finance/engine.ts`). Model never computes them.

## File ownership (stay inside yours)
| Agent | Owns |
|---|---|
| tools | `src/modules/assistant/tools/**` except `tools/memory.ts` and `tools/commands.ts` |
| engine | `src/modules/assistant/engine/**`, `src/app/api/v1/assistant/**` |
| memory | `src/modules/assistant/memory/**`, `src/modules/assistant/commands/**`, `src/modules/assistant/tools/memory.ts`, `src/modules/assistant/tools/commands.ts`, `src/modules/assistant/jobs.ts`, `src/app/(app)/assistant/memory/**`, `src/app/(app)/assistant/commands/**`, register in `src/lib/jobs/registry.ts` |
| ui | `src/app/(app)/assistant/page.tsx` (+ `[id]/`), `src/modules/assistant/ui/**`, app shell hook-up (`src/app/(app)/layout.tsx`, `nav-links.tsx`, `src/lib/nav.ts`), `src/components/ui/help-text.ts` entries |

## Cross-agent interfaces (implement exactly)
- tools: `src/modules/assistant/tools/index.ts` exports `TOOLS: ToolDef[]`, `getTool(id)`, `toolsForModel()` → Anthropic tool JSON (`{name, description, input_schema}` via `z.toJSONSchema`). It imports `memoryTools` from `./memory` and `commandTools` from `./commands` (memory agent creates these; tools agent may create a stub exporting `[]` if missing, memory agent overwrites).
- memory: `src/modules/assistant/memory/service.ts` exports
  `recallMemories(ctx, refs: EntityRef[], opts?) => ContextPackage["memories"]`,
  `saveMemory(ctx, input)`, `correctMemory(ctx, id, newContent, source)` (old → status outdated, superseded_by), `forgetMemory(ctx,id)`, `restrictMemory(ctx,id)`, `listMemories(ctx, filter)`.
- engine: `src/modules/assistant/engine/run.ts` exports
  `runAssistant(opts: { ctx: AppContext; conversationId?: string|null; request: string; focus?: EntityRef|null; attachmentIds?: string[]; commandId?: string; idempotencyKey?: string; onEvent?: (e: StreamEvent) => void }) => Promise<{ runId: string; conversationId: string; messageId: string; status: RunStatus }>`
  and `serviceContext(workspaceId, userId) => AppContext` (admin client, for scheduled jobs only).
  `src/modules/assistant/engine/approvals.ts` exports `decideApproval(ctx, approvalId, decision: "approve"|"reject")`.
- API (engine owns, ui consumes):
  - `POST /api/v1/assistant/chat` body `{conversationId?, message, focus?, attachmentIds?}` header `Idempotency-Key` → `text/event-stream`, each event `data: <StreamEvent JSON>\n\n`.
  - `GET /api/v1/assistant/conversations?q=` → `{items:[{id,title,last_message_at,pinned,context_entity_type}]}`; `GET /api/v1/assistant/conversations/[id]` → `{conversation, messages:[{id,seq,role,content,blocks,status,created_at}]}`; `PATCH` `{title?,pinned?}`; `DELETE` archives.
  - `POST /api/v1/assistant/approvals/[id]` `{decision}` → `{status, blocks}`.
  - `POST /api/v1/assistant/attachments` multipart `file`, optional `conversationId` → `{id, name, pages, chars}`.
  - `POST /api/v1/assistant/feedback` `{messageId, rating, comment?}`.
  - `GET /api/v1/assistant/runs/[id]` → run row + tool executions.
- commands API (memory agent owns, under `src/app/api/v1/assistant/commands/**` — engine agent must not create that folder).
  memory API likewise under `src/app/api/v1/assistant/memory/**`.

## Working rules
- Don't run `next build`/`next dev`. Use `npx tsc --noEmit 2>&1 | grep assistant` and `npx vitest run src/modules/assistant/<yourpart>`.
- Local DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Tests use `tests/helpers.ts` fixtures.
- Read neighbouring module READMEs (`src/modules/*/README.md`) and services before wrapping them. Reuse; don't duplicate business logic.
- No git commits/pushes — the lead does that.
- Finish with a short report: files, exports, anything blocked or stubbed.
