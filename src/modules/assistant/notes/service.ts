/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { createHash } from "node:crypto";
import { enforceRules, ruleExtract, type CandidateLists, type Extraction, type Mention } from "@/modules/capture/extract";
import { defaultExtractor, findKnown, type Extractor } from "@/modules/capture/service";
import { proposeChange } from "@/lib/services/changes";
import { createTask } from "@/lib/services/tasks";
import { atLocal, localDate } from "@/lib/util/time";
import { saveMemory, type MemoryCategory } from "../memory/service";

/**
 * Notes → database updates. The pasted/dictated note is UNTRUSTED evidence (S7): it goes to the extractor as evidence,
 * and its output is re-checked by capture's deterministic rules (enforceRules). Dates come from the rule engine (S5),
 * entity ids only from permission-scoped candidates (no invented contacts, S6). analyseNotes() writes NOTHING canonical —
 * only an assistant_note row holding the proposals. approveNotes() applies the user's selection:
 * requirement fields → proposeChange() (S4, approval queue), commitments/next steps → task service, the rest → memory.
 */
export interface NoteCtx { db: any; workspaceId: string; userId: string; timezone?: string }
export interface NoteInput { text: string; meetingId?: string | null; orgId?: string | null; requirementId?: string | null }

export type ProposalKind = "requirement_field" | "task" | "memory";
export interface Group { type: "requirement" | "organisation" | "person" | "meeting" | "you"; id: string | null; label: string; href?: string }
export interface NoteProposal {
  id: string;                 // stable within the note: p0, p1...
  kind: ProposalKind;
  group: Group;
  label: string;              // "Seats target", "Task", "Objection"...
  before: unknown;
  after: unknown;
  material: boolean;          // true → goes through proposeChange (approval)
  evidence: string;           // verbatim span from the note
  note?: string;              // e.g. "Date needs confirming"
  payload: Record<string, any>;
}
export interface NoteRow {
  id: string; body: string; status: "pending_review" | "applied" | "discarded"; meeting_visit_id: string | null; org_id: string | null; requirement_id: string | null;
  proposals: NoteProposal[]; unresolved: string[]; extraction_model: string | null; interaction_id: string | null; results: Record<string, any>; created_at: string;
}

export class NoteError extends Error {}

const REQ_COLUMNS: Record<string, { label: string; column: string }> = {
  area_target_sf: { label: "Target area (sq ft)", column: "area_target_sf" },
  seats_target: { label: "Target seats", column: "seats_target" },
  budget_max: { label: "Max budget", column: "budget_max" },
  occupation_date: { label: "Occupation date", column: "occupation_date" },
  decision_date: { label: "Decision date", column: "decision_date" },
};

export const noteHash = (userId: string, i: NoteInput) =>
  createHash("sha256").update([userId, i.text.replace(/\s+/g, " ").trim().toLowerCase(), i.meetingId ?? "", i.orgId ?? "", i.requirementId ?? ""].join("|")).digest("hex");

const href = { requirement: (id: string) => `/requirements/${id}`, organisation: (id: string) => `/companies/${id}`, person: (id: string) => `/people/${id}`, meeting: (id: string) => `/meetings/${id}` };
const snippet = (text: string, s: number, e: number) => text.slice(Math.max(0, s), Math.min(text.length, Math.max(e, s + 1))).trim().slice(0, 300);
/** Sentence around an index (for property feedback evidence). */
function sentenceAt(text: string, i: number) {
  const a = Math.max(text.lastIndexOf(".", i - 1), text.lastIndexOf("\n", i - 1)) + 1;
  const ends = [text.indexOf(".", i), text.indexOf("\n", i)].filter((x) => x >= 0);
  const b = ends.length ? Math.min(...ends) : text.length;
  return text.slice(a, b).trim();
}

async function candidatesFor(c: NoteCtx, kind: string, q: string, org?: string | null) {
  const { data, error } = await c.db.schema("mudar_app").rpc("search_entity_candidates", { p_workspace: c.workspaceId, p_entity_type: kind, p_query: q, p_user: c.userId, p_org: org ?? null, p_limit: 8 });
  if (error) throw new NoteError(error.message);
  return ((data ?? []) as any[]).map((x) => ({ id: x.id as string, entity_type: x.entity_type as string, label: x.label as string, detail: x.detail, score: Number(x.score) }));
}

