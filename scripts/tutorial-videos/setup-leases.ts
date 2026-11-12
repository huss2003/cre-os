/**
 * Demo data for the "leases" tutorial videos (Module 15 Lease Lifecycle). Local Supabase + demo workspace ONLY.
 * Everything is synthetic. Re-runnable: earlier tutorial leases (reference TUT-LEASE-*) are archived and rebuilt, so every
 * recording starts from the same state. Built through the lease services (same code the app uses):
 *   - TUT-LEASE-A  Lumen Harbour Tech (demo) @ Kharadi Tech Park (demo): executed lease deed (3 pages) attached → dates,
 *                  obligations and terms extracted with page refs. Commencement + expiry confirmed → Active. Lock-in end,
 *                  escalation, notice and renewal / break dates left for a person to confirm (the video does one).
 *                  One recorded rent payment after the first escalation (expected vs actual check).
 *   - TUT-LEASE-B  Peregrine Loom Studios (demo): active, expires 30 Jun 2027 (renewal pipeline / renew vs relocate).
 *   - TUT-LEASE-C  Quillstone Labs (demo): active, expires 31 Mar 2027 (termination + handover checklist video).
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-leases.ts
 */
import { did, DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER, SYNTHETIC_NOTE } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { userClient } from "../../tests/helpers";
import { addDocument, addFinancialRecord, confirmDate, createLease, getLease, setStatus, type W } from "@/modules/leases/service";

