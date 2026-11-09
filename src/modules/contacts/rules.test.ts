import { describe, it, expect } from "vitest";
import { emailStatus, phoneInfo, classify, matchIdentity, completeness } from "./rules";

describe("contact rules", () => {
  it("email: syntax/MX never prove a mailbox; guesses never verified; role inboxes flagged", () => {
    expect(emailStatus({ email: "not-an-email" }).status).toBe("invalid");
    expect(emailStatus({ email: "a@nomx.example", mx: false }).status).toBe("invalid");
    expect(emailStatus({ email: "rahul@vertexnova.example", companyDomain: "vertexnova.example", mx: true, guessed: true }).status).toBe("unverified");
    expect(emailStatus({ email: "rahul@vertexnova.example", companyDomain: "vertexnova.example", mx: true, published: true }).status).toBe("likely_valid");
    expect(emailStatus({ email: "info@vertexnova.example", mx: true, published: true }).status).toBe("generic");
    expect(emailStatus({ email: "rahul@gmail.com", mx: true, published: true }).status).toBe("risky");
    expect(emailStatus({ email: "rahul@vertexnova.example", mx: true, confirmedBy: "person" }).status).toBe("verified");
    expect(emailStatus({ email: "rahul@vertexnova.example", mx: true }).evidence.find((e) => e.check === "syntax")!.note).toMatch(/does not prove/);
  });
  it("phone: formats Indian numbers, keeps extensions, never infers ownership", () => {
    const a = phoneInfo("09000000001");
    expect(a.e164).toBe("+919000000001"); expect(a.status).toBe("unverified");
    expect(phoneInfo("+91 20 6600 1234 ext 45", { onCompanyContactPage: true })).toMatchObject({ ext: "45", status: "switchboard", country: "India" });
    expect(phoneInfo("123").status).toBe("invalid");
    expect(phoneInfo("+91 9000000001", { published: true, mobileExplicit: true }).status).toBe("business_mobile");
  });
  it("roles: designation alone is not authority", () => {
    expect(classify("Head of Corporate Real Estate").role).toBe("decision_maker");
    expect(classify("Head of Administration")).toMatchObject({ role: "technical_evaluator", relevance: "high" });
    expect(classify("Chief Executive Officer")).toMatchObject({ role: "influencer", relevance: "low" });
    expect(classify("CFO").role).toBe("economic_buyer");
    expect(classify("Executive Assistant to the CEO").role).toBe("gatekeeper");
    expect(classify("Software Engineer").relevance).toBe("none");
    expect(classify(null).role).toBe("unknown");
  });
  it("identity: email/profile match; name alone never merges", () => {
    const ppl = [{ id: "p1", full_name: "Rahul Mehta", aliases: [], emails: ["rahul@x.example"], profile: null, current_org_ids: ["oA"], past_org_ids: [] },
      { id: "p2", full_name: "Rahul Mehta", aliases: [], emails: [], profile: null, current_org_ids: ["oB"], past_org_ids: [] }];
    expect(matchIdentity({ full_name: "R. Mehta", emails: ["rahul@x.example"], profile: null, org_id: "oZ" }, ppl).kind).toBe("existing");
    expect(matchIdentity({ full_name: "Rahul Mehta", emails: [], profile: null, org_id: "oA" }, ppl)).toMatchObject({ kind: "existing", person_id: "p1" });
    expect(matchIdentity({ full_name: "Rahul Mehta", emails: [], profile: null, org_id: "oC" }, ppl).kind).toBe("possible_duplicate");
    expect(matchIdentity({ full_name: "Rahul Mehta", emails: [], profile: null, org_id: "oC" }, [ppl[1]]).kind).toBe("job_change");
    expect(matchIdentity({ full_name: "Asha Rao", emails: [], profile: null, org_id: "oA" }, ppl).kind).toBe("new");
  });
  it("completeness ignores invalid/missing", () => {
    expect(completeness([{ field: "full_name", value: "x", status: "reported" }, { field: "email", value: "bad", status: "invalid" }])).toBe(10);
  });
});
