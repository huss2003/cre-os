import { z } from "zod";
import { answerLeaseQuestion } from "@/modules/leases/assist";
import { transactionTools } from "@/modules/transactions/assistant-tools";
import { commandView } from "@/modules/transactions/command";
import { listTransactions } from "@/modules/transactions/service";
import { findAlternatives, matchRequirement } from "@/modules/deals/supply/service";
import { introPathsForOrg } from "@/modules/intelligence/network/service";
import { defineTool, failed, isUuid, today, ws, db, missingBlock, type Row } from "./shared";
import type { ToolContext } from "../types";

/**
 * Cross-module tools wired in by the integration pass: Module 15 (leases), Module 16 (transactions), Module 14 (supply)
 * and network intro paths. All category A (read-only). Each wraps the owning module's exported service — no logic here.
 */
const tx = (t: ToolContext) => ({ db: t.ctx.db as never, workspaceId: t.ctx.workspaceId, userId: t.ctx.userId });

const leaseQuestion = defineTool({
  id: "lease_question", module: "database", category: "A",
  description: "Answer a lease-lifecycle question (Module 15) from recorded lease dates: expiries, notice deadlines, lock-ins, escalations, renewal options, obligations. Each date carries its source clause/page and verification status (confirmed vs not yet verified).",
  input: z.object({ question: z.string().min(3).max(500), leaseId: z.string().optional(), companyId: z.string().optional().describe("Tenant company — answers about that company's lease(s)") }),
  async run(i, t) {
    try {
      const r = await answerLeaseQuestion({ db: t.ctx.db as never, ws: ws(t), userId: t.ctx.userId }, i.question, today(), { leaseId: i.leaseId && isUuid(i.leaseId) ? i.leaseId : undefined, orgId: i.companyId && isUuid(i.companyId) ? i.companyId : undefined });
      return { ok: true, summary: r.answer, data: r };
    } catch (e) { return failed("lease lookup failed", e); }
  },
});

const blockers = defineTool({
  id: "transaction_blockers", module: "toolkit", category: "A",
  description: "What is blocking each active transaction (Module 16): blocking/overdue issues, pending approvals and the next actions — from transaction records only.",
  input: z.object({ limit: z.number().int().min(1).max(25).optional() }),
  async run(i, t) {
    try {
      const rows = (await listTransactions(tx(t), { status: "active" })).slice(0, i.limit ?? 10);
      const items = [];
      for (const r of rows) {
        const v = await commandView(tx(t), r.id);
        items.push({ id: r.id, code: r.code, name: r.name, stage: r.current_stage, blocking: v.blockingNow, pendingApprovals: v.pendingApprovals.length, nextActions: v.nextActions.slice(0, 3).map((a) => a.what), href: `/transactions/${r.id}` });
      }
      const blocked = items.filter((x) => x.blocking.length).length;
      return { ok: true, summary: items.length ? `${items.length} active transaction(s), ${blocked} with recorded blockers.` : "No active transactions recorded.", data: { items },
        blocks: items.length ? [{ kind: "table" as const, title: "Active transactions — what is blocking them", columns: ["Transaction", "Stage", "Blocking now", "Approvals pending", "Next actions"],
          rows: items.map((x) => [`${x.code}${x.name ? ` — ${x.name}` : ""}`, String(x.stage ?? "unknown").replace(/_/g, " "), x.blocking.length ? x.blocking.join("; ") : "Nothing recorded as blocking", x.pendingApprovals, x.nextActions.length ? x.nextActions.join("; ") : "No next action recorded"]),
          note: "From transaction records only (issues, approvals, next actions)." }] : [{ kind: "text" as const, markdown: "No active transactions recorded. Start one from a deal when negotiation begins." }] };
    } catch (e) { return failed("transaction lookup failed", e); }
  },
});

const ELIG: Record<string, string> = { eligible: "Fits", needs_verification: "Check first", ineligible: "Does not fit" };
type SupplyRow = Awaited<ReturnType<typeof matchRequirement>>[number];
/** Options as a table with the reasons behind each (hard-filter failures stay visible, listed last). */
function optionBlocks(r: SupplyRow[], title: string) {
  if (!r.length) return [{ kind: "text" as const, markdown: "No recorded space matched. This covers only spaces recorded in CRE OS — it is not a complete market list." }];
  return [{ kind: "table" as const, title, columns: ["#", "Space", "Result", "Availability", "Why", "To check"],
    rows: r.map((x) => [x.rank, x.label, ELIG[x.eligibility] ?? x.eligibility, String(x.supplyStatus.status).replace(/_/g, " "),
      x.eligibility === "ineligible" ? (x.explanation.fails.join("; ") || x.disqualifiers.join("; ")) : x.explanation.why, x.verificationNeeded.join("; ") || "—"]),
    note: "From recorded supply only; availability that is not confirmed is marked for checking." }, ...missingBlock([])];
}

