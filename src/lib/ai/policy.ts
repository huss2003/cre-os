/**
 * AI usage policy — per-feature switch "AI off / AI as backup / AI on" (owner request, Nov 2026: code is the default).
 * See docs/ai-policy.md. Pure module except getAiMode (one workspace_setting read); safe to import from tests and pages.
 *
 *   off    → deterministic code only. The gateway refuses the call (no network, no usage row).
 *   backup → code first; AI only when code returns null or the result fails `accept`.
 *   on     → AI first; falls back to code when AI fails / is unavailable.
 */

export type AiMode = "off" | "backup" | "on";
export type FeatureGroup = "code" | "code_first" | "ai_needed";
export const AI_MODES: readonly AiMode[] = ["off", "backup", "on"];
export const AI_MODES_SETTING_KEY = "ai.modes";

export interface AiFeature {
  label: string;
  group: FeatureGroup;
  default: AiMode;
  description: string;
  /** Gateway workflow names. A trailing "*" is a prefix match (longest match wins). */
  workflows: string[];
}

const code = (label: string, description: string, workflows: string[]): AiFeature => ({ label, group: "code", default: "off", description, workflows });
const codeFirst = (label: string, description: string, workflows: string[]): AiFeature => ({ label, group: "code_first", default: "backup", description, workflows });
const aiNeeded = (label: string, description: string, workflows: string[]): AiFeature => ({ label, group: "ai_needed", default: "on", description, workflows });

export const FEATURES = {
  // ---------------------------------------------------------------- group 1: code does it (default off)
  "brief.synthesis": code("Morning brief", "Builds today's brief from tasks, leases and signals using fixed ranking rules.", ["brief.synthesis"]),
  "orchestrator.daily_plan": code("Daily plan", "Orders the day's work by due date, priority and meeting times.", ["orchestrator.daily_plan"]),
  "orchestrator.weekly_review": code("Weekly review", "Summarises the week from counts of tasks, deals and meetings.", ["orchestrator.weekly_review"]),
  "scoring.explain": code("Score explanations", "Explains a lead score by listing the rules that added or removed points.", ["scoring.explain"]),
  "search.nl_filter": code("Search filters from plain words", "Turns phrases like 'Baner 20k sf' into filters with pattern rules.", ["search.nl_filter"]),
  "signals.assess": code("Signal assessment", "Rates signals with keyword and source rules.", ["signals.assess"]),
  "capture.classify_document": code("Document type detection", "Guesses the document type from file name and keywords.", ["capture.classify_document"]),
  "meetings.brief": code("Meeting prep & outcomes", "Builds meeting briefs and outcome notes from records and templates.", ["meetings.brief", "meetings.outcome"]),
  "outreach.draft": code("Outreach drafts", "Fills outreach drafts from templates and record fields.", ["outreach.draft"]),
  "integrations.outreach_draft": code("Connector outreach drafts", "Template drafts for messages started from email/calendar connections.", ["integrations.outreach_draft"]),
  "network.reconnect": code("Reconnect suggestions", "Template messages to reconnect with contacts gone quiet.", ["network.reconnect"]),
  "network.intro_request": code("Intro requests", "Template intro requests through a mutual contact.", ["network.intro_request"]),
  "toolkit.negotiation_points": code("Negotiation points", "Lists negotiation points from deal numbers and market comparisons.", ["toolkit.negotiation_points"]),
  "integrations.triage": code("Inbox triage", "Sorts incoming mail with sender and keyword rules.", ["integrations.triage"]),
  "outreach.response": code("Reply classification", "Classifies replies (interested, not now, unsubscribe) with keyword rules.", ["outreach.response"]),
  "intelligence.memory": code("Memory summaries", "Summarises and tidies stored context with fixed rules.", ["intelligence.memory.summary*", "intelligence.memory_consolidate"]),
  "market.note": code("Market notes", "Writes market notes from stored figures and a template.", ["market.note"]),
  "assistant.style_profile": code("Writing-style profile", "Learns your writing style from word and phrase counts.", ["assistant.style_profile"]),
  "assistant.learn_draft_edit": code("Learning from draft edits", "Notes what you change in drafts using text differences.", ["assistant.learn_draft_edit"]),
  "assistant.evals.grade": code("Assistant self-checks", "Grades assistant answers against fixed checklists.", ["assistant.evals.grade"]),
  "assistant.routing": code("Assistant request routing", "Decides which assistant tool handles a request using pattern rules.", ["assistant.route", "assistant.planner"]),
  // ---------------------------------------------------------------- group 2: code first, AI as backup (default backup)
  "capture.extract": codeFirst("Capture field extraction", "Reads fields from notes and emails with patterns; AI only if patterns miss.", ["capture.extract"]),
  "capture.lease_terms": codeFirst("Lease terms from documents", "Finds rent, dates and escalations with patterns; AI only if needed.", ["capture.lease_terms", "assistant.lease_terms"]),
  "toolkit.quote_intake": codeFirst("Quote intake", "Reads landlord quotes with patterns; AI only if needed.", ["toolkit.quote_intake"]),
  "legal.extract": codeFirst("Legal clause extraction", "Finds clauses by headings and keywords; AI only if needed.", ["legal.extract"]),
  "capture.ocr": codeFirst("Reading text from images & scans", "Local text reading first; AI vision only if it returns nothing.", ["capture.ocr", "capture.document_ocr"]),
  // ---------------------------------------------------------------- group 3: needs AI (default on)
  "transcribe": aiNeeded("Voice transcription", "Turns voice notes into text (Hindi/English/Hinglish).", ["transcribe"]),
  "research.web": aiNeeded("Web research", "Searches the web for company and market facts.", ["research.web", "research.dossier", "assistant.web_research"]),
  "signals.research": aiNeeded("Signal discovery", "Searches the web for new signals and checks them.", ["signals.research", "signals.discover"]),
  "assistant.answer": aiNeeded("Assistant free answers", "Answers open questions in the assistant chat.", ["assistant.*"]),
  "content.draft": aiNeeded("Content writing", "Drafts posts and articles.", ["content.draft"]),
  "integrations.thread_summary": aiNeeded("Email thread summaries", "Summarises long email threads.", ["integrations.thread_summary"]),
  "contacts.enrich": aiNeeded("Contact enrichment", "Looks up public details for a contact.", ["contacts.enrich"]),
  "assistant.summarise": aiNeeded("Conversation summaries", "Summarises long assistant conversations.", ["assistant.summarise"]),
} satisfies Record<string, AiFeature>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];
export const GROUPS: { key: FeatureGroup; label: string; description: string }[] = [
  { key: "code", label: "Runs on code", description: "Rules and templates do this well. AI is off by default." },
  { key: "code_first", label: "Code first, AI as backup", description: "Code tries first; AI is used only when code can't read the input." },
  { key: "ai_needed", label: "Needs AI", description: "Code can't do these well (speech, web research, open writing)." },
];

