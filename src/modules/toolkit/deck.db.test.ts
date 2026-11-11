/** Integration: BTS + investment saved as versioned analyses; deck stored as document_version (RLS as owner) and re-downloadable. */
import { describe, it, expect, beforeAll } from "vitest";
import { USERS, WS1, tag, userClient } from "../../../tests/helpers";
import type { Db } from "@/lib/supabase/server";
import { runBts, runInvestment } from "./models-service";
import { downloadDeck, generateDeck, listDecks } from "./deck";

let db: Db;
beforeAll(async () => { db = await userClient("owner"); });

describe("specialist models + deck (db)", () => {
  it("saves BTS with versions, generates a linked deck document version, downloads it with hash check", async () => {
    const inp = { land: { mode: "purchase" as const, cost: 1e7 }, areaSf: 1e5, areaBasis: "built_up" as const, constructionCostPerSf: 3000, softCostPct: 10, constructionMonths: 12, mode: "yield" as const, yieldOnCostPct: 9, leaseTermMonths: 24, escalationPct: 5, escalationEveryMonths: 12, rentFreeMonths: 2, depositMonths: 6, tenantFitout: 5e6, discountRatePct: 10 };
    const s1 = await runBts(db, WS1, USERS.owner.id, { title: tag("BTS") }, inp);
    const s2 = await runBts(db, WS1, USERS.owner.id, { id: s1.id, title: tag("BTS") }, { ...inp, tenantFitout: null });
    expect(s2.version).toBe(2);
    expect(s2.outputs.missing.length).toBeGreaterThan(0);
    const d1 = await generateDeck(db, WS1, USERS.owner.id, s1.id, 1);
    const d2 = await generateDeck(db, WS1, USERS.owner.id, s1.id);
    expect(d2.versionNo).toBe(d1.versionNo + 1);
    const decks = await listDecks(db, WS1, s1.id);
    expect(decks[0].input_versions).toMatchObject({ analysis_id: s1.id, analysis_version: 2, kind: "bts" });
    const f = await downloadDeck(db, WS1, d1.documentId);
    expect(f.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    const other = await userClient("other");
    await expect(downloadDeck(other, WS1, d1.documentId)).rejects.toThrow();
  });
  it("saves an investment analysis", async () => {
    const r = await runInvestment(db, WS1, USERS.owner.id, { title: tag("Inv") }, { purchasePrice: 1.2e6, stampDutyPct: 0, otherAcquisitionCosts: 0, leasableAreaSf: 1000, areaBasis: "leasable", tenancies: [{ name: "A", areaSf: 1000, rentPerSfMonth: 10, escalationPct: 0, escalationEveryMonths: 12, expiryMonth: 120, downtimeMonths: 0, reletRentPerSfMonth: 10, camRecoveryPerSfMonth: 0 }], opexPerSfMonth: 0, opexEscalationPct: 0, capexReservePerSfYear: 0, holdingYears: 5, exitCapRatePct: 10, saleCostsPct: 0, discountRatePct: 10 });
    expect(r.outputs.unlevered.irrPct).toBe("10.0000");
    const d = await generateDeck(db, WS1, USERS.owner.id, r.id);
    expect(d.bytes).toBeGreaterThan(10000);
  });
});