const supplyMatch = defineTool({
  id: "match_requirement_supply", module: "database", category: "A",
  description: "Match a requirement against property supply (Module 14). Hard-filter failures stay listed last with reasons; unknown availability is flagged for verification.",
  input: z.object({ requirementId: z.string(), limit: z.number().int().min(1).max(25).optional() }),
  async run(i, t) {
    if (!isUuid(i.requirementId)) return { ok: false, summary: "invalid requirement id", error: "invalid id" };
    try {
      const r = (await matchRequirement(tx(t), i.requirementId)).slice(0, i.limit ?? 10);
      return { ok: true, summary: `${r.filter((x) => x.eligibility === "eligible").length} eligible of ${r.length} option(s).`, data: { items: r.map((x) => ({ spaceId: x.spaceId, label: x.label, rank: x.rank, eligibility: x.eligibility, fitScore: x.fitScore, status: x.supplyStatus.status, disqualifiers: x.disqualifiers, verification: x.verificationNeeded, why: x.explanation.why })) },
        blocks: optionBlocks(r, "Options for this requirement") };
    } catch (e) { return failed("supply match failed", e); }
  },
});

const alternatives = defineTool({
  id: "find_alternative_space", module: "database", category: "A",
  description: "Find alternative spaces (Module 14) for an area range in SF, optionally for a requirement. Hard-filter failures listed last.",
  input: z.object({ requirementId: z.string().optional(), minAreaSf: z.number().optional(), maxAreaSf: z.number().optional(), limit: z.number().int().min(1).max(25).optional() }),
  async run(i, t) {
    try {
      const r = await findAlternatives(tx(t), { requirementId: i.requirementId && isUuid(i.requirementId) ? i.requirementId : undefined, areaMinSf: i.minAreaSf ?? null, areaMaxSf: i.maxAreaSf ?? null, limit: i.limit ?? 10 });
      return { ok: true, summary: `${r.length} option(s).`, data: { items: r.map((x) => ({ spaceId: x.spaceId, label: x.label, rank: x.rank, eligibility: x.eligibility, status: x.supplyStatus.status, disqualifiers: x.disqualifiers, why: x.explanation.why })) },
        blocks: optionBlocks(r, "Alternative spaces") };
    } catch (e) { return failed("alternatives lookup failed", e); }
  },
});

const intros = defineTool({
  id: "find_intro_paths", module: "contacts", category: "A",
  description: "Which of your contacts can introduce you to people at a company (warm intro paths, up to two hops). Paths without introducer consent are marked 'ask first'.",
  input: z.object({ companyId: z.string() }),
  async run(i, t) {
    if (!isUuid(i.companyId)) return { ok: false, summary: "invalid company id", error: "invalid id" };
    try {
      const org = (await db(t).from("organisation").select("id").eq("workspace_id", ws(t)).eq("id", i.companyId).maybeSingle()).data as Row | null;
      if (!org) return { ok: false, summary: "company not found", error: "not_found_or_no_access" };
      const paths = await introPathsForOrg(t.ctx.db as never, ws(t), i.companyId, t.ctx.userId);
      const P = paths as Row[];
      return { ok: true, summary: paths.length ? `${paths.length} introduction path(s).` : "No recorded relationship path into this company.", data: { items: paths },
        blocks: P.length ? [{ kind: "table" as const, title: "Introduction paths", columns: ["To", "Path", "Warmth", "Last contact", "Permission"],
          rows: P.map((x) => [x.target_name ?? "Contact", (x.hops ?? []).join(" → ") || "Direct", x.warmth ?? "unknown", x.last_contact ?? "no recorded contact", x.needs_permission ? (x.consent_recorded ? "Introducer agreed" : "Ask the introducer first") : "Not needed"]),
          note: "Paths come from recorded relationships and interactions in CRE OS; nothing is sent." }] : [{ kind: "text" as const, markdown: "No recorded relationship path into this company. Add how you know people there on their contact pages." }] };
    } catch (e) { return failed("intro path lookup failed", e); }
  },
});

export const crossModuleTools = [leaseQuestion, blockers, supplyMatch, alternatives, intros, ...transactionTools];
