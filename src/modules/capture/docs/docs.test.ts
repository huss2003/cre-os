import { describe, expect, it } from "vitest";
import { detectDocType, fileFamily, imageSize } from "./detect";
import { cardContactMethods, parseBusinessCard } from "./card";

describe("document type detection (deterministic first)", () => {
  it("routes by file type", () => {
    expect(detectDocType({ name: "pipeline.xlsx", mime: "" }).type).toBe("spreadsheet");
    expect(detectDocType({ name: "leads.csv", mime: "text/csv" }).type).toBe("spreadsheet");
    expect(detectDocType({ name: "visit.m4a", mime: "audio/mp4" }).type).toBe("audio");
    expect(detectDocType({ name: "x.exe", mime: "application/octet-stream" }).type).toBe("unknown");
    expect(fileFamily("scan", "", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("pdf");
  });
  it("routes documents by keywords", () => {
    expect(detectDocType({ name: "a.pdf", mime: "application/pdf", text: "Commercial proposal. Rate per seat ₹ 9,500. Validity of this offer: 30 days. Fit-out cost extra." }).type).toBe("quotation");
    expect(detectDocType({ name: "a.pdf", mime: "application/pdf", text: "Leave and licence agreement between the Licensor and the Licensee. Lock-in 36 months. Security deposit 6 months. Escalation 5%." }).type).toBe("lease");
    expect(detectDocType({ name: "a.docx", mime: "", text: "Letter of Intent (non-binding). Lock-in 24 months. Security deposit 6 months." }).type).toBe("loi");
    expect(detectDocType({ name: "notes.txt", mime: "text/plain", text: "Minutes of meeting. Attendees: Raj, Priya. Action items: send options. Next steps: site visit." }).type).toBe("meeting_notes");
  });
  it("flags ambiguity instead of guessing", () => {
    const d = detectDocType({ name: "doc.pdf", mime: "application/pdf", text: "Hello world" });
    expect(d.ambiguous).toBe(true);
    expect(d.type).toBe("unknown");
  });
  it("images: card only with contact signals, layout on plan words, else property photo", () => {
    expect(detectDocType({ name: "c.jpg", mime: "image/jpeg", text: "Raj Mehta\nDirector\nraj@acme.in\nM: +91 98220 12345" }).type).toBe("business_card");
    expect(detectDocType({ name: "p.jpg", mime: "image/jpeg", text: "FLOOR PLAN Level 5 workstations 120 cabins 6" }).type).toBe("layout");
    expect(detectDocType({ name: "p.jpg", mime: "image/jpeg", text: "" }).type).toBe("unknown"); // no cues: the user picks
    expect(detectDocType({ name: "p.jpg", mime: "image/jpeg", text: "", userType: "layout" }).method).toBe("user");
  });
});

describe("business card parser", () => {
  it("parses fields and types phones from their labels", () => {
    const c = parseBusinessCard([
      "Raj Mehta", "Director - Corporate Real Estate", "Acme Technologies Pvt. Ltd.",
      "T: +91 20 6700 1000 | D: +91 20 6700 1234", "M: +91 98220 12345", "raj.mehta@acme.in", "www.acme.in",
    ].join("\n"));
    expect(c.name).toBe("Raj Mehta");
    expect(c.title).toBe("Director - Corporate Real Estate");
    expect(c.company).toBe("Acme Technologies Pvt. Ltd.");
    expect(c.emails).toEqual(["raj.mehta@acme.in"]);
    expect(c.website).toBe("www.acme.in");
    expect(c.phones.map((p) => p.type)).toEqual(["switchboard", "direct", "mobile"]);
  });
  it("never invents: missing fields stay null; unlabelled landline is unknown, not direct", () => {
    const c = parseBusinessCard("priya@example.com\n020 2567 8901");
    expect(c.name).toBeNull();
    expect(c.title).toBeNull();
    expect(c.company).toBeNull(); // not derived from the email domain
    expect(c.website).toBeNull();
    expect(c.phones).toHaveLength(1);
    expect(c.phones[0].type).toBe("unknown");
    // every value is verbatim from the card text
    const text = "priya@example.com\n020 2567 8901";
    for (const p of c.phones) expect(text).toContain(p.value);
  });
  it("unlabelled Indian mobile is typed mobile; contact methods carry no verification claim", () => {
    const c = parseBusinessCard("Anil Kumar\n9876543210");
    expect(c.phones[0].type).toBe("mobile");
    const cm = cardContactMethods(c);
    expect(cm[0]).toMatchObject({ method_type: "phone", value: "9876543210", verify_status: "business_mobile" });
    expect(cm.some((x) => x.verify_status === "verified")).toBe(false);
  });
});

// Minimal fixture headers: PNG signature + IHDR (w,h), and JPEG SOI + APP0 + SOF0 (h,w).
function png(w: number, h: number, size = 0): Uint8Array {
  const b = new Uint8Array(Math.max(33, size));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number, size = 0): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3];
  const b = new Uint8Array(Math.max(head.length + 16, size)); b.set(head); return b;
}

describe("image detection from file cues (business card vs property photo)", () => {
  it("reads PNG and JPEG pixel sizes from header bytes", () => {
    expect(imageSize(png(1050, 600))).toEqual({ width: 1050, height: 600 });
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it("a small card-shaped PNG with no readable text is a business card, not a property photo", () => {
    const b = png(1050, 600, 90_000);
    const d = detectDocType({ name: "Screenshot 2026-11-10.png", mime: "image/png", bytes: b, text: "" });
    expect(d.type).toBe("business_card");
    expect(d.signals.join(" ")).toMatch(/card-shaped/);
  });
  it("filename words win: visiting card / vcard → card", () => {
    expect(detectDocType({ name: "raj_visiting_card.png", mime: "image/png", bytes: png(800, 800, 50_000), text: "" }).type).toBe("business_card");
    expect(detectDocType({ name: "vcard.jpg", mime: "image/jpeg", bytes: jpeg(3000, 2000, 2_000_000), text: "" }).type).toBe("business_card");
  });
  it("OCR text with name + title + email → card even with a photo-ish file", () => {
    expect(detectDocType({ name: "IMG_2031.jpg", mime: "image/jpeg", bytes: jpeg(4032, 3024, 3_000_000), text: "Priya Shah\nSenior Manager\npriya@acme.in" }).type).toBe("business_card");
  });
  it("property photo needs photo cues (filename / big camera file / camera shape)", () => {
    expect(detectDocType({ name: "IMG_2031.jpg", mime: "image/jpeg", bytes: jpeg(4032, 3024, 3_000_000), text: "" }).type).toBe("property_photo");
    expect(detectDocType({ name: "tower-facade.png", mime: "image/png", bytes: png(1600, 1200, 900_000), text: "" }).type).toBe("property_photo");
    expect(detectDocType({ name: "upload.jpg", mime: "image/jpeg", bytes: jpeg(4000, 3000, 2_500_000), text: "" }).type).toBe("property_photo");
  });
  it("unsure → unknown so the user picks (no guessing)", () => {
    const d = detectDocType({ name: "upload.png", mime: "image/png", bytes: png(1000, 1000, 700_000), text: "" });
    expect(d).toMatchObject({ type: "unknown", ambiguous: true });
    expect(d.candidates).toEqual(["business_card", "property_photo", "layout"]);
    // conflicting cues: card-shaped small file named "photo"
    expect(detectDocType({ name: "photo.png", mime: "image/png", bytes: png(1050, 600, 80_000), text: "" }).type).toBe("unknown");
  });
});
