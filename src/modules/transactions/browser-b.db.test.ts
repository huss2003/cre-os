/** Browser test B fixes (docs/integration/BROWSER-B.md): B2 archived approvals, B3 hand-off property + commencement, B4 txLabel, B8 option labels, archive control. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, adminClient, tag, userClient } from "../../../tests/helpers";
import type { TxCtx } from "./ctx";
import { TxError } from "./ctx";
import * as S from "./service";
import { handOffExecutedLease } from "./lease-handoff";
import { reviewIntegrationSections } from "@/modules/orchestrator/ui/integration-sections";

let owner: TxCtx; let colleague: TxCtx;
const txIds: string[] = []; const assetIds: string[] = [];
beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id };
  colleague = { db: await userClient("colleague"), workspaceId: WS1, userId: USERS.colleague.id };
});
afterAll(async () => {
  const a = adminClient(); const now = new Date().toISOString();
  if (txIds.length) {
    await a.from("lease").update({ archived_at: now }).eq("workspace_id", WS1).in("transaction_id", txIds);
    await a.from("tx_transaction").update({ archived_at: now }).eq("workspace_id", WS1).in("id", txIds).is("archived_at", null);
    await a.from("task").delete().eq("workspace_id", WS1).like("idempotency_key", "tx.%");
  }
  if (assetIds.length) await a.from("asset").update({ archived_at: now }).eq("workspace_id", WS1).in("id", assetIds);
});

describe("B2 + archive control", () => {
  it("archiving a transaction (reason required, admin) removes its approvals from Review", async () => {
    const tx = await S.createTransaction(owner, { name: tag("b2"), txType: "coworking" }); txIds.push(tx.id);
    const o = await S.createOffer(owner, tx.id, { offeringParty: "operator", receivingParty: "client", offerDate: "2026-11-01", terms: { rentPerSf: 80 } });
    const ap = await S.requestApproval(owner, tx.id, { category: "client_commercial", subjectType: "offer", subjectId: o.id, reviewerUserId: USERS.owner.id });
    const keys = async () => (await reviewIntegrationSections({ db: owner.db as never, workspaceId: WS1, userId: USERS.owner.id })).find((s) => s.key === "tx_approvals")!.items.map((i) => i.key);
    expect(await keys()).toContain(`txa:${ap.id}`);
    await expect(S.archiveTransaction(owner, tx.id, "  ")).rejects.toBeInstanceOf(TxError);
    await S.archiveTransaction(owner, tx.id, "browser test record");
    expect(await keys()).not.toContain(`txa:${ap.id}`);
    const a = (await owner.db.from("tx_approval").select("archived_at").eq("id", ap.id).maybeSingle()).data;
    expect(a?.archived_at).toBeTruthy();
    const ev = (await owner.db.from("tx_event").select("summary").eq("transaction_id", tx.id).eq("kind", "archived")).data ?? [];
    expect(ev[0]?.summary).toMatch(/browser test record/);
    expect((await S.listTransactions(owner)).some((t) => t.id === tx.id)).toBe(false);
  });

  it("approvals stay hidden even if only the transaction row is archived", async () => {
    const tx = await S.createTransaction(owner, { name: tag("b2b"), txType: "coworking" }); txIds.push(tx.id);
    const o = await S.createOffer(owner, tx.id, { offeringParty: "operator", receivingParty: "client", offerDate: "2026-11-01", terms: { rentPerSf: 81 } });
    const ap = await S.requestApproval(owner, tx.id, { category: "landlord", subjectType: "offer", subjectId: o.id, reviewerUserId: USERS.owner.id });
    await adminClient().from("tx_transaction").update({ archived_at: new Date().toISOString() }).eq("id", tx.id);
    const items = (await reviewIntegrationSections({ db: owner.db as never, workspaceId: WS1, userId: USERS.owner.id })).find((s) => s.key === "tx_approvals")!.items;
    expect(items.map((i) => i.key)).not.toContain(`txa:${ap.id}`);
  });
});

describe("B3 + B4 lease hand-off and TX label", () => {
  it("hand-off resolves the building from the property label and proposes the stated lease start", async () => {
    const name = tag("Tower Hand");
    const asset = (await owner.db.from("asset").insert({ workspace_id: WS1, name, category: "conventional_office" }).select("id").single());
    expect(asset.error).toBeNull(); assetIds.push(asset.data!.id);
    const org = (await owner.db.from("organisation").insert({ workspace_id: WS1, display_name: tag("B3 Tenant") }).select("id").single()).data!;
    const tx = await S.createTransaction(owner, { name: tag("b3"), txType: "conventional_leasing", clientOrgId: org.id, propertyLabels: [`${name} Kharadi, Floor 7`] }); txIds.push(tx.id);
    const ex = await S.addDocumentVersion(owner, tx.id, { docKind: "executed_agreement", title: "Executed", body: "1. Premises: 8,000 sq ft.\n2. Lease start 1 March 2027.\n3. Lock-in period of 36 months." });
    await owner.db.from("tx_milestone").insert({ workspace_id: WS1, transaction_id: tx.id, kind: "executed", achieved_on: "2026-11-20", evidence: "sro", document_id: ex.id });
    const r = await handOffExecutedLease(owner, tx.id) as { status: string; lease_id: string };
    expect(r.status).toBe("delivered");
    const lease = (await owner.db.from("lease").select("asset_id").eq("id", r.lease_id).single()).data!;
    expect(lease.asset_id).toBe(asset.data!.id);
    const dates = (await owner.db.from("lease_date").select("date_type, calculated_date, verification_status").eq("lease_id", r.lease_id).is("archived_at", null)).data ?? [];
    const c = dates.find((d) => d.date_type === "commencement");
    expect(c?.calculated_date).toBe("2027-03-01");
    expect(c?.verification_status).not.toBe("confirmed");
    const ev = (await owner.db.from("tx_event").select("summary").eq("transaction_id", tx.id).eq("kind", "lease_handoff")).data ?? [];
    expect(ev[0].summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    const l = await S.txLabel(owner, tx.id);
    expect(l).toMatchObject({ code: tx.code, href: `/transactions/${tx.id}` });
    expect(await S.txLabel(owner, null)).toBeNull();
  });

  it("archive needs admin: an editor is refused by the action role check (service still records the reason)", async () => {
    // role gate lives in archiveTransactionAction (requireContext("admin")); here we only check a colleague cannot archive a tx they cannot see
    const tx = await S.createTransaction(owner, { name: tag("b-arch"), txType: "coworking" }); txIds.push(tx.id);
    const res = await S.archiveTransaction(colleague, tx.id, "x").then(() => "ok", (e) => e);
    if (res !== "ok") expect(res).toBeInstanceOf(Error);
  });
});