/** Only an unambiguous candidate counts as resolved: exactly one exact-label match, or exactly one candidate. */
function resolve(lists: CandidateLists, m: Pick<Mention, "kind" | "text" | "candidate_ids">) {
  const offered = lists.find((l) => l.kind === m.kind && l.text.toLowerCase() === m.text.toLowerCase())?.candidates ?? [];
  const allowed = offered.filter((o) => m.candidate_ids.includes(o.id) || m.candidate_ids.length === 0);
  const exact = allowed.filter((o) => o.label.toLowerCase() === m.text.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : allowed.length === 1 ? allowed[0] : null;
  return { pick, offered: allowed.length };
}

async function knownNames(c: NoteCtx) {
  const [o, p, a] = await Promise.all([
    c.db.from("organisation").select("display_name").eq("workspace_id", c.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(300),
    c.db.from("person").select("full_name").eq("workspace_id", c.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(300),
    c.db.from("asset").select("id, name").eq("workspace_id", c.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(300),
  ]);
  return {
    names: [...(o.data ?? []).map((r: any) => ({ kind: "organisation" as const, name: r.display_name as string })), ...(p.data ?? []).map((r: any) => ({ kind: "person" as const, name: r.full_name as string }))].filter((n) => n.name),
    assets: ((a.data ?? []) as any[]).filter((r) => r.name) as { id: string; name: string }[],
  };
}

/** Read the meeting (meeting_visit id or meeting_prep id) for its company/requirement. */
async function meetingContext(c: NoteCtx, meetingId: string) {
  const { data: prep } = await c.db.from("meeting_prep").select("id, meeting_visit_id, org_id, requirement_id, meeting:meeting_visit_id(title, start_at)").eq("workspace_id", c.workspaceId)
    .or(`id.eq.${meetingId},meeting_visit_id.eq.${meetingId}`).is("archived_at", null).limit(1).maybeSingle();
  if (prep) return { visitId: prep.meeting_visit_id as string, prepId: prep.id as string, orgId: prep.org_id as string | null, requirementId: prep.requirement_id as string | null, title: (Array.isArray(prep.meeting) ? prep.meeting[0] : prep.meeting)?.title as string | undefined };
  const { data: v } = await c.db.from("meeting_visit").select("id, title, linked_entity_type, linked_entity_id").eq("workspace_id", c.workspaceId).eq("id", meetingId).maybeSingle();
  if (!v) throw new NoteError("Meeting not found or you don't have access to it.");
  return { visitId: v.id as string, prepId: null, orgId: v.linked_entity_type === "organisation" ? v.linked_entity_id as string : null, requirementId: v.linked_entity_type === "requirement" ? v.linked_entity_id as string : null, title: v.title as string };
}

export async function getNote(c: NoteCtx, id: string): Promise<NoteRow | null> {
  const { data } = await c.db.from("assistant_note").select("*").eq("workspace_id", c.workspaceId).eq("owner_user_id", c.userId).eq("id", id).is("archived_at", null).maybeSingle();
  return (data as NoteRow) ?? null;
}

export async function listNotes(c: NoteCtx, limit = 10): Promise<NoteRow[]> {
  const { data } = await c.db.from("assistant_note").select("*").eq("workspace_id", c.workspaceId).eq("owner_user_id", c.userId).is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as NoteRow[];
}

/** Extract proposals from a note. Writes only the assistant_note review row (re-submitting the same note returns it). */
export async function analyseNotes(c: NoteCtx, input: NoteInput, opts: { extractor?: Extractor; now?: Date } = {}): Promise<{ note: NoteRow; duplicate: boolean }> {
  const text = input.text.trim();
  if (text.length < 3) throw new NoteError("Paste or dictate some notes first.");
  if (text.length > 20_000) throw new NoteError("Notes are too long (max 20,000 characters). Split them up.");
  const tz = c.timezone || "Asia/Kolkata";
  const now = opts.now ?? new Date();
  const hash = noteHash(c.userId, input);
  const dupe = await c.db.from("assistant_note").select("*").eq("workspace_id", c.workspaceId).eq("owner_user_id", c.userId).eq("body_hash", hash).eq("status", "pending_review").is("archived_at", null).maybeSingle();
  if (dupe.data) return { note: dupe.data as NoteRow, duplicate: true };

  const mtg = input.meetingId ? await meetingContext(c, input.meetingId) : null;
  const { names, assets } = await knownNames(c);
  const known = findKnown(text, names);

  // candidates for every mention found by rules or known names (permission-scoped RPC as this user)
  const pre = ruleExtract(text, { sourceAt: now, timezone: tz }).mentions;
  const seeds = [...known.map((k) => ({ kind: k.kind, text: k.text })), ...pre.map((m) => ({ kind: m.kind, text: m.text }))]
    .filter((m, i, a) => m.kind !== "geography" && a.findIndex((x) => x.kind === m.kind && x.text.toLowerCase() === m.text.toLowerCase()) === i);
  const candidates: CandidateLists = [];
  for (const m of seeds.slice(0, 20)) candidates.push({ kind: m.kind, text: m.text, candidates: await candidatesFor(c, m.kind, m.text) });

  const extractor = opts.extractor ?? defaultExtractor;
  const res = await extractor({ text, candidates, workspaceId: c.workspaceId, sourceAt: now.toISOString(), timezone: tz, known, directory: names.slice(0, 200).map((n) => `${n.kind}: ${n.name}`).join("\n") });
  const ex: Extraction = enforceRules(res.data, text, candidates, { sourceAt: now, timezone: tz });

  const unresolved: string[] = [];
  const mentionIds = ex.mentions.map((m) => (m.kind === "geography" ? null : resolve(candidates, m)));
  ex.mentions.forEach((m, i) => {
    const r = mentionIds[i];
    if (!r || r.pick) return;
    unresolved.push(r.offered > 1 ? `"${m.text}" matches ${r.offered} ${m.kind === "person" ? "people" : "companies"} — not linked. Pick one on the record page.` : `"${m.text}" is not in your records — not created (add them first if needed).`);
  });

  // target company + requirement
  const orgMentions = ex.mentions.map((m, i) => (m.kind === "organisation" && mentionIds[i]?.pick ? mentionIds[i]!.pick! : null)).filter(Boolean) as { id: string; label: string }[];
  let orgId = input.orgId ?? mtg?.orgId ?? (new Set(orgMentions.map((o) => o.id)).size === 1 ? orgMentions[0].id : null);
  let requirementId = input.requirementId ?? mtg?.requirementId ?? null;
  let req: any = null;
  if (requirementId) {
    const { data } = await c.db.from("requirement").select("*").eq("workspace_id", c.workspaceId).eq("id", requirementId).is("archived_at", null).maybeSingle();
    if (!data) throw new NoteError("Requirement not found or you don't have access to it.");
    req = data; orgId = orgId ?? data.org_id;
  } else if (orgId) {
    const { data } = await c.db.from("requirement").select("*").eq("workspace_id", c.workspaceId).eq("org_id", orgId).neq("status", "closed").is("archived_at", null).limit(3);
    if ((data ?? []).length === 1) { req = data[0]; requirementId = req.id; }
    else if ((data ?? []).length > 1) unresolved.push("This company has several open requirements — requirement changes were not proposed. Re-run with the requirement chosen.");
  }
  let orgLabel: string | null = null;
  if (orgId) {
    const { data } = await c.db.from("organisation").select("display_name").eq("workspace_id", c.workspaceId).eq("id", orgId).maybeSingle();
    if (!data) throw new NoteError("Company not found or you don't have access to it.");
    orgLabel = data.display_name;
  }
  const reqGroup: Group | null = req ? { type: "requirement", id: req.id, label: req.title ?? `${orgLabel ?? "Company"} requirement`, href: href.requirement(req.id) } : null;
  const orgGroup: Group | null = orgId ? { type: "organisation", id: orgId, label: orgLabel ?? "Company", href: href.organisation(orgId) } : null;
  const youGroup: Group = { type: "you", id: null, label: "Your tasks", href: "/tasks" };
  const link = req ? { type: "requirement", id: req.id } : orgId ? { type: "organisation", id: orgId } : mtg ? { type: "meeting_visit", id: mtg.visitId } : null;

  const proposals: NoteProposal[] = [];
  const push = (p: Omit<NoteProposal, "id">) => proposals.push({ ...p, id: `p${proposals.length}` });
  const ambFor = (k: "fact_index" | "task_index", i: number) => ex.ambiguities.find((a) => a[k] === i);

  // requirement facts (material → proposeChange)
  ex.facts.forEach((f, i) => {
    const col = REQ_COLUMNS[f.field];
    const amb = ambFor("fact_index", i);
    if (!col) { unresolved.push(`"${f.raw_text}" (${f.field.replace(/_/g, " ")}) — not mapped automatically; update the requirement by hand.`); return; }
    if (f.proposed_value === null || amb) { unresolved.push(`${col.label}: ${amb?.question ?? `"${f.raw_text}" is unclear`} — left unknown.`); return; }
    if (!reqGroup) { unresolved.push(`${col.label} "${f.raw_text}" — no requirement identified, so nothing proposed.`); return; }
    const before = req[col.column] ?? null;
    if (before !== null && String(before) === String(f.proposed_value)) return; // already recorded
    push({ kind: "requirement_field", group: reqGroup, label: col.label, before, after: f.proposed_value, material: true, evidence: snippet(text, f.start, f.end) || f.raw_text,
      note: f.requires_confirmation ? "Critical value — goes to Approvals" : undefined, payload: { field: col.column, value: f.proposed_value, requirementId: req.id, expectedVersion: Number(req.row_version) } });
  });
  // details (constraints) → requirement memory
  for (const d of ex.details) {
    if (d.value === null) continue;
    const g = reqGroup ?? orgGroup;
    if (!g) { unresolved.push(`${d.key.replace(/_/g, " ")}: "${d.raw_text}" — no company identified.`); continue; }
    push({ kind: "memory", group: g, label: `Requirement detail: ${d.key.replace(/_/g, " ")}`, before: null, after: `${d.key.replace(/_/g, " ")}: ${d.value}`, material: false, evidence: d.raw_text,
      payload: { category: (g.type === "requirement" ? "requirement" : "company") as MemoryCategory, entityType: g.type, entityId: g.id, content: `${d.key.replace(/_/g, " ")}: ${d.value} (from notes: "${d.raw_text}")` } });
  }
  // commitments + next steps → tasks (due dates from the rule engine; ambiguous → no date)
  const dueAt = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? atLocal(d, "18:00", tz).toISOString() : null);
  const taskIdxFromPromises = new Set<number>();
  ex.promises.forEach((p) => {
    if (p.task_index !== null) taskIdxFromPromises.add(p.task_index);
    const amb = p.task_index !== null ? ambFor("task_index", p.task_index) : undefined;
    const mine = /^(me|i|we)$/i.test(p.who.trim());
    const due = amb ? null : p.due;
    push({ kind: "task", group: youGroup, label: mine ? "Your commitment" : `Commitment by ${p.who}`, before: null, after: `${mine ? "" : `Chase ${p.who}: `}${p.what}${due ? ` (due ${due})` : ""}`, material: false,
      evidence: snippet(text, p.start, p.end), note: amb ? `Due date unclear: ${amb.question}` : due ? undefined : "No due date stated",
      payload: { title: `${mine ? "" : `Chase ${p.who}: `}${p.what}`.slice(0, 300), dueAt: dueAt(due), link } });
  });
  ex.tasks.forEach((t, i) => {
    if (taskIdxFromPromises.has(i)) return;
    const amb = ambFor("task_index", i);
    const due = amb ? null : t.due_date;
    push({ kind: "task", group: youGroup, label: "Next step", before: null, after: `${t.description}${due ? ` (due ${due})` : ""}`, material: false, evidence: snippet(text, t.start, t.end),
      note: amb ? `Due date unclear: ${amb.question}` : undefined, payload: { title: t.description.slice(0, 300), dueAt: dueAt(due), link } });
  });
  // people + roles → person memory (resolved people only)
  for (const s of ex.stakeholders) {
    const m = ex.mentions[s.mention_index];
    const pick = mentionIds[s.mention_index]?.pick;
    if (!m) continue;
    if (!pick) { unresolved.push(`${m.text} (${s.role}) — person not linked, so the role was not saved.`); continue; }
    push({ kind: "memory", group: { type: "person", id: pick.id, label: pick.label, href: href.person(pick.id) }, label: "Role in deal", before: null, after: `${s.role}${orgLabel ? ` for ${orgLabel}` : ""}`, material: false, evidence: s.raw_text,
      payload: { category: "person" as MemoryCategory, entityType: "person", entityId: pick.id, content: `Role in ${orgLabel ?? "the deal"}: ${s.role} (from notes: "${s.raw_text}")`, scope: "employer" } });
  }
  // objections → requirement/company memory
  for (const o of ex.objections) {
    const g = reqGroup ?? orgGroup;
    if (!g) { unresolved.push(`Objection "${o.text}" — no company identified.`); continue; }
    push({ kind: "memory", group: g, label: "Objection", before: null, after: o.text, material: false, evidence: snippet(text, o.start, o.end),
      payload: { category: (g.type === "requirement" ? "requirement" : "company") as MemoryCategory, entityType: g.type, entityId: g.id, content: `Objection raised: ${o.text}` } });
  }
  // property feedback: a known building named in the note → sentence → company memory
  const lower = text.toLowerCase();
  for (const a of assets) {
    const i = lower.indexOf(a.name.toLowerCase());
    if (a.name.length < 3 || i < 0) continue;
    const sentence = sentenceAt(text, i);
    if (!orgGroup) { unresolved.push(`Feedback on ${a.name} — no company identified.`); continue; }
    push({ kind: "memory", group: orgGroup, label: `Property feedback: ${a.name}`, before: null, after: sentence, material: false, evidence: sentence,
      payload: { category: "company" as MemoryCategory, entityType: "organisation", entityId: orgGroup.id, content: `Feedback on ${a.name}: ${sentence}`, assetId: a.id } });
  }

  const row = {
    workspace_id: c.workspaceId, owner_user_id: c.userId, body: text, body_hash: hash, meeting_visit_id: mtg?.visitId ?? null, org_id: orgId, requirement_id: requirementId,
    proposals, unresolved: [...new Set(unresolved)], extraction_model: res.model, status: "pending_review",
  };
  const { data, error } = await c.db.from("assistant_note").insert(row).select("*").single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return analyseNotes(c, input, opts);
    throw new NoteError(error.message);
  }
  return { note: data as NoteRow, duplicate: false };
}

/** Apply the selected proposals. Idempotent: an applied note returns its stored results. Unselected ones are discarded. */
export async function approveNotes(c: NoteCtx, noteId: string, selected: string[], opts: { now?: Date } = {}) {
  const note = await getNote(c, noteId);
  if (!note) throw new NoteError("Note not found.");
  if (note.status === "applied") return { duplicate: true, results: note.results, interactionId: note.interaction_id };
  if (note.status !== "pending_review") throw new NoteError("This note was discarded.");
  const now = opts.now ?? new Date();
  const chosen = note.proposals.filter((p) => selected.includes(p.id));
  const results: Record<string, any> = { applied: {}, rejected: note.proposals.filter((p) => !selected.includes(p.id)).map((p) => p.id), errors: {} };

  // 1. interaction (the note itself) linked to entities — idempotent on source_message_id
  const key = `assistant_note:${note.id}`;
  let interactionId: string | null = null;
  const { data: ex } = await c.db.from("interaction").select("id").eq("workspace_id", c.workspaceId).eq("source_message_id", key).maybeSingle();
  if (ex) interactionId = ex.id;
  else {
    const { data, error } = await c.db.from("interaction").insert({ workspace_id: c.workspaceId, owner_user_id: c.userId, occurred_at: now.toISOString(), channel: note.meeting_visit_id ? "meeting" : "note",
      direction: "internal", subject: "Notes (assistant)", summary: note.body.slice(0, 4000), source_message_id: key, is_meaningful: !!note.meeting_visit_id,
      promises: chosen.filter((p) => p.kind === "task").map((p) => p.after), objections: chosen.filter((p) => p.label === "Objection").map((p) => p.after) }).select("id").single();
    if (error) throw new NoteError(error.message);
    interactionId = data.id;
  }
  const links = new Map<string, { type: string; id: string }>();
  if (note.org_id) links.set(note.org_id, { type: "organisation", id: note.org_id });
  if (note.requirement_id) links.set(note.requirement_id, { type: "requirement", id: note.requirement_id });
  if (note.meeting_visit_id) links.set(note.meeting_visit_id, { type: "meeting_visit", id: note.meeting_visit_id });
  for (const p of chosen) if (p.group.type === "person" && p.group.id) links.set(p.group.id, { type: "person", id: p.group.id });
  for (const l of links.values()) {
    const { data: has } = await c.db.from("interaction_link").select("id").eq("workspace_id", c.workspaceId).eq("interaction_id", interactionId).eq("entity_id", l.id).maybeSingle();
    if (!has) await c.db.from("interaction_link").insert({ workspace_id: c.workspaceId, owner_user_id: c.userId, interaction_id: interactionId, entity_type: l.type, entity_id: l.id, role: "subject" });
  }

  // 2. material requirement changes → one proposal per requirement (approval queue)
  const byReq = new Map<string, NoteProposal[]>();
  for (const p of chosen.filter((x) => x.kind === "requirement_field")) byReq.set(p.payload.requirementId, [...(byReq.get(p.payload.requirementId) ?? []), p]);
  for (const [reqId, ps] of byReq) {
    try {
      const cp = await proposeChange(c.db, c.workspaceId, {
        targetType: "requirement", targetId: reqId, operation: "update", expectedVersion: ps[0].payload.expectedVersion,
        patch: ps.map((p) => ({ op: "replace" as const, path: `/${p.payload.field}`, value: p.payload.value })),
        reason: `From notes reviewed in the assistant: ${ps.map((p) => `"${p.evidence}"`).join("; ")}`.slice(0, 1000),
        proposedByKind: "model", idempotencyKey: `${key}:req:${reqId}`, ownerUserId: c.userId, actorUserId: c.userId,
      });
      for (const p of ps) results.applied[p.id] = { proposalId: (cp as any)?.id ?? (cp as any)?.proposal?.id ?? null, status: "proposed" };
    } catch (e) { for (const p of ps) results.errors[p.id] = (e as Error).message; }
  }
  // 3. tasks
  for (const p of chosen.filter((x) => x.kind === "task")) {
    try {
      const t = await createTask(c.db, c.workspaceId, { title: p.payload.title, description: `From notes: "${p.evidence}"`, dueAt: p.payload.dueAt, source: "capture",
        linkedEntityType: p.payload.link?.type ?? null, linkedEntityId: p.payload.link?.id ?? null, assignedUserId: c.userId, ownerUserId: c.userId, idempotencyKey: `${key}:${p.id}` });
      results.applied[p.id] = { taskId: t.id };
    } catch (e) { results.errors[p.id] = (e as Error).message; }
  }
  // 4. memories
  for (const p of chosen.filter((x) => x.kind === "memory")) {
    try {
      const m = await saveMemory(c, { category: p.payload.category, entityType: p.payload.entityType, entityId: p.payload.entityId, content: p.payload.content,
        source: `note:${note.id}`, sourceRef: { note_id: note.id, interaction_id: interactionId }, stated: true, scope: p.payload.scope });
      results.applied[p.id] = { memoryId: m.id };
    } catch (e) { results.errors[p.id] = (e as Error).message; }
  }

  const { error } = await c.db.from("assistant_note").update({ status: "applied", results, interaction_id: interactionId, decided_at: now.toISOString() })
    .eq("workspace_id", c.workspaceId).eq("id", note.id).eq("status", "pending_review");
  if (error) throw new NoteError(error.message);
  return { duplicate: false, results, interactionId };
}

export async function discardNote(c: NoteCtx, noteId: string) {
  const { error } = await c.db.from("assistant_note").update({ status: "discarded", decided_at: new Date().toISOString() })
    .eq("workspace_id", c.workspaceId).eq("owner_user_id", c.userId).eq("id", noteId).eq("status", "pending_review");
  if (error) throw new NoteError(error.message);
}

export const todayLocal = (tz = "Asia/Kolkata") => localDate(new Date(), tz);
