import { z } from "zod";
import type { Block, ToolDef } from "../types";
import { defineTool } from "./shared";
import { analyseNotes, NoteError } from "../notes/service";
import { assembleMorningBrief } from "../briefs/morning";

/** Suggested group: "briefs" (morning brief + notes capture). */
export const briefsToolGroup = "briefs";

export const briefsTools: ToolDef[] = [
  defineTool({
    id: "capture_meeting_notes", module: "assistant", category: "B",
    description: "When the user pastes or dictates meeting/call notes and wants the records updated. Extracts requirement changes, people + roles, commitments with due dates, next steps, objections and property feedback, and prepares a review screen. Writes NOTHING to records — the user approves each change on the review screen. Pass the notes verbatim.",
    input: z.object({ notes: z.string().min(3).max(20000), meetingId: z.string().uuid().optional(), companyId: z.string().uuid().optional(), requirementId: z.string().uuid().optional() }),
    timeoutMs: 30_000,
    run: async (i, t) => {
      try {
        const focus = t.focus;
        const { note, duplicate } = await analyseNotes({ db: t.ctx.db, workspaceId: t.ctx.workspaceId, userId: t.ctx.userId, timezone: t.ctx.timezone }, {
          text: i.notes, meetingId: i.meetingId ?? (focus?.type === "meeting" ? focus.id : null),
          orgId: i.companyId ?? (focus?.type === "company" ? focus.id : null), requirementId: i.requirementId ?? (focus?.type === "requirement" ? focus.id : null),
        });
        const blocks: Block[] = [
          { kind: "table", title: "Proposed updates (not saved yet)", columns: ["Record", "Change", "Before", "After"],
            rows: note.proposals.map((p) => [p.group.label, p.label, p.before === null || p.before === undefined ? "—" : String(p.before), String(p.after)]) },
          ...(note.unresolved.length ? [{ kind: "missing" as const, items: note.unresolved }] : []),
          { kind: "download", label: "Review and approve", href: `/assistant/notes?id=${note.id}` },
        ];
        return { ok: true, summary: `${duplicate ? "Same notes already prepared — " : ""}${note.proposals.length} proposed updates ready for review; nothing saved yet.`,
          data: { noteId: note.id, proposals: note.proposals.length, unresolved: note.unresolved.length }, blocks, missing: note.unresolved };
      } catch (e) {
        return { ok: false, summary: e instanceof NoteError ? e.message : "Could not read the notes.", error: (e as Error).message };
      }
    },
  }),
  defineTool({
    id: "morning_brief", module: "assistant", category: "A",
    description: "Today's morning brief for the user: meetings + prep status, follow-ups/commitments due or overdue, new signals on top-scored accounts, leases entering 12/6/3-month windows, approvals waiting, memories to re-check. Deterministic; failed sources are listed.",
    input: z.object({ topN: z.number().int().min(1).max(50).optional() }),
    run: async (i, t) => {
      const b = await assembleMorningBrief({ db: t.ctx.db, workspaceId: t.ctx.workspaceId, userId: t.ctx.userId, timezone: t.ctx.timezone }, new Date(), { topN: i.topN });
      return { ok: true, summary: `${b.title}${b.failed.length ? ` (not checked: ${b.failed.join(", ")})` : ""}`, data: { date: b.date, counts: b.counts, failed: b.failed }, blocks: b.blocks, missing: b.failed.map((f) => `${f} could not be checked`) };
    },
  }),
];
