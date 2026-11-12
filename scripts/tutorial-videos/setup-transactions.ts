/**
 * Demo data for the "transactions" tutorial videos (Module 16). Local Supabase + demo workspace ONLY. Synthetic.
 * Re-runnable: tutorial transactions (name ends with "(tutorial)") are archived and the demo one is rebuilt through the
 * transaction services (signed in as the demo owner, RLS on), so every recording starts from the same mid-negotiation state:
 *   "Lumen Harbour Tech — Kharadi 20k SF (tutorial)", conventional leasing, linked to Kharadi Tech Park (demo):
 *   - offers v1 (landlord) → v2 (client counter, reason) → v3 (landlord counter, pending)
 *   - positions: client requirement / adviser recommendation (counterparty comes from offers)
 *   - points: area, lock-in and tenure agreed with evidence; the rest under negotiation
 *   - issues: "CAM increase unexplained" (blocking, overdue) and "Signage rights" (depends on it)
 *   - inspection (MEP walk-through), clarification with a discrepancy (DG 150 kVA asked, 120 kVA offered), OC requested
 *   - stakeholders: landlord leasing rep, legal adviser (the owner, as legal reviewer), client CFO
 *   - LOI v1, agreement v1 → v2 (clause diff; v1 legal approval invalidated → reassessment pending for the owner)
 *   - security deposit recorded (approved, due)
 *   - executed agreement text saved (for the execution video)
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-transactions.ts
 */
import { DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { userClient } from "../../tests/helpers";
import * as S from "@/modules/transactions/service";
import type { TxCtx } from "@/modules/transactions/ctx";

const NAME = "Lumen Harbour Tech — Kharadi 20k SF (tutorial)";
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const admin = createAdminClient();
  const c: TxCtx = { db: await userClient("owner"), workspaceId: WS, userId: OWNER };

  // archive earlier tutorial transactions (videos create / change them)
  const old = ((await admin.from("tx_transaction").select("id").eq("workspace_id", WS).like("name", "%(tutorial)").is("archived_at", null)).data ?? []) as { id: string }[];
  if (old.length) {
    const now = new Date().toISOString();
    await admin.from("task").update({ archived_at: now }).eq("workspace_id", WS).like("idempotency_key", "tx.%").in("linked_entity_id", old.map((o) => o.id));
    const { error } = await admin.from("tx_transaction").update({ archived_at: now }).eq("workspace_id", WS).in("id", old.map((o) => o.id));
    if (error) throw new Error(`archive: ${error.message}`);
  }
  const asset = (await admin.from("asset").select("id").eq("workspace_id", WS).eq("name", "Kharadi Tech Park (demo)").limit(1)).data?.[0]?.id as string | undefined;
  const org = (await admin.from("organisation").select("id").eq("workspace_id", WS).eq("display_name", "Lumen Harbour Tech (demo)").limit(1)).data?.[0]?.id as string | undefined;

  const tx = await S.createTransaction(c, { name: NAME, txType: "conventional_leasing", clientOrgId: org ?? null, propertyLabels: ["Kharadi Tech Park (demo) — Floor 6"],
    priority: "high", expectedCompletion: addDays(TODAY, 75) });
  for (const k of ["requirement_confirmation", "property_identification"]) await S.advanceStage(c, tx.id, k, "done").catch(() => null);

  const base = { areaSf: 20000, areaBasis: "chargeable", rentPerSf: 100, camPerSf: 15, rentFreeMonths: 3, depositMonths: 6, lockInMonths: 36, tenureMonths: 60, escalationPct: 15, escalationEveryMonths: 36 };
  const o1 = await S.createOffer(c, tx.id, { offeringParty: "landlord", receivingParty: "client", offerDate: addDays(TODAY, -12), validUntil: addDays(TODAY, -2), terms: base, sourceDocument: "Landlord proposal email" });
  const o2 = await S.createOffer(c, tx.id, { parentOfferId: o1.id, offeringParty: "client", receivingParty: "landlord", offerDate: addDays(TODAY, -9), reason: "Client budget ceiling ₹92/SF", terms: { ...base, rentPerSf: 90, depositMonths: 4 } });
  await S.createOffer(c, tx.id, { parentOfferId: o2.id, offeringParty: "landlord", receivingParty: "client", offerDate: addDays(TODAY, -5), validUntil: addDays(TODAY, 4), reason: "Meet halfway; CAM revised",
    terms: { ...base, rentPerSf: 95, camPerSf: 20, rentFreeMonths: 2, depositMonths: 5 } });

  await S.addPosition(c, tx.id, { kind: "client_requirement", termKey: "rentPerSf", value: "92", source: "Client email — budget ceiling (confirmed by CFO)" });
  await S.addPosition(c, tx.id, { kind: "client_requirement", termKey: "depositMonths", value: "4", source: "Client email — treasury policy" });
  await S.addPosition(c, tx.id, { kind: "adviser_recommendation", termKey: "rentPerSf", value: "94", source: "Adviser view after Kharadi comparables" });

  const pts = await S.listPoints(c, tx.id);
  for (const k of ["areaSf", "lockInMonths", "tenureMonths"]) { const p = pts.find((x: { term_key: string }) => x.term_key === k); if (p) await S.setPointStatus(c, p.id, "agreed", { evidence: "Call with landlord, confirmed by email" }); }

  const rep = await S.addStakeholder(c, tx.id, { name: "Rohan Mehta (demo)", category: "leasing_representative", organisation: "Harbourline Estates (demo)", decisionAuthority: "recommender" });
  const legal = await S.addStakeholder(c, tx.id, { name: "You (legal review)", category: "legal_adviser", userId: OWNER, decisionAuthority: "approver", isInternal: true });
  await S.addStakeholder(c, tx.id, { name: "Neha Iyer (demo)", category: "client_finance", organisation: "Lumen Harbour Tech (demo)", designation: "CFO", decisionAuthority: "approver" });
  await S.assignStakeholderTask(c, tx.id, rep.id, { title: "Send CAM breakup", dueDate: addDays(TODAY, 3) });

  const i1 = await S.createIssue(c, tx.id, { title: "CAM increase unexplained", category: "commercial", stakeholderId: rep.id, ownerUserId: OWNER, nextAction: "Ask landlord for CAM breakup",
    dueDate: addDays(TODAY, -2), blocking: true, priority: "high", decisionRequired: "Accept ₹20 CAM or push back" });
  await S.createIssue(c, tx.id, { title: "Signage rights", category: "legal", ownerUserId: OWNER, nextAction: "Raise in LOI", noDueReason: "Depends on the CAM discussion", dependsOn: [i1.id] });

  await S.recordInspection(c, tx.id, { date: addDays(TODAY, -6), type: "MEP walk-through", participants: ["Client facilities", "Landlord PM"], findings: "DG at 60% load; chillers serviced", outstandingConcerns: "Fire NOC copy pending" });
  const cl = await S.requestClarification(c, tx.id, { topic: "power_backup", question: "DG backup kVA for floor 6?", requiredValue: "150 kVA", requiredNumeric: 150, responsibleParty: "landlord" });
  await S.respondClarification(c, cl.id, { response: "120 kVA", responseNumeric: 120 });
  await S.requestClarification(c, tx.id, { topic: "parking", question: "How many car parks are included?", requiredValue: "40", requiredNumeric: 40, responsibleParty: "landlord" }).catch(() => null);
  await S.requestDocument(c, tx.id, { docType: "occupancy", title: "Occupancy certificate", responsibleParty: "landlord", dueDate: addDays(TODAY, 8) });

  await S.addDocumentVersion(c, tx.id, { docKind: "loi", title: "LOI", body: "1. Premises: 20,000 sq ft chargeable on Floor 6.\n2. Rent: base rent of ₹ 95 per sq ft per month.\n3. Security deposit of 5 months.\n4. Lock-in of 36 months." });
  const ag1 = await S.addDocumentVersion(c, tx.id, { docKind: "agreement", title: "Leave & licence", body: "1. Premises: 20,000 sq ft.\n2. Rent: base rent of ₹ 95 per sq ft per month.\n3. Security deposit equal to 5 months.\n4. Lock-in period of 36 months." });
  await S.requestApproval(c, tx.id, { category: "legal", subjectType: "document", subjectId: ag1.id, reviewerUserId: OWNER, reviewerStakeholderId: legal.id, deadline: addDays(TODAY, 6) });
  await S.addDocumentVersion(c, tx.id, { docKind: "agreement", title: "Leave & licence", body: "1. Premises: 20,000 sq ft.\n2. Rent: base rent of ₹ 100 per sq ft per month.\n3. Security deposit equal to 5 months.\n5. Tenant shall bear restoration costs." });

  const dep = await S.recordDeposit(c, tx.id, { depositType: "security deposit", amount: 9500000, responsibleParty: "client finance", refundable: true, refundConditions: "On vacating, less dues" });
  await S.updateDepositStage(c, dep.id, "approved", { date: addDays(TODAY, -1) });
  await S.updateDepositStage(c, dep.id, "due", { date: addDays(TODAY, 5) });
  console.log("TX", tx.id, tx.code);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