type Row = Record<string, any>;
const id = (kind: string, key: string) => did(`tutorial:leases:${kind}`, key);
export const LEASES = {
  lumen: id("organisation", "lumen"), peregrine: id("organisation", "peregrine"), quill: id("organisation", "quill"), landlord: id("organisation", "landlord"),
};
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const deed = (tenant: string, executed: string, start: string, months: number, end: string, lockin: number) => [
  `LEASE DEED
This Lease Deed is executed on ${executed} at Pune between Harbourline Estates Pvt Ltd (demo) (the Lessor) and ${tenant} (the Lessee).

1. TERM
1.1 The term of the lease shall be ${months} months commencing on ${start} (the Commencement Date).
1.2 The lease shall expire on ${end} unless renewed.`,
  `2. RENT AND DEPOSIT
2.1 The monthly rent of Rs. 12,00,000/- shall be payable on or before the 7th day of each month.
2.2 Common area maintenance (CAM) charges of Rs. 1,50,000/- per month shall be paid separately.
2.3 The Lessee shall pay an interest-free refundable security deposit of Rs. 72,00,000/-.
2.4 The rent shall be escalated by 15% after every 36 months on the last paid rent.

3. LOCK-IN
3.1 The lock-in period shall be ${lockin} months from the Commencement Date.`,
  `4. TERMINATION AND RENEWAL
4.1 After the lock-in period, the Lessee may terminate this lease by giving notice of not less than six (6) months prior to the expiry of the term or such date of termination.
4.2 The Lessee shall have the option to renew the lease for a further term by giving written notice not less than 6 months prior to the expiry of the term.
4.3 Break option: the Lessee may exercise a break option after 60 months subject to payment of the break fee.

5. COVENANTS
5.1 The Lessee shall maintain insurance for its fit-out and contents.
5.2 The Lessor shall carry out structural repairs of the building.
5.3 The Lessee shall not sub-let the premises without consent.
5.4 On expiry the Lessee shall restore the premises to their original bare shell condition.`,
];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createAdminClient();
  // lease actions run as the owner (RLS user client), exactly like the app; admin only for fixtures + archiving
  const w: W = { db: (await userClient("owner")) as never, ws: WS, userId: OWNER };
  const base = (cls = "corporate_confidential") => ({ workspace_id: WS, owner_user_id: OWNER, classification: cls });
  const note = `Tutorial demo record (leases). ${SYNTHETIC_NOTE}`;
  const once = async (table: string, rows: Row[]) => { for (const row of rows) { const { error } = await db.from(table).upsert(row, { onConflict: "id", ignoreDuplicates: true }); if (error) throw new Error(`${table}: ${error.message}`); } };

  await once("organisation", [
    { ...base(), id: LEASES.lumen, display_name: "Lumen Harbour Tech (demo)", legal_name: "Lumen Harbour Tech Pvt Ltd (demo)", notes: note },
    { ...base(), id: LEASES.peregrine, display_name: "Peregrine Loom Studios (demo)", legal_name: "Peregrine Loom Studios Pvt Ltd (demo)", notes: note },
    { ...base(), id: LEASES.quill, display_name: "Quillstone Labs (demo)", legal_name: "Quillstone Labs Pvt Ltd (demo)", notes: note },
    { ...base(), id: LEASES.landlord, display_name: "Harbourline Estates (demo)", legal_name: "Harbourline Estates Pvt Ltd (demo)", notes: note },
  ].map(({ notes, ...r }) => r));
  const asset = (await db.from("asset").select("id").eq("workspace_id", WS).eq("name", "Kharadi Tech Park (demo)").limit(1)).data?.[0]?.id ?? null;
  const asset2 = (await db.from("asset").select("id").eq("workspace_id", WS).eq("name", "Hinjewadi Phase 2 Business Centre (demo)").limit(1)).data?.[0]?.id ?? null;

  // archive earlier tutorial leases (and their dates/events) so videos start fresh
  const old = ((await db.from("lease").select("id").eq("workspace_id", WS).like("reference", "TUT-LEASE-%").is("archived_at", null)).data ?? []) as Row[];
  if (old.length) {
    const now = new Date().toISOString(), ids = old.map((r) => r.id);
    await db.from("lease_event").update({ archived_at: now }).eq("workspace_id", WS).in("lease_id", ids);
    await db.from("lease_date").update({ archived_at: now }).eq("workspace_id", WS).in("lease_id", ids);
    await db.from("lease_reminder").update({ status: "cancelled" }).eq("workspace_id", WS).in("lease_id", ids);
    await db.from("task").update({ archived_at: now }).eq("workspace_id", WS).eq("linked_entity_type", "lease").in("linked_entity_id", ids);
    const { error } = await db.from("lease").update({ archived_at: now }).eq("workspace_id", WS).in("id", ids);
    if (error) throw new Error(`archive leases: ${error.message}`);
  }

  async function build(ref: string, org: string, tenant: string, assetId: string | null, mm: string, executed: string, execIso: string, start: string, months: number, end: string, lockin: number, confirm: string[]) {
    const l = await createLease(w, { tenantOrgId: org, landlordOrgId: LEASES.landlord, assetId, reference: ref, status: "awaiting_execution", microMarket: mm, floor: "5", unit: "501",
      terms: { monthlyRent: 1200000, chargeableArea: 20000, areaBasis: "chargeable", camMonthly: 150000, securityDeposit: 7200000 } });
    const r = await addDocument(w, l.id, { title: "Lease deed (executed)", docType: "lease_agreement", executionState: "executed", pages: deed(tenant, executed, start, months, end, lockin) });
    for (const t of confirm) {
      const d = (await getLease(w, l.id))!; // re-read: confirming commencement recalculates (supersedes) dependent dates
      const x = d.dates.find((y: Row) => y.date_type === t && !y.superseded_by && !y.archived_at && y.verification_status !== "confirmed");
      if (x) await confirmDate(w, x.id, { date: x.calculated_date, note: "Checked against the signed deed (tutorial setup)", today: TODAY });
    }
    await setStatus(w, l.id, "executed", { documentId: r.document.id, executionDate: execIso, today: TODAY, note: "Signed deed attached" });
    await setStatus(w, l.id, "active", { today: TODAY, note: "Commencement confirmed" });
    return l.id as string;
  }
  const a = await build("TUT-LEASE-A", LEASES.lumen, "Lumen Harbour Tech Pvt Ltd (demo)", asset, "Kharadi", "15th December 2023", "2023-12-15", "1st January 2024", 108, "31st December 2032", 36, ["commencement", "expiry", "execution"]);
  await addFinancialRecord(w, a, { kind: "actual_rent_after_escalation", amount: 1380000, onDate: "2027-01-07", period: "2027-01", note: "Invoice after first escalation (tutorial)", source: "user_verified" }).catch((e) => console.warn("payment:", e.message));
  const b = await build("TUT-LEASE-B", LEASES.peregrine, "Peregrine Loom Studios Pvt Ltd (demo)", asset2, "Hinjewadi", "10th June 2022", "2022-06-10", "1st July 2022", 60, "30th June 2027", 36, ["commencement", "expiry", "execution", "renewal_notice_deadline", "termination_notice_deadline"]);
  const c = await build("TUT-LEASE-C", LEASES.quill, "Quillstone Labs Pvt Ltd (demo)", asset, "Kharadi", "20th March 2022", "2022-03-20", "1st April 2022", 60, "31st March 2027", 36, ["commencement", "expiry", "execution"]);
  console.log("LEASES", JSON.stringify({ a, b, c }));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
