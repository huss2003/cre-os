# Assistant context and memory

## Memory behaviour

Code: `src/modules/assistant/memory/service.ts` (table `mudar.assistant_memory`), tools in `tools/memory.ts`, page `/assistant/memory`, API `/api/v1/assistant/memory[/:id]`.

- **Categories**: person, company (`entity_type = organisation`), requirement, relationship. Requirement memories never overwrite each other; each is its own row.
- **Stated vs inferred**: `stated=true` only for things the user/contact said explicitly. Inferences are saved with `stated=false` (default confidence 0.5) and are always handed to the model prefixed `(inferred)` and shown with an "Inferred" chip. Never presented as fact.
- **Source and dates**: every memory stores `source` (`conversation:<id>`, `user`, `meeting:<id>`), `source_ref`, `provided_by`, `captured_at`, `last_verified_at`, `review_at` (default captured + 180 days).
- **Staleness**: computed at read time — stale when past `review_at` or not verified/captured in 180 days. Stale memories are still recalled but flagged (`stale: true`) and rank lower; "Mark verified" resets the clock. No sweep job is needed.
- **Correction** (`correctMemory`, tool `correct_memory`, spec Test 9): the old row becomes `outdated` with `superseded_by_id`; a new `stated` row is created with `supersedes_id`, the conversation as source and today's date. The page shows the earlier versions. Outdated rows are never recalled.
- **Forget**: status `forgotten`, content replaced by a tombstone, source details cleared. Tool `forget_memory` is category C (approval card).
- **Restrict**: status + sensitivity `restricted`. Excluded from model context unless the memory's owner explicitly asks (`include_restricted`).
- **Employer scoping**: person memories record `org_context_id` = the person's current employer at capture time. Company-specific memories (`source_ref.scope = 'employer'`, tool flag `company_specific`) are recalled only while the person still works there — never carried to a new employer.
- **Sensitive data guard**: content mentioning health, religion, caste/ethnicity, politics, sexual orientation, disability, criminal history or ID/financial account numbers is refused with a message.
- **Recall** (`recallMemories(ctx, refs, opts)`): active memories for the referenced entities (or full-text match on `q`), workspace-filtered explicitly + RLS, ranked by entity match (focus first), recency, confidence and stated-ness, max 12.

### Saved commands
`commands/service.ts`: CRUD, duplicate, version bump on every edit, run history (`assistant_run.command_id`), run now (`runAssistant` with `{{input}}` placeholders filled from inputs → defaults; missing required inputs stop the run). Seven ready-made templates (spec §14) are offered with "Add" buttons, not auto-created.
Scheduling is opt-in: enabling needs an explicit confirmation which stamps `schedule_authorised_at`; editing the prompt revokes it. Cron is evaluated in IST (`commands/cron.ts`). `assistant.schedule` enqueues `assistant.command` jobs only for enabled + authorised + due commands, dedupe key `cmd:<id>:<next_run_at>`; the handler re-checks opt-in, runs as the command owner via `serviceContext`, and advances `next_run_at`.

## Context retrieval

Owner: engine (`src/modules/assistant/engine/context.ts`). Called once per run by `runAssistant()` before the model sees anything.

**Entity resolution** (all reads through `ctx.db` = RLS, plus an explicit `.eq("workspace_id", ctx.workspaceId)`):
1. **Focus** — the record the page passed in (`focus: EntityRef`). Re-fetched by id; if it is not visible (other workspace / no
   access) the focus is dropped, a `mudar.assistant_security_event` (`access_denied`, `where: context.focus`) and an
   `audit_event` are written, and the user only sees "not found or you do not have access" — the label the client sent is never echoed.
2. **Deictic references** — "this client", "that property", "the previous option", "these three properties", "he/she" are mapped
   to entity types and resolved from the focus first, then the conversation's `entity_refs` (most recent first; updated after every
   run from the entities tools returned).
3. **Name search** — candidate phrases (quoted strings, capitalised runs, distinctive tokens; stop-words removed) are matched with
   `ilike` over `organisation.display_name`, `person.full_name`, `asset.name`, `requirement.title`, `opportunity.name`,
   `meeting_visit.title`. Max 3 hits per type, ranked by matched length. Unmatched names are reported in `missing`.
   (`semanticSearch()` hook lives with the tools; full-text `search` tsvectors are used by the search tools.)

**Package assembly** (`ContextPackage`), deliberately compact:
- `records`: max 12 compact rows of the resolved entities (nulls dropped, long text cut at 200 chars, `updated_at` exposed as
  `observed_at`, a `source` label). Detail comes from tools, not from the prompt.
- `memories`: `recallMemories(ctx, resolved, {limit: 12})` (memory service); content capped at 300 chars; any `stale` memory adds a
  "possibly stale" note to `missing`.
- `conversation`: rolling `summary` + the last 8 messages after `summary_upto` (600 chars each). When a conversation passes 20
  messages, `maybeSummarise()` folds older messages into `summary` / `decisions` / `open_questions` with the cheap model
  (deterministic mock without a key) — keeps the last 10 verbatim.
- `attachments`: excerpts (1,500 chars) of attached files; sent to the model only inside `<evidence>` (untrusted).
- `missing`: everything that could not be resolved or loaded — surfaced in the answer's "missing" block, never hidden.
- `tools`: id + category list.

`renderContext()` turns the package into the trusted "Context" section of the system prompt (~6k chars max for records).

**Routing** (`engine/router.ts`): keyword intent classifier, no extra LLM call. Deep model (`ASSISTANT_MODEL_DEEP`, default
`claude-sonnet-5-5`) for deal review, comparisons, research/web, meeting prep, ranking, "why", multi-step or long requests and
attachments; otherwise fast (`ASSISTANT_MODEL_FAST`, default `claude-haiku-5-5`). Web search is enabled only for research intents.
