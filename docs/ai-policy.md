# AI use policy (per-feature switch)

Code is the default. Each AI-backed feature has a mode, set per workspace at **Settings → AI use** (`/settings/ai`):

| Mode | Behaviour |
|---|---|
| `off` | Deterministic code only. The gateway makes **no network call and writes no `model_usage` row**. |
| `backup` | Code first; AI only when code returns `null` or its result fails `accept`. |
| `on` | AI first; deterministic code when AI fails / is unavailable. |

Storage: `workspace_setting` key `ai.modes` = `{ "<featureKey>": "off"|"backup"|"on" }` (only non-default values). Missing → defaults.

## API — `src/lib/ai/policy.ts`

```ts
type AiMode = "off" | "backup" | "on";
type FeatureGroup = "code" | "code_first" | "ai_needed";
FEATURES: Record<FeatureKey, { label; group; default: AiMode; description; workflows: string[] }>   // "x.*" = prefix
featureForWorkflow(workflow: string): FeatureKey | null          // exact beats prefix; longest prefix wins
getAiMode(db | admin, workspaceId, featureKeyOrWorkflow): Promise<AiMode>   // unknown → "on" (not governed)
getAiModes(db, workspaceId): Promise<Record<FeatureKey, AiMode>>
runWithPolicy({ mode, code: () => T | null | Promise<T|null>, ai: () => Promise<T>, accept?: (t) => boolean })
  : Promise<{ value: T | null; source: "code" | "ai" | "none"; aiError?: unknown }>
isAiDisabled(e): boolean
```

## Gateway enforcement — `src/lib/ai/gateway.ts`

`callStructured`, `transcribe`, `extractImageText` look up the mode of the workflow's feature first (before the
pause/budget guard). When it is `off`:

- `callStructured` with `mock` → returns `{ data: mock(), mocked: true, disabled: true, model: "code" }` (the existing mock branch, reused);
  without `mock` → throws `AiDisabledError` (subclass of `AiUnavailableError`, `reason: "ai_disabled"`).
- `transcribe` with `mockText` → `{ text: mockText, mocked: true, disabled: true }`; otherwise throws `AiDisabledError`.
- `extractImageText` → `{ text: mock?.() ?? "", mocked: true, disabled: true, model: "code" }`.
- One row is added to `resource_usage` (`module 'ai'`, `unit 'calls_saved'`, `resource 'ai_call_avoided'`, `workflow`).

Workflows not in the registry are not governed (behave as `on`). `backup` / `on` are not changed by the gateway; callers
choose the order with `runWithPolicy`.

## Calling pattern

```ts
const mode = await getAiMode(ctx.db, ctx.workspaceId, "capture.extract");
const r = await runWithPolicy({
  mode,
  code: () => extractWithRules(text),                 // null = "code could not do it"
  ai: async () => (await callStructured({ workflow: "capture.extract", ..., mock: () => extractWithRules(text) ?? EMPTY })).data,
  accept: (x) => x.fields.length > 0,
});
```

## Feature groups & defaults

1. **Runs on code** (default `off`): brief.synthesis, orchestrator.daily_plan, orchestrator.weekly_review, scoring.explain,
   search.nl_filter, signals.assess, capture.classify_document, meetings.brief (+ meetings.outcome), outreach.draft,
   integrations.outreach_draft, network.reconnect, network.intro_request, toolkit.negotiation_points, integrations.triage,
   outreach.response, intelligence.memory (intelligence.memory.summary.*, intelligence.memory_consolidate), market.note,
   assistant.style_profile, assistant.learn_draft_edit, assistant.evals.grade, assistant.routing (assistant.route, assistant.planner).
2. **Code first, AI as backup** (default `backup`): capture.extract, capture.lease_terms (+ assistant.lease_terms),
   toolkit.quote_intake, legal.extract, capture.ocr (capture.ocr, capture.document_ocr — local OCR first).
3. **Needs AI** (default `on`): transcribe, research.web (research.web, research.dossier, assistant.web_research),
   signals.research (signals.research, signals.discover), assistant.answer (`assistant.*` fallback), content.draft,
   integrations.thread_summary, contacts.enrich, assistant.summarise.
