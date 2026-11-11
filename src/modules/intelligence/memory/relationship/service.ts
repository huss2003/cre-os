import "server-only";
/** Relationship memory (spec §4): history, evidence-based strength, timeline — derived from interactions/meetings/edges. */
import { commitmentsFrom, interactionsFor, objectionsFrom, q, today, type Commitment, type Objection } from "../data";
import type { MemCtx, Row } from "../types";
import { relationshipStrength, type RelationshipAssessment, type RelationshipEvidence } from "./strength";

export interface RelationshipHistory {
  firstAt: string | null; lastAt: string | null; total: number;
  byChannel: Record<string, number>;
  meetings: Row[]; calls: Row[]; messages: Row[];
  commitmentsPending: Commitment[]; commitmentsDone: Commitment[];
  objections: Objection[];
  levelHistory: Row[];
  interactions: Row[];
}

export async function relationshipHistory(ctx: MemCtx, personId: string, ints?: Row[]): Promise<RelationshipHistory> {
  const all = ints ?? await interactionsFor(ctx, "person", [personId]);
  const asc = [...all].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const byChannel: Record<string, number> = {};
  for (const i of all) byChannel[i.channel ?? "note"] = (byChannel[i.channel ?? "note"] ?? 0) + 1;
  const cm = commitmentsFrom(all);
  const levelHistory = await q(ctx.db.from("contact_relationship_level").select("id, level, reason, basis, set_at").eq("workspace_id", ctx.workspaceId).eq("person_id", personId).is("archived_at", null).order("set_at", { ascending: false }).limit(50));
  return {
    firstAt: asc[0]?.occurred_at ?? null, lastAt: asc.at(-1)?.occurred_at ?? null, total: all.length, byChannel,
    meetings: all.filter((i) => i.channel === "meeting" || i.channel === "visit"),
    calls: all.filter((i) => i.channel === "call"),
    messages: all.filter((i) => ["email", "whatsapp"].includes(i.channel)),
    commitmentsPending: cm.filter((c) => c.pending), commitmentsDone: cm.filter((c) => !c.pending),
    objections: objectionsFrom(all), levelHistory, interactions: all,
  };
}

export async function gatherRelationshipEvidence(ctx: MemCtx, personId: string, ints?: Row[]): Promise<RelationshipEvidence> {
  const all = ints ?? await interactionsFor(ctx, "person", [personId]);
  const ws = ctx.workspaceId;
  const [edges, stake, lvl, mtgs] = await Promise.all([
    q(ctx.db.from("relationship_edge").select("id, from_person_id, to_person_id, edge_type, intro_permission").eq("workspace_id", ws).is("archived_at", null)
      .or(`from_person_id.eq.${personId},to_person_id.eq.${personId}`).limit(200)),
    q(ctx.db.from("stakeholder").select("requirement_id").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null)),
    q(ctx.db.from("contact_relationship_level").select("level, set_at").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).order("set_at", { ascending: false }).limit(1)),
    q(ctx.db.from("meeting_visit").select("id").eq("workspace_id", ws).eq("linked_entity_type", "person").eq("linked_entity_id", personId).is("archived_at", null).limit(200)),
  ]);
  const reqIds = [...new Set(stake.map((s) => s.requirement_id).filter(Boolean))];
  const wins = reqIds.length ? (await q(ctx.db.from("opportunity").select("id").eq("workspace_id", ws).in("requirement_id", reqIds).eq("outcome", "won").is("archived_at", null))).length : 0;
  const asc = [...all].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const cm = commitmentsFrom(all);
  return {
    interactions: all.length, meaningful: all.filter((i) => i.is_meaningful).length,
    firstAt: asc[0]?.occurred_at ?? null, lastAt: asc.at(-1)?.occurred_at ?? null,
    meetings: all.filter((i) => i.channel === "meeting" || i.channel === "visit").length + mtgs.length,
    outbound: all.filter((i) => i.direction === "outbound").length,
    inbound: all.filter((i) => i.direction === "inbound").length,
    voluntaryInfo: all.filter((i) => i.direction === "inbound" && i.is_meaningful).length,
    introductions: edges.filter((e) => (e.from_person_id === personId && e.intro_permission) || e.edge_type === "introduced_by").length,
    wins, commitmentsKept: cm.filter((c) => !c.pending && c.status !== "cancelled").length, commitmentsOverdue: cm.filter((c) => c.overdue).length,
    userLevel: lvl[0]?.level ?? null, today: today(),
  };
}

export async function assessRelationship(ctx: MemCtx, personId: string, ints?: Row[]): Promise<RelationshipAssessment> {
  try { return relationshipStrength(await gatherRelationshipEvidence(ctx, personId, ints)); }
  catch { return relationshipStrength(null); }
}
