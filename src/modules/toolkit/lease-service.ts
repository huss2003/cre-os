import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { saveAnalysis, getAnalysis } from "./store";
import { compareLeaseOffers, leaseEconomics, occupancyEconomics, occupancySensitivity, LEASE_FORMULA, OCC_FORMULA, validateTerms, type Extras, type LeaseTerms, type SensitivityOverrides } from "./calc/lease";
import { analyseNegotiation, appendOffer, NEGO_FORMULA, type ConcessionPackage, type OfferTerms, type OfferVersion, type NegotiationAnalysis } from "./calc/negotiation";

/**
 * Module 8 lease / occupancy / negotiation services. All numbers come from the pure calculators (which run the
 * fin-1.0 engine); every run is saved immutably through saveAnalysis. Nothing is accepted, rejected or sent.
 */
type Row = Record<string, any>;
export interface Who { db: Db; ws: string; userId: string }

const missingOf = (terms: LeaseTerms[], gaps: string[]) => [...new Set([...terms.flatMap(validateTerms), ...gaps])];

export async function runLeaseEconomics(w: Who, s: { id?: string | null; title: string; requirementId?: string | null; offers: LeaseTerms[]; note?: string | null }) {
  if (!s.offers.length) throw new Error("Enter at least one offer (area, rent and dates).");
  const outputs = s.offers.length > 1
    ? { mode: "compare" as const, comparison: compareLeaseOffers(s.offers) }
    : { mode: "single" as const, result: leaseEconomics(s.offers[0]) };
  const gaps = outputs.mode === "compare" ? outputs.comparison.offers.flatMap((o) => o.gaps.map((g) => `${o.name}: ${g}`)) : outputs.result.gaps;
  return saveAnalysis(w.db, w.ws, w.userId, {
    id: s.id, kind: "lease_economics", title: s.title, requirementId: s.requirementId ?? null,
    inputs: { offers: s.offers }, outputs, formulaVersion: LEASE_FORMULA, missing: missingOf(s.offers, gaps), note: s.note ?? null,
  });
}

export async function runOccupancy(w: Who, s: { id?: string | null; title: string; requirementId?: string | null; terms: LeaseTerms; extras: Extras; overrides?: SensitivityOverrides | null }) {
  const result = occupancyEconomics({ terms: s.terms, extras: s.extras });
  const hasOverride = s.overrides && Object.values(s.overrides).some((v) => v !== null && v !== undefined && v !== "");
  const sensitivity = hasOverride ? occupancySensitivity({ terms: s.terms, extras: s.extras }, s.overrides!) : null;
  return saveAnalysis(w.db, w.ws, w.userId, {
    id: s.id, kind: "occupancy", title: s.title, requirementId: s.requirementId ?? null,
    inputs: { terms: s.terms, extras: s.extras, overrides: hasOverride ? s.overrides : null }, outputs: { result, sensitivity },
    formulaVersion: OCC_FORMULA, missing: missingOf([s.terms], [...result.gaps, ...result.cashFunding.filter((c) => c.amount === null).map((c) => c.label)]),
  });
}

export interface NegotiationInputs { versions: OfferVersion[]; packages: ConcessionPackage[] }

async function saveNego(w: Who, id: string | null, title: string, requirementId: string | null, inputs: NegotiationInputs, note: string) {
  const analysis = analyseNegotiation(inputs.versions, inputs.packages);
  return saveAnalysis(w.db, w.ws, w.userId, {
    id, kind: "negotiation", title, requirementId, inputs, outputs: analysis, formulaVersion: NEGO_FORMULA,
    missing: analysis.strategy.unresolved.length ? analysis.strategy.unresolved.map((u) => `unresolved: ${u}`) : [], note,
  });
}

export async function loadNegotiation(w: Who, id: string) {
  const a = (await getAnalysis(w.db, w.ws, id)) as Row | null;
  if (!a || a.kind !== "negotiation") return null;
  return a as Row & { inputs: NegotiationInputs; outputs: NegotiationAnalysis };
}

export async function createNegotiation(w: Who, s: { title: string; requirementId?: string | null; terms: OfferTerms }) {
  const versions = appendOffer([], s.terms, new Date().toISOString());
  return saveNego(w, null, s.title, s.requirementId ?? null, { versions, packages: [] }, "Offer 1");
}

/** Append a new offer version — earlier offers are kept exactly as they were (and earlier analysis versions too). */
export async function addOffer(w: Who, id: string, terms: OfferTerms, note?: string | null) {
  const a = await loadNegotiation(w, id);
  if (!a) throw new Error("Negotiation not found.");
  const versions = appendOffer(a.inputs.versions ?? [], terms, new Date().toISOString(), note);
  return saveNego(w, id, a.title, a.requirement_id ?? null, { versions, packages: a.inputs.packages ?? [] }, `Added ${versions[versions.length - 1].label}`);
}

export async function setPackages(w: Who, id: string, packages: ConcessionPackage[]) {
  const a = await loadNegotiation(w, id);
  if (!a) throw new Error("Negotiation not found.");
  return saveNego(w, id, a.title, a.requirement_id ?? null, { versions: a.inputs.versions, packages }, "Updated concession packages");
}

const Talking = z.object({ points: z.array(z.string()).max(8) });

/** Optional wording help: AI phrases the deterministic strategy (never computes numbers, never decides). */
export async function draftTalkingPoints(w: Who, id: string): Promise<{ points: string[]; mocked: boolean }> {
  const a = await loadNegotiation(w, id);
  if (!a) throw new Error("Negotiation not found.");
  const st = a.outputs.strategy;
  const mock = () => ({
    points: [
      `Ask for: ${st.preferredOutcome}`,
      ...(st.acceptableAlternative ? [`Fallback: ${st.acceptableAlternative}`] : []),
      ...st.unresolved.slice(0, 3).map((u) => `Still to agree: ${u}`),
      ...st.risks.slice(0, 2).map((r) => `Watch: ${r}`),
    ],
  });
  const r = await callStructured({
    workspaceId: w.ws, workflow: "toolkit.negotiation_points", system:
      "You turn a deterministic negotiation summary into short talking points for a commercial-real-estate adviser. Use only the numbers given; do not calculate, invent or recommend accepting/rejecting.",
    input: "Rephrase as up to 6 concise talking points.", evidence: JSON.stringify(st), schema: Talking, schemaName: "talking_points", mock,
  });
  return { points: r.data.points, mocked: r.mocked };
}
