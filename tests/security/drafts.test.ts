/**
 * Draft approval binding at the DB layer (spec "Approval invalidation": changed recipient/body/attachment rejects
 * old approval). The app service (src/lib/services/drafts.ts) is correct, but draft is an ordinary business table
 * that editors can update directly through PostgREST, so the integrations_draft_guard trigger is the real boundary.
 * Since the M2 fix: content_hash is recomputed/verified in SQL, and approved / opened_for_send / marked_sent are reachable
 * only through the SECURITY DEFINER app.approve_draft / app.open_draft_for_send / app.mark_draft_sent.
 * Rolled-back transactions, acting as the colleague (editor).
 */
import { describe, it, expect } from "vitest";
import { asRole, type Q } from "./pg";
import { USERS, WS1 } from "../helpers";
import { draftHash } from "@/lib/services/drafts";

async function newDraft(db: Q) {
  const d = { recipient_person_id: null, recipient_address: "cfo@example.invalid", subject: "Hello", body: "Original body", attachment_document_ids: [] as string[] };
  const r = await db.q<{ id: string; content_hash: string }>(
    `insert into public.draft(workspace_id, channel, recipient_address, subject, body, content_hash, owner_user_id, classification)
     values ($1,'email',$2,$3,$4,$5,$6,'corporate_confidential') returning id, content_hash`,
    [WS1, d.recipient_address, d.subject, d.body, draftHash(d), USERS.colleague.id]);
  if (r.error) throw r.error;
  return { ...r.rows[0], d };
}

