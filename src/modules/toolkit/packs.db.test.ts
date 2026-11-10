/** Integration (RLS, mock AI): quote intake → versioned quotes / approval path; evidence; pack generation stored + recorded. */
import { describe, it, expect, beforeAll } from "vitest";
import { USERS, WS1, WS2, adminClient, tag, userClient } from "../../../tests/helpers";
import type { Db } from "@/lib/supabase/server";
import type { DealsCtx } from "@/modules/deals/ctx";
import { createRequirement } from "@/modules/deals/requirements/service";
import { createIntake, saveIntakeVersion, regexExtract } from "./quote-intake";
import { addEvidence, listEvidence, setVerification } from "./evidence";
import { generatePacks, PACKS_FORMULA } from "./packs";
import { getAnalysis, saveAnalysis } from "./store";

let db: Db; let ctx: DealsCtx; let reqId: string; let assetId: string; let spaceId: string;
beforeAll(async () => {
  db = await userClient("owner");
  ctx = { db, workspaceId: WS1, userId: USERS.owner.id, role: "owner" };
  const r = await createRequirement(ctx, { orgName: tag("Packs Co"), title: tag("Packs req"), changes: [{ key: "area", value: [5000, 6000, 7000] }] });
  reqId = String(r.id);
  const a = await db.from("asset").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, name: tag("Pack Tower"), address: "Kharadi", grade: "A", specs: { amenities: ["Cafeteria"], power: "100% backup" } }).select("id").single();
  assetId = a.data!.id;
  const s = await db.from("space").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, asset_id: assetId }).select("id").single();
  if (s.error) throw s.error;
  spaceId = s.data!.id;
});

describe("toolkit quote intake + evidence + packs (db)", () => {
  it("intake creates v1, re-intake revises to v2 (old kept), approved latest → change proposal", async () => {
    const i1 = await createIntake(ctx, { requirementId: reqId, quoteId: null, spaceId, partyKind: "landlord", storagePath: null, fileName: null, text: "Provider: X Realty\nRent: 85 per sq ft per month chargeable\nValid until: 2026-12-31" });
    const r1 = await saveIntakeVersion(ctx, i1.id, regexExtract("Provider: X Realty\nRent: 85 per sq ft per month chargeable\nValid until: 2026-12-31"));
    expect(r1.mode).toBe("created");
    const q1 = (r1 as any).quote;
    expect(q1.space_id).toBe(spaceId);
    await expect(saveIntakeVersion(ctx, i1.id, regexExtract("Rent: 1"))).rejects.toThrow(/already saved/);
    const i2 = await createIntake(ctx, { requirementId: null, quoteId: q1.id, partyKind: "landlord", storagePath: null, fileName: null, text: "Rent: 90 per sq ft per month chargeable\nValid until: 2027-01-31" });
    const r2 = await saveIntakeVersion(ctx, i2.id, regexExtract("Provider: X Realty\nRent: 90 per sq ft per month chargeable\nValid until: 2027-01-31"));
    expect(r2.mode).toBe("revised");
    const q2 = (r2 as any).quote;
    expect(q2.version).toBe(2);
    expect(q2.terms_json.rent).toBe(90);
    const old = await db.from("quote").select("superseded_by, terms_json").eq("id", q1.id).single();
    expect(old.data!.superseded_by).toBe(q2.id);
    expect(old.data!.terms_json.rent).toBe(85);
    // approved latest version → proposal, no direct write
    const ap = await adminClient().from("quote").update({ approved_at: new Date().toISOString() }).eq("id", q2.id).select("id"); // fixture: simulate an approved version
    expect(ap.data!.length).toBe(1);
    const i3 = await createIntake(ctx, { requirementId: null, quoteId: q1.id, partyKind: "landlord", storagePath: null, fileName: null, text: "Rent: 95 per sq ft per month" });
    const r3 = await saveIntakeVersion(ctx, i3.id, regexExtract("Rent: 95 per sq ft per month chargeable\nValid until: 2027-02-28"));
    expect(r3.mode).toBe("proposed");
    const still = await db.from("quote").select("id").eq("id", q2.id).is("superseded_by", null);
    expect(still.data!.length).toBe(1);
  });
  it("rejects path traversal into other workspaces", async () => {
    await expect(createIntake(ctx, { requirementId: reqId, quoteId: null, partyKind: "other", storagePath: `${WS2}/quotes/x.pdf`, fileName: "x.pdf", text: "Rent: 1" })).rejects.toThrow(/invalid/);
  });
  it("evidence attach / verification / conflict note required; packs generated, stored and recorded", async () => {
    const cmp = await saveAnalysis(db, WS1, USERS.owner.id, { kind: "property_comparison", title: tag("Cmp"), requirementId: reqId, assetIds: [assetId], inputs: {}, outputs: { properties: [{ name: "Pack Tower", rank: 1, score: 80, occupancyCost: 100, eligibility: "eligible", evidence: "quoted" }], recommendation: { key: "x", explanation: "Pack Tower fits best.", tie: false } }, formulaVersion: "rating-1.0" });
    const e = await addEvidence(ctx, { analysisId: cmp.id, kind: "brochure", title: "Brochure", url: "https://example.com/b.pdf" });
    expect(e.verification).toBe("unverified");
    await expect(setVerification(ctx, e.id, "conflicting")).rejects.toThrow(/what conflicts/i);
    await setVerification(ctx, e.id, "conflicting", "Brochure area differs from quote");
    expect((await listEvidence(ctx, cmp.id))[0].verification).toBe("conflicting");

    const g = await generatePacks(ctx, { requirementId: reqId, assetIds: [assetId], preparedFor: "Client CFO" });
    expect(g.files.map((f) => f.kind)).toEqual(["docx", "pptx"]);
    const a = await getAnalysis(db, WS1, g.id) as Record<string, any>;
    expect(a).toMatchObject({ kind: "deliverable", formula_version: PACKS_FORMULA });
    expect(a.inputs.analysisRefs).toEqual([{ id: cmp.id, kind: "property_comparison", version: 1 }]);
    expect(a.inputs.quoteRefs.length).toBe(1);
    const dl = await db.storage.from("mudar-workspace-files").download(g.files[1].path);
    expect(Buffer.from(await dl.data!.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
  });
});
