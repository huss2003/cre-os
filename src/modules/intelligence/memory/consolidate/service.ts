/**
 * Module 13 §8 — consolidation service. Reads observations from capture_observation (Input Engine, which already
 * flags repeats: independent / repeat_of), interaction objections/promises, meeting notes and assistant_memory
 * preferences for an entity, then consolidates them (pure `consolidate`). Nothing is written; originals stay linked.
 */
import "server-only";
import { z } from "zod";
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import type { MemCtx, Row, SourceRef } from "../types";
import { commitmentsFrom, interactionsFor, interactionSource, objectionsFrom, q } from "../data";
import { consolidate, consolidateMeetingNotes, kindOf, type Obs, type NoteIn } from "./consolidate";

export interface Scope { orgId?: string; personId?: string; requirementId?: string }

const subjectIds = async (ctx: MemCtx, s: Scope) => {
  const ids: { type: string; id: string }[] = [];
  if (s.orgId) {
    ids.push({ type: "organisation", id: s.orgId });
    for (const r of await q<Row[]>(ctx.db.from("requirement").select("id").eq("workspace_id", ctx.workspaceId).eq("org_id", s.orgId).limit(50))) ids.push({ type: "requirement", id: r.id });
  }
  if (s.personId) ids.push({ type: "person", id: s.personId });
  if (s.requirementId) ids.push({ type: "requirement", id: s.requirementId });
  return ids;
};

export async function loadObservations(ctx: MemCtx, s: Scope): Promise<Obs[]> {
  const ws = ctx.workspaceId;
  const subj = await subjectIds(ctx, s);
  const out: Obs[] = [];
  if (subj.length) {
    const rows = await q<Row[]>(ctx.db.from("capture_observation").select("id, intent, fact_class, field, raw_text, value_json, observed_at, source_hash, independent, repeat_of, verification, status, capture_id, capture_document_id, source_type, source_ref, subject_type, subject_id")
      .eq("workspace_id", ws).in("subject_id", subj.map((x) => x.id)).is("archived_at", null).neq("status", "rejected").neq("fact_class", "task").limit(1000));
    for (const r of rows) out.push({
      id: r.id, kind: kindOf(r), field: r.field, text: r.raw_text, value: r.value_json ?? null, at: r.observed_at, sourceKey: r.source_hash ?? r.capture_id ?? r.id,
      independent: r.independent !== false, repeatOf: r.repeat_of ?? null, factClass: r.fact_class, verification: r.verification,
      source: { type: r.capture_document_id ? "capture_document" : "capture", id: r.capture_id ?? r.capture_document_id ?? r.id, label: `${r.source_type?.replace(/_/g, " ") ?? "capture"} ${String(r.observed_at).slice(0, 10)}${r.source_ref?.page ? ` p.${r.source_ref.page}` : ""}`, href: r.capture_id ? `/capture/${r.capture_id}` : null },
    });
  }
  // Interactions: objections / commitments recorded on meeting notes and calls (each interaction is its own source).
  const ints = [
    ...(s.orgId ? await interactionsFor(ctx, "organisation", [s.orgId]) : []),
    ...(s.personId ? await interactionsFor(ctx, "person", [s.personId]) : []),
    ...(s.requirementId ? await interactionsFor(ctx, "requirement", [s.requirementId]) : []),
  ].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  for (const o of objectionsFrom(ints)) out.push({ id: `int-obj:${o.source.id}:${o.text.slice(0, 40)}`, kind: "objection", field: "objection", text: o.text, value: null, at: o.at, sourceKey: `interaction:${o.source.id}`, independent: true, repeatOf: null, factClass: "reported", verification: "user_stated", source: o.source });
  // Stated preferences saved by the assistant (Module 12 memory), labelled stated vs inferred.
  const mem = subj.length ? await q<Row[]>(ctx.db.from("assistant_memory").select("id, category, content, stated, captured_at, source, source_ref, status, entity_id").eq("workspace_id", ws).in("entity_id", subj.map((x) => x.id)).eq("status", "active").limit(200)).catch(() => [] as Row[]) : [];
  for (const m of mem.filter((x) => /\b(prefer\w*|must|avoid\w*|only|insist\w*|no more than|at least)\b/i.test(String(x.content)))) out.push({ id: `mem:${m.id}`, kind: "preference", field: "preference", text: m.content, value: null, at: m.captured_at, sourceKey: m.source_ref?.interaction_id ?? m.source_ref?.capture_id ?? `memory:${m.id}`, independent: true, repeatOf: null,
    factClass: m.stated ? "preference" : "assumption", verification: m.stated ? "user_stated" : "unverified", source: { type: "assistant_memory", id: m.id, label: `Saved memory${m.stated ? "" : " (inferred)"} ${String(m.captured_at).slice(0, 10)}`, href: "/assistant" } });
  return out;
}

/** §8 consolidation for a company / contact / requirement. */
export async function consolidateEntity(ctx: MemCtx, s: Scope) {
  const obs = await loadObservations(ctx, s);
  const r = consolidate(obs);
  return { ...r, observations: obs.length, unknown: obs.length ? [] : ["No observations recorded yet for this record."] };
}