describe("draft approval binding (DB trigger)", () => {
  it("content change without re-hashing is rejected; re-hashed change drops the approval", async () => {
    const out = await asRole("colleague", async (db) => {
      const { id, content_hash, d } = await newDraft(db);
      const appr = await db.q(`select state from app.approve_draft($1)`, [id]);
      const noRehash = await db.q(`update public.draft set body='Changed body' where id=$1`, [id]);
      const newHash = draftHash({ ...d, body: "Changed body" });
      const rehash = await db.q<{ state: string; approved_hash: string | null }>(
        `update public.draft set body='Changed body', content_hash=$2 where id=$1 returning state, approved_hash`, [id, newHash]);
      return { approved: appr.rows[0]?.state, noRehash: noRehash.error?.code ?? "accepted", after: rehash.rows[0], content_hash };
    });
    expect(out.approved).toBe("approved");
    expect(out.noRehash).toBe("22023");
    expect(out.after).toEqual({ state: "drafted", approved_hash: null });
  });

  it("a forged content_hash cannot be used to approve / mark-sent content that was never approved", async () => {
    const out = await asRole("colleague", async (db) => {
      const { id } = await newDraft(db);
      // change the body and set an arbitrary (non-matching) hash, then self-approve and mark sent directly
      const step1 = await db.q(`update public.draft set body='Wire the deposit to account 123', content_hash='forged' where id=$1`, [id]);
      const step2 = await db.q(`update public.draft set state='approved', approved_hash='forged' where id=$1`, [id]);
      const step3 = await db.q<{ state: string }>(`update public.draft set state='marked_sent', marked_sent_at=now(), sent_evidence='user_assertion' where id=$1 returning state`, [id]);
      return { step1: step1.error?.code ?? "accepted", step2: step2.error?.code ?? "accepted", final: step3.rows[0]?.state ?? step3.error?.code };
    });
    // Desired: the DB recomputes/validates content_hash (or approvals only via a definer function), so this chain fails.
    expect(out.final).not.toBe("marked_sent");
  });

  it("drafted -> marked_sent without any approval is rejected", async () => {
    const out = await asRole("colleague", async (db) => {
      const { id } = await newDraft(db);
      const r = await db.q(`update public.draft set state='marked_sent' where id=$1`, [id]);
      return r.error?.code ?? "accepted";
    });
    expect(out).toBe("22023");
  });

  it("sent drafts cannot be reopened", async () => {
    const out = await asRole("colleague", async (db) => {
      const { id } = await newDraft(db);
      await db.q(`select app.approve_draft($1)`, [id]);
      const sent = await db.q<{ state: string }>(`select state from app.mark_draft_sent($1)`, [id]);
      const r = await db.q(`update public.draft set state='drafted' where id=$1`, [id]);
      return { sent: sent.rows[0]?.state, reopen: r.error?.code ?? "accepted" };
    });
    expect(out).toEqual({ sent: "marked_sent", reopen: "22023" });
  });

  it("draft_event and audit_event cannot be rewritten by app users", async () => {
    const out = await asRole("owner", async (db) => {
      const { id } = await newDraft(db);
      await db.q(`insert into public.draft_event(workspace_id, draft_id, event, actor_user_id) values ($1,$2,'drafted',$3)`, [WS1, id, USERS.owner.id]);
      const u = await db.q(`update public.draft_event set event='approved' where draft_id=$1 returning 1`, [id]);
      const d = await db.q(`delete from public.draft_event where draft_id=$1 returning 1`, [id]);
      const au = await db.q(`update public.audit_event set action='tampered' where entity_id=$1 returning 1`, [id]);
      const ad = await db.q(`delete from public.audit_event where entity_id=$1 returning 1`, [id]);
      const ai = await db.q(`insert into public.audit_event(workspace_id, action, entity_type) values ($1,'forged','x') returning 1`, [WS1]);
      return [u, d, au, ad, ai].map((r) => (r.error ? r.error.code : r.rows.length ? "CHANGED" : "noop"));
    });
    expect(out.every((x) => x === "42501" || x === "noop")).toBe(true);
    expect(out.includes("CHANGED")).toBe(false);
  });
  it("TypeScript draftHash is byte-identical to app.draft_content_hash (incl. unicode and attachments)", async () => {
    const d = { recipient_person_id: USERS.owner.id, recipient_address: "Ä@example.invalid", subject: "Näme 😀 | ~", body: "x\ny|1:z",
      attachment_document_ids: ["B0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000001"] };
    const out = await asRole("colleague", (db) => db.q<{ h: string }>(`select app.draft_content_hash($1,$2,$3,$4,$5::uuid[]) as h`,
      [d.recipient_person_id, d.recipient_address, d.subject, d.body, d.attachment_document_ids]));
    expect(out.rows[0].h).toBe(draftHash(d));
    expect(draftHash({ ...d, subject: null })).not.toBe(draftHash({ ...d, subject: "" }));
  });

  it("editors cannot write approval/sent columns, insert pre-approved drafts, or forge approval rows", async () => {
    const out = await asRole("colleague", async (db) => {
      const { id, content_hash } = await newDraft(db);
      const cols = await db.q(`update public.draft set approved_hash=content_hash, approved_by=$2, approved_at=now() where id=$1`, [id, USERS.colleague.id]);
      const sentCols = await db.q(`update public.draft set sent_evidence='user_assertion' where id=$1`, [id]);
      const opened = await db.q(`update public.draft set state='opened_for_send' where id=$1`, [id]);
      const preApproved = await db.q(`insert into public.draft(workspace_id, channel, body, content_hash, state, owner_user_id) values ($1,'email','x',$3,'approved',$2)`, [WS1, USERS.colleague.id, draftHash({ body: "x" })]);
      const forgedApproval = await db.q(`insert into public.approval(workspace_id, subject_type, subject_id, approver_user_id, approved_hash, decision, owner_user_id)
        values ($1,'draft',$2,$3,$4,'approved',$3)`, [WS1, id, USERS.colleague.id, content_hash]);
      const markWithoutApproval = await db.q(`select app.mark_draft_sent($1)`, [id]);
      return [cols, sentCols, opened, preApproved, forgedApproval, markWithoutApproval].map((r) => r.error?.code ?? "accepted");
    });
    expect(out).toEqual(["42501", "42501", "22023", "42501", "42501", "22023"]);
  });

  it("approve_draft refuses stale reviews, suppressed recipients and viewers/outsiders; edits drop approval", async () => {
    const out = await asRole("colleague", async (db) => {
      const { id, d } = await newDraft(db);
      const stale = await db.q(`select app.approve_draft($1, 'not-what-you-saw')`, [id]);
      await db.q(`select app.approve_draft($1, $2)`, [id, draftHash(d)]);
      const edited = await db.q<{ state: string; approved_hash: string | null }>(
        `update public.draft set body='Edited', content_hash=$2 where id=$1 returning state, approved_hash`, [id, draftHash({ ...d, body: "Edited" })]);
      const openAfterEdit = await db.q(`select app.open_draft_for_send($1)`, [id]);
      await db.become("other");
      const outsider = await db.q(`select app.approve_draft($1)`, [id]);
      await db.become("service_role");
      await db.q(`insert into public.suppression_tombstone(workspace_id, value_hash, method_type, reason)
                  values ($1, encode(extensions.digest('cfo@example.invalid','sha256'),'hex'), 'email', 'opt_out') on conflict do nothing`, [WS1]);
      await db.become("colleague");
      const suppressed = await db.q(`select app.approve_draft($1)`, [id]);
      return { stale: stale.error?.code, edited: edited.rows[0], openAfterEdit: openAfterEdit.error?.code, outsider: outsider.error?.code, suppressed: suppressed.error?.code };
    });
    expect(out).toEqual({ stale: "40001", edited: { state: "drafted", approved_hash: null }, openAfterEdit: "22023", outsider: "P0002", suppressed: "CRSUP" });
  });
});
