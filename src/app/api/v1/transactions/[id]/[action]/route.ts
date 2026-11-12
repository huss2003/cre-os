import { z } from "zod";
import { HttpError } from "@/lib/auth/context";
import { parseJson } from "@/lib/util/http";
import { txRoute } from "@/modules/transactions/api";
import * as S from "@/modules/transactions/service";
import { answer, ASSISTANT_QUESTIONS, intakeDocument } from "@/modules/transactions/integrations";
import { generateClosurePack } from "@/modules/transactions/closure-pack";

const terms = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
const B = {
  offers: z.object({ parentOfferId: z.string().uuid().nullish(), kind: z.enum(["offer", "counteroffer", "revised", "final", "agreed"]).optional(), offeringParty: z.string(), receivingParty: z.string(), offerDate: z.string(), validUntil: z.string().nullish(), terms, reason: z.string().nullish(), sourceDocument: z.string().nullish(), propertyLabel: z.string().nullish() }),
  compare: z.object({ a: z.string().uuid(), b: z.string().uuid(), assumptions: terms.optional() }),
  issues: z.object({ title: z.string(), category: z.string(), ownerUserId: z.string().uuid(), nextAction: z.string(), dueDate: z.string().nullish(), noDueReason: z.string().nullish(), blocking: z.boolean().optional(), dependsOn: z.array(z.string().uuid()).optional(), stakeholderId: z.string().uuid().nullish() }),
  approvals: z.object({ category: z.string(), subjectType: z.string(), subjectId: z.string().uuid(), reviewerUserId: z.string().uuid().nullish(), deadline: z.string().nullish() }),
  documents: z.object({ docKind: z.enum(["loi", "term_sheet", "agreement", "executed_agreement", "handover", "other"]), family: z.string().optional(), title: z.string(), body: z.string().min(1).max(500_000) }),
  communications: z.object({ subject: z.string().optional(), body: z.string().min(1), recipientDisplay: z.string().optional(), recipientAddress: z.string().optional() }),
  milestones: z.object({ kind: z.string(), expectedOn: z.string().nullish(), achievedOn: z.string().nullish(), evidence: z.string().optional(), documentId: z.string().uuid().nullish() }),
  intake: z.object({ kind: z.string(), text: z.string().min(1).max(500_000), sourceRef: z.string().optional() }),
};

/** Mutations: POST /api/v1/transactions/{id}/{offers|compare|issues|approvals|documents|communications|milestones|intake|closure-pack|complete} (Idempotency-Key). */
export const POST = txRoute<{ id: string; action: string }>({ mutation: true }, async (req, ctx, { id, action }) => {
  switch (action) {
    case "offers": return { offer: await S.createOffer(ctx, id, await parseJson(req, B.offers)) };
    case "compare": { const b = await parseJson(req, B.compare); return S.compareOfferPackages(ctx, id, b.a, b.b, b.assumptions ?? {}); }
    case "issues": return { issue: await S.createIssue(ctx, id, await parseJson(req, B.issues)) };
    case "approvals": return { approval: await S.requestApproval(ctx, id, await parseJson(req, B.approvals)) };
    case "documents": return { document: await S.addDocumentVersion(ctx, id, await parseJson(req, B.documents)) };
    case "communications": return { draft: await S.draftCommunication(ctx, id, await parseJson(req, B.communications)) };
    case "milestones": { const b = await parseJson(req, B.milestones); return { milestone: await S.setMilestone(ctx, id, b.kind, { ...b, evidence: b.evidence }) }; }
    case "intake": return { intake: await intakeDocument(ctx, id, await parseJson(req, B.intake)) };
    case "closure-pack": { const r = await generateClosurePack(ctx, id); return { documentId: r.documentId, versionNo: r.versionNo, sha256: r.sha256 }; }
    case "complete": return { transaction: await S.completeTransaction(ctx, id) };
    default: throw new HttpError(404, "unknown action");
  }
});

/** Reads: GET /api/v1/transactions/{id}/{timeline|offers|positions|ask?q=…} */
export const GET = txRoute<{ id: string; action: string }>({}, async (req, ctx, { id, action }) => {
  switch (action) {
    case "timeline": return { events: await S.timeline(ctx, id) };
    case "offers": return { offers: await S.listOffers(ctx, id), diffs: await S.compareOfferVersions(ctx, id) };
    case "positions": return { positions: await S.positionsView(ctx, id) };
    case "ask": {
      const q = req.nextUrl.searchParams.get("q") ?? "";
      if (!(ASSISTANT_QUESTIONS as readonly string[]).includes(q)) throw new HttpError(400, `q must be one of ${ASSISTANT_QUESTIONS.join(", ")}`);
      return answer(ctx, id, q as (typeof ASSISTANT_QUESTIONS)[number]);
    }
    default: throw new HttpError(404, "unknown view");
  }
});
