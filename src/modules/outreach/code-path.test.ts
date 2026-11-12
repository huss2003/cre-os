import { describe, expect, it } from "vitest";
import { classifyReply } from "./reply-classifier";
import { noPlaceholders, templateDraft, variantMock, VARIANT_ANGLES } from "./rules";

describe("reply classifier (outreach.response / integrations.triage code path)", () => {
  it.each([
    ["Thanks, we are interested. Tell me more.", "interested"],
    ["Sounds good — let's meet on Tuesday at 4pm", "meeting"],
    ["Please share the options and rates in Baner", "info_requested"],
    ["Not right now, maybe next quarter", "not_now"],
    ["We're not interested, thanks", "not_interested"],
    ["I am out of the office until 20 Nov with limited access to email", "out_of_office"],
    ["I'm no longer with Acme, please reach out to Priya instead who handles facilities", "wrong_person"],
    ["Please unsubscribe me from these emails", "unsubscribe"],
    // Hinglish / Hindi
    ["Haan ji, theek hai, kal call karte hain", "meeting"],
    ["Abhi koi requirement nahi hai, agle quarter mein dekhte hain", "not_now"],
    ["Hume zarurat nahi hai, thanks", "not_interested"],
    ["Baner ke options aur rates bhej do", "info_requested"],
    ["Main ye nahi dekhta, Rahul se unse baat karo", "wrong_person"],
    ["Please message mat bhejo", "unsubscribe"],
    ["Main chutti par hoon, 25 tak", "out_of_office"],
    ["हाँ, ठीक है", "interested"],
    ["अभी नहीं, बाद में", "not_now"],
  ])("%s → %s", (text, label) => {
    expect(classifyReply(text).label).toBe(label);
  });
  it("unclear text stays unclear", () => expect(classifyReply("Received.").label).toBe("unclear"));
});

describe("outreach templates (outreach.draft code path)", () => {
  const base = { scenario: "lease_renewal" as const, first: "Anil", company: "Acme", level: "not_interacted" as const, reason: "Your Baner lease reaches its notice date in March 2027", roleKey: "facilities", sender: "[Your name]" };
  it.each(["email", "whatsapp", "linkedin", "call", "introduction"] as const)("%s draft has no placeholders and keeps the reason", (channel) => {
    const d = noPlaceholders({ ...templateDraft({ ...base, channel, via: "Ravi" }), }, "[Your name]");
    const all = [d.subject ?? "", d.body, d.forwardable ?? "", ...(d.opening_alternatives ?? [])].join("\n");
    expect(all).not.toMatch(/\[[^\]]+\]/);
    expect(all).not.toMatch(/undefined|null/);
    expect(d.body).toContain("Baner lease");
  });
  it("uses the configured sender name", () => {
    const d = noPlaceholders(templateDraft({ ...base, channel: "email", sender: "Mudar" }), "Mudar");
    expect(d.body).toMatch(/Regards,\nMudar$/);
  });
  it("three tone variants are distinct", () => {
    const cur = templateDraft({ ...base, channel: "email", sender: "Mudar" });
    const vs = VARIANT_ANGLES.map((a) => variantMock(cur, a.key, "Anil", "Is the renewal on your radar?").body);
    expect(new Set(vs).size).toBe(3);
    expect(vs.join("\n")).not.toMatch(/\[[^\]]+\]/);
  });
});
describe("reply classifier precedence", () => {
  it.each([
    ["Thanks Rahul here — please send details of options in Kharadi. Let's meet Tuesday.", "meeting"],
    ["Thanks, let's talk next month.", "meeting"],
    ["Not now — maybe call me next quarter", "not_now"],
  ])("%s → %s", (text, label) => expect(classifyReply(text).label).toBe(label));
});
