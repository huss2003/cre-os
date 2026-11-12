/** §19 #32 against the real Module 15 receiveExecutedLease (docs/lease-lifecycle/CONTRACT.md). WS1, tagged, mock AI. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, adminClient, tag, userClient } from "../../../tests/helpers";
import type { TxCtx } from "./ctx";
import * as S from "./service";
import { toExecutedLeaseInput, buildExecutedLeasePayload, handOffExecutedLease } from "./lease-handoff";

let owner: TxCtx; let txId = "";
beforeAll(async () => { owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id }; });
afterAll(async () => { if (txId) { const a = adminClient(); await a.from("lease").update({ archived_at: new Date().toISOString() }).eq("workspace_id", WS1).eq("transaction_id", txId); } });

describe("Module 16 → Module 15 hand-off", () => {
  it("executed transaction creates one lease (idempotent) with agreed terms and the executed text", async () => {
    const org = (await owner.db.from("organisation").insert({ workspace_id: WS1, display_name: tag("Tenant Co") }).select("id").single()).data!;
    const tx = await S.createTransaction(owner, { name: tag("handoff"), txType: "conventional_leasing", clientOrgId: org.id }); txId = tx.id;
    await S.createOffer(owner, tx.id, { offeringParty: "landlord", receivingParty: "client", offerDate: "2026-11-01", terms: { areaSf: 12000, areaBasis: "chargeable", rentPerSf: 88, tenureMonths: 108, lockInMonths: 36, camPerSf: 12 } });
    for (const p of await S.listPoints(owner, tx.id)) await S.setPointStatus(owner, p.id, "agreed", { evidence: "LOI signed 2026-11-05" });
    const body = "1. Premises: 12,000 sq ft chargeable.\n2. Rent: base rent of ₹ 88 per sq ft per month.\n3. Term of 108 months commencing 2027-01-01.\n4. Lock-in period of 36 months.\n5. Either party may terminate by giving 6 months written notice.";
    const ex = await S.addDocumentVersion(owner, tx.id, { docKind: "executed_agreement", title: "Executed lease", body });
    const input = toExecutedLeaseInput(await (async () => { await owner.db.from("tx_milestone").insert({ workspace_id: WS1, transaction_id: tx.id, kind: "executed", achieved_on: "2026-11-20", evidence: "sro", document_id: ex.id }); return buildExecutedLeasePayload(owner, tx.id); })(), "conventional_leasing");
    expect(input.terms).toMatchObject({ rentPerSf: 88, chargeableArea: 12000, termMonths: 108, lockinMonths: 36 });
    expect(input.terms.other).toMatch(/CAM ₹\/SF\/month: 12/); // stated, never converted to a monthly amount
    const r1 = await handOffExecutedLease(owner, tx.id);
    expect(r1.status).toBe("delivered");
    const leases = (await owner.db.from("lease").select("id, transaction_id").eq("workspace_id", WS1).eq("transaction_id", tx.id).is("archived_at", null)).data!;
    expect(leases).toHaveLength(1);
    const r2 = await handOffExecutedLease(owner, tx.id);
    expect((r2 as { lease_id: string }).lease_id).toBe(leases[0].id);
  });
});
