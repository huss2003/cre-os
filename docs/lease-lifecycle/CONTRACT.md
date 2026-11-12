# Module 15 ↔ Module 16 contract — `receiveExecutedLease`

Responsibilities (USER-RULES #2): **Module 8** (toolkit) evaluates commercial deals, **Module 16** (transactions)
executes and coordinates them, **Module 15** (leases) monitors the lease after execution. They share the same records
(`mudar.lease`, `mudar.lease_document`, transaction id) and never duplicate each other's logic.

## Function

```ts
import { receiveExecutedLease } from "@/modules/leases/service";

receiveExecutedLease(w: { db: Db; ws: string; userId: string }, transactionId: string, input: ExecutedLeaseInput)
  : Promise<{ leaseId: string; created: boolean; documentId: string | null; dateIds: string[]; status: LeaseStatus; warnings: string[] }>
```

- `w.db` — the caller's RLS client (`ctx.db`). Service-role callers must pass the acting user in `userId`.
- **Idempotent** per `(workspace, transactionId)`: calling twice returns the same `leaseId` (`created: false`), never a
  second lease. A re-call with a *new* executed document adds a document version + new term version (amendment
  history), never overwrites.

```ts
interface ExecutedLeaseInput {
  leaseId?: string | null;              // existing lease being renewed/amended (else matched by transaction id, else created)
  tenantOrgId?: string | null; landlordOrgId?: string | null; assetId?: string | null; spaceId?: string | null;
  tenantNameRaw?: string | null; reference?: string | null; category?: LeaseCategory;  // default "conventional_office"
  floor?: string | null; unit?: string | null; microMarket?: string | null;
  executionDate?: string | null;         // YYYY-MM-DD — required (with an executed document) for status "executed"
  terms?: Partial<CommercialTerms>;      // as negotiated/agreed (unknown = omitted / null; never 0)
  document?: { title: string; docType: DocType; executionState: "executed" | "signed"; text?: string | null;
               pages?: string[] | null; sourceObjectId?: string | null; storagePath?: string | null } | null;
  contactPersonIds?: string[];
}
```

## Guarantees (Module 15 side)
1. Status becomes `executed` **only** if a document with `executionState` `executed`/`signed` *and* an `executionDate`
   are supplied; otherwise the lease stays `awaiting_execution` and a warning explains what is missing.
   Never auto-`active` — activation needs a commencement/possession date that is `confirmed` by a human.
2. Dates/notice conditions in the supplied document text are extracted by deterministic code (AI only as backup via
   `runWithPolicy`, feature `capture.lease_terms`). Each is stored as a `lease_date` row with source clause text,
   document + page, calculation method/convention, calculated date and verification status
   (`extracted | calculated | needs_review | confirmed | conflicting`). None is `confirmed` until a human approves it.
3. Terms from `input.terms` are stored as a `lease_term_version` (source `transaction`), status `proposed`; they become
   current only after human confirmation.
4. Emits orchestrator event `lease.created` (DB trigger) and `lease.executed_received` (dedupe `lease:<id>:tx:<tx>`).
5. Nothing is sent externally (S3).

Module 16 should call this from its "execution completed" step, after its own approval. Module 15 never edits
transaction tables; it only stores `transaction_id` on the lease.