export const isAiMode = (v: unknown): v is AiMode => v === "off" || v === "backup" || v === "on";
export const isFeatureKey = (v: unknown): v is FeatureKey => typeof v === "string" && v in FEATURES;

/** Feature that owns a gateway workflow (exact match beats prefix; longest prefix wins). Null = not governed. */
export function featureForWorkflow(workflow: string): FeatureKey | null {
  let best: FeatureKey | null = null;
  let bestLen = -1;
  for (const key of FEATURE_KEYS) {
    for (const w of FEATURES[key].workflows as string[]) {
      if (w === workflow) return key;
      if (w.endsWith("*") && workflow.startsWith(w.slice(0, -1)) && w.length > bestLen) { best = key; bestLen = w.length; }
    }
  }
  return best;
}

export function defaultModes(): Record<FeatureKey, AiMode> {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, FEATURES[k].default])) as Record<FeatureKey, AiMode>;
}

/** Stored map (may be partial / contain junk) merged over defaults. */
export function resolveModes(stored: unknown): Record<FeatureKey, AiMode> {
  const out = defaultModes();
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) if (isFeatureKey(k) && isAiMode(v)) out[k] = v;
  }
  return out;
}

/** Minimal client shape: a Supabase client (user ctx.db or admin) on schema "mudar". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { from: (t: string) => any };

export async function getAiModes(db: DbLike, workspaceId: string | null): Promise<Record<FeatureKey, AiMode>> {
  if (!workspaceId) return defaultModes();
  try {
    const { data } = await db.from("workspace_setting").select("value").eq("workspace_id", workspaceId).eq("key", AI_MODES_SETTING_KEY).maybeSingle();
    return resolveModes(data?.value);
  } catch {
    return defaultModes();
  }
}

/** Mode for a feature key (or a gateway workflow name). Unknown keys/workflows → "on" (not governed). */
export async function getAiMode(db: DbLike, workspaceId: string | null, featureKeyOrWorkflow: string): Promise<AiMode> {
  const key = isFeatureKey(featureKeyOrWorkflow) ? featureKeyOrWorkflow : featureForWorkflow(featureKeyOrWorkflow);
  if (!key) return "on";
  return (await getAiModes(db, workspaceId))[key];
}

export interface PolicyOutcome<T> { value: T | null; source: "code" | "ai" | "none"; aiError?: unknown }

/**
 * Run a feature under its mode.
 *  off    → code only (value may be null).
 *  backup → code; if null or !accept → ai; if ai throws → keep code's value (may be null).
 *  on     → ai; if ai throws (incl. AiDisabledError/AiUnavailableError) → code.
 */
export async function runWithPolicy<T>(opts: {
  mode: AiMode;
  code: () => T | null | Promise<T | null>;
  ai: () => Promise<T>;
  accept?: (t: T) => boolean;
}): Promise<PolicyOutcome<T>> {
  const accept = opts.accept ?? (() => true);
  const runCode = async () => { const v = await opts.code(); return v ?? null; };
  if (opts.mode === "off") { const v = await runCode(); return { value: v, source: v === null ? "none" : "code" }; }
  if (opts.mode === "backup") {
    const v = await runCode();
    if (v !== null && accept(v)) return { value: v, source: "code" };
    try { return { value: await opts.ai(), source: "ai" }; }
    catch (e) { return { value: v, source: v === null ? "none" : "code", aiError: e }; }
  }
  try { return { value: await opts.ai(), source: "ai" }; }
  catch (e) { const v = await runCode(); return { value: v, source: v === null ? "none" : "code", aiError: e }; }
}

/** True for the gateway's AiDisabledError (reason "ai_disabled"): the workflow's feature is set to code only. */
export const isAiDisabled = (e: unknown): boolean => (e as { reason?: string } | null)?.reason === "ai_disabled";