/** Meeting notes of a company / contact consolidated (§17.18). Originals and links kept; optional AI summary is labelled. */
export async function consolidateMeetings(ctx: MemCtx, s: Scope, opts: { ai?: boolean; mode?: AiMode } = {}) {
  const ws = ctx.workspaceId;
  const ints = [
    ...(s.orgId ? await interactionsFor(ctx, "organisation", [s.orgId]) : []),
    ...(s.personId ? await interactionsFor(ctx, "person", [s.personId]) : []),
  ].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i && (x.channel === "meeting" || x.channel === "visit" || x.channel === "call" || x.capture_id));
  const notes: NoteIn[] = ints.map((i) => ({
    id: i.id, at: i.occurred_at, title: i.subject ?? `${i.channel} ${String(i.occurred_at).slice(0, 10)}`, text: String(i.summary ?? ""),
    commitments: commitmentsFrom([i]).map((c) => c.text), objections: objectionsFrom([i]).map((o) => o.text), source: interactionSource(i),
  }));
  // Meeting-prep notes (Module 7) for the company's meetings.
  if (s.orgId) {
    const preps = await q<Row[]>(ctx.db.from("meeting_prep").select("id, meeting:meeting_visit_id(title, start_at)").eq("workspace_id", ws).eq("org_id", s.orgId).limit(100));
    const mn = preps.length ? await q<Row[]>(ctx.db.from("meeting_note").select("id, prep_id, kind, text, created_at").eq("workspace_id", ws).in("prep_id", preps.map((p) => p.id)).is("archived_at", null).limit(300)) : [];
    for (const n of mn) {
      const p = preps.find((x) => x.id === n.prep_id);
      notes.push({ id: n.id, at: p?.meeting?.start_at ?? n.created_at, title: `${p?.meeting?.title ?? "Meeting"} — ${n.kind ?? "note"}`, text: n.text ?? "", commitments: [], objections: [],
        source: { type: "meeting_note", id: n.id, label: `Meeting note ${String(p?.meeting?.start_at ?? n.created_at).slice(0, 10)}`, href: `/meetings/${n.prep_id}` } });
    }
  }
  const c = consolidateMeetingNotes(notes);
  const facts = consolidate((await loadObservations(ctx, s)));
  let summary: { text: string; aiGenerated: boolean; source: "code" | "ai"; model: string; mock: boolean } | null = null;
  if (opts.ai && notes.length) {
    const Out = z.object({ summary: z.string().max(1500) });
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const code = () => {
      const latest = c.timeline[c.timeline.length - 1];
      const parts = [`${plural(notes.length, "meeting note")} from ${c.from?.slice(0, 10)} to ${c.to?.slice(0, 10)}.`];
      if (c.commitments.length) parts.push(`${plural(c.commitments.length, "commitment")} recorded${c.commitments[0] ? `, e.g. “${String(c.commitments[0].text).slice(0, 100)}”` : ""}.`);
      if (c.objections.length) parts.push(`${plural(c.objections.length, "objection")} raised${c.objections[0] ? `, e.g. “${String(c.objections[0].text).slice(0, 100)}”` : ""}.`);
      const rec = facts.recurring.filter((i) => i.kind === "preference");
      if (rec.length) parts.push(`Recurring preferences (not confirmed requirements): ${rec.slice(0, 3).map((i) => String((i as Row).text ?? (i as Row).value ?? (i as Row).label ?? "")).filter(Boolean).join("; ") || plural(rec.length, "item")}.`);
      if (latest) parts.push(`Latest: ${latest.title}${latest.excerpt ? ` — ${String(latest.excerpt).slice(0, 140)}` : ""}.`);
      return { summary: parts.join(" ").slice(0, 1500) };
    };
    let meta = { model: "rules", mock: false };
    const pol = await runWithPolicy({ mode: opts.mode ?? await getAiMode(ctx.db, ws, "intelligence.memory"), code, ai: async () => { const r = await callStructured({ workspaceId: ws, workflow: "intelligence.memory_consolidate", tier: "luna", schema: Out, schemaName: "consolidated_history", maxOutputTokens: 600,
      system: "Summarise a commercial-real-estate relationship history from the meeting notes provided as evidence. Use only the evidence; never invent conversations, commitments or preferences; say 'unknown' where the notes are silent; recurring preferences are preferences, not confirmed requirements.",
      input: `Summarise ${notes.length} meeting notes from ${c.from?.slice(0, 10)} to ${c.to?.slice(0, 10)} in at most 6 short sentences.`,
      evidence: c.timeline.map((t) => `${t.at.slice(0, 10)} ${t.title}: ${t.excerpt}`).join("\n"),
      mock: code }); meta = { model: r.model, mock: r.mocked }; return r.data; } });
    const v = pol.value ?? code();
    summary = pol.source === "ai" ? { text: v.summary, aiGenerated: true, source: "ai", model: meta.model, mock: meta.mock } : { text: v.summary, aiGenerated: false, source: "code", model: "rules", mock: false };
  }
  return { ...c, recurringPreferences: facts.recurring.filter((i) => i.kind === "preference"), repeatedObjections: facts.items.filter((i) => i.kind === "objection" && i.recurring), conflicts: facts.conflicts, summary,
    sources: notes.map((n) => n.source) as SourceRef[] };
}
