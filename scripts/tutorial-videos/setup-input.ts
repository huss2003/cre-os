/**
 * Demo data + demo files for the "input" tutorial videos (Module 10 Input Engine). Local Supabase + demo workspace ONLY.
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-input.ts          # data + files
 *   … setup-input.ts jobs [--fail-first <file name>] [--max N]   # run queued jobs of the latest demo batch upload (no worker runs locally)
 *
 * Data (synthetic, ids from did("tutorial:…")): Anil Deshmukh at Marigold Loop Technologies (the "Anil" of the spec example) and a
 * Marigold requirement the quotation videos link to. Previous tutorial captures / files / spreadsheet versions are archived so every
 * recording starts from version 1 (demo workspace only; nothing outside it is touched).
 *
 * Files (written to $TUT_INPUT_DIR, default /tmp/tutorial-input — never into the repo): a business-card PNG (two), quotation PDFs
 * (₹85 then ₹95), a voice note (WAV tone — mock mode has no speech-to-text), a contacts spreadsheet v1 + v2 (same name), and a batch of
 * mixed files (PDF, DOCX, CSV, XLSX, an old .xls). Each run embeds a nonce so the file hashes are new (no "already uploaded").
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph } from "docx";
import { did, DEMO_WORKSPACE_ID as WS, OWNER_USER_ID as OWNER, SYNTHETIC_NOTE } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";

type Row = Record<string, any>;
const tid = (kind: string, key: string) => did(`tutorial:${kind}`, key);
export const INPUT = {
  anil: tid("person", "anil-deshmukh"),
  requirement: tid("requirement", "marigold-20k"),
  employment: tid("employment", "anil-marigold"),
};
const DIR = process.env.TUT_INPUT_DIR || "/tmp/tutorial-input";
const FFMPEG = process.env.FFMPEG || "/usr/local/bin/ffmpeg";
export const FILES = {
  cardNew: "card-meera-joshi.png", cardAnil: "card-anil-deshmukh.png", quote1: "marigold-quote-march.pdf", quote2: "marigold-quote-revised.pdf",
  voice: "voice-note-marigold-call.wav", sheet: "Pune contacts.xlsx",
  batch: ["Hinjewadi brochure.pdf", "Site visit notes - Kharadi.docx", "Wakad contacts.csv", "Baner availability.xlsx", "Old tracker 2019.xls"],
};

const must = async <T,>(p: PromiseLike<{ data: T; error: { message: string } | null }>) => { const r = await p; if (r.error) throw new Error(r.error.message); return r.data; };

async function data() {
  const db = createAdminClient();
  const org = (await must(db.from("organisation").select("id").eq("workspace_id", WS).eq("display_name", "Marigold Loop Technologies").limit(1))) as Row[];
  if (!org.length) throw new Error("demo company Marigold Loop Technologies missing — run setup-demo.ts first");
  const ORG = org[0].id as string;
  const base = (cls = "corporate_confidential") => ({ workspace_id: WS, owner_user_id: OWNER, classification: cls });
  const note = `Tutorial demo record (demo). ${SYNTHETIC_NOTE}`;
  const up = async (table: string, rows: Row[]) => { const { error } = await db.from(table).upsert(rows, { onConflict: "id" }); if (error) throw new Error(`${table}: ${error.message}`); };
  await up("person", [{ ...base("permitted_personal"), id: INPUT.anil, full_name: "Anil Deshmukh", preferred_channel: "phone", personal_notes: note, archived_at: null }]);
  await up("contact_method", [{ ...base("permitted_personal"), id: tid("contact", "anil-email"), person_id: INPUT.anil, method_type: "email", value: "anil.deshmukh@marigoldloop.example", preferred: true }]);
  await up("employment", [{ ...base(), id: INPUT.employment, person_id: INPUT.anil, org_id: ORG, title: "Head of Workplace", function: "Admin", seniority: "head", is_current: true, fact_status: "reported" }]);
  const kharadi = (await must(db.from("geography").select("id").eq("workspace_id", WS).eq("name", "Kharadi").limit(1))) as Row[];
  await up("requirement", [{ ...base(), id: INPUT.requirement, org_id: ORG, title: "Marigold Loop — 20,000 sf in Kharadi (demo)", objective: "expansion", transaction_kinds: ["conventional"],
    area_target_sf: 20000, area_basis: "chargeable", preferred_geography_ids: kharadi.map((g) => g.id), status: "draft", archived_at: null }]);

  // ---- reset earlier tutorial runs (demo workspace only): archive captures/files, retire their observations so they are
  // neither "repeats" nor "conflicts" of the new recording, archive spreadsheet versions so the import starts at v1 again.
  const now = new Date().toISOString();
  const caps = (await must(db.from("capture").select("id").eq("workspace_id", WS).is("archived_at", null)
    .or("raw_text.ilike.%Spoke to Anil%,raw_text.ilike.%Marigold%,raw_text.ilike.%Meera%,transcript.ilike.%Marigold%"))) as Row[];
  const names = [FILES.cardNew, FILES.cardAnil, FILES.quote1, FILES.quote2, FILES.voice, FILES.sheet, ...FILES.batch];
  const docs = (await must(db.from("capture_document").select("id").eq("workspace_id", WS).in("file_name", names).is("archived_at", null))) as Row[];
  const retire = async (col: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const obs = (await must(db.from("capture_observation").select("id, obs_key, content_hash, source_hash").eq("workspace_id", WS).in(col, chunk))) as Row[];
      for (const o of obs) {
        if (String(o.content_hash ?? "").endsWith(":retired")) continue;
        await must(db.from("capture_observation").update({ status: "rejected", archived_at: now, content_hash: `${o.content_hash}:retired`, source_hash: `${o.source_hash}:retired`, review_category: null })
          .eq("workspace_id", WS).eq("id", o.id));
      }
    }
  };
  await retire("capture_id", caps.map((c) => c.id));
  await retire("capture_document_id", docs.map((d) => d.id));
  // anything still observed on the demo requirement (earlier quotes) would make the first quote a "conflict"
  const reqObs = (await must(db.from("capture_observation").select("id").eq("workspace_id", WS).eq("subject_id", INPUT.requirement).is("archived_at", null))) as Row[];
  for (const o of reqObs) await must(db.from("capture_observation").update({ status: "rejected", archived_at: now }).eq("workspace_id", WS).eq("id", o.id));
  if (caps.length) await must(db.from("capture").update({ archived_at: now }).eq("workspace_id", WS).in("id", caps.map((c) => c.id)));
  if (docs.length) await must(db.from("capture_document").update({ archived_at: now }).eq("workspace_id", WS).in("id", docs.map((d) => d.id)));
  await must(db.from("source_object").update({ archived_at: now }).eq("workspace_id", WS).eq("kind", "file").in("file_name", names).is("archived_at", null));
  // the mapping video approves "Remarks → custom"; forget it so the next recording starts from the suggested mapping again
  await db.from("import_header_alias").delete().eq("workspace_id", WS).eq("adapter", "contacts_requirements_v1").eq("header_norm", "remarks");
  await db.from("adapter_mapping").delete().eq("workspace_id", WS).eq("adapter", "contacts_requirements_v1");
  // the Marigold requirement keeps its seeded values (a previous run may have applied a proposal)
  await must(db.from("requirement").update({ area_target_sf: 20000, budget_max: null, budget_basis: null }).eq("workspace_id", WS).eq("id", INPUT.requirement));
  console.log(`data ok · archived ${caps.length} captures, ${docs.length} files`);
}

// ------------------------------------------------------------------------------------------------ files
async function pdf(pages: string[][]) {
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica); const bold = await d.embedFont(StandardFonts.HelveticaBold);
  for (const lines of pages) {
    const p = d.addPage([595, 842]);
    lines.forEach((l, i) => p.drawText(l, { x: 56, y: 770 - i * 22, size: i === 0 ? 16 : 12, font: i === 0 ? bold : font }));
  }
  return Buffer.from(await d.save());
}
async function card(lines: string[], file: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = lines.map((l, i) => `<text x="48" y="${i === 0 ? 92 : 92 + 30 + i * 30}" font-family="DejaVu Sans" font-size="${i === 0 ? 30 : 19}" font-weight="${i === 0 ? 700 : 400}" fill="${i < 3 ? "#0f172a" : "#334155"}">${esc(l)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${150 + lines.length * 30}"><rect width="100%" height="100%" rx="24" fill="#fdfcf8"/><rect x="0" y="0" width="16" height="100%" fill="#0e7490"/>${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(DIR, file));
}
async function sheet(file: string, header: string[], rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Contacts");
  ws.addRow(header); for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(file);
}

async function files() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "v2"), { recursive: true }); fs.mkdirSync(path.join(DIR, "batch"), { recursive: true });
  const nonce = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  // business cards (images; mock mode has no OCR, so the video types the card text)
  await card(["Meera Joshi", "Head - Leasing", "Riverside Realty LLP", "M: +91 98220 45678", "Ph: 020 6612 3400", "meera.joshi@riversiderealty.example",
    "www.riverside-realty.example", "Tower B, EON Free Zone, Kharadi, Pune 411014", `ref ${nonce}`], FILES.cardNew);
  await card(["Anil Deshmukh", "Head of Workplace", "Marigold Loop Technologies Pvt Ltd", "M: +91 99230 11223", "anil.deshmukh@marigoldloop.example",
    "Baner Road, Pune 411045", `ref ${nonce}`], FILES.cardAnil);
  // quotation v1 (₹85) and the revised one (₹95) — two pages so page references show
  fs.writeFileSync(path.join(DIR, FILES.quote1), await pdf([
    ["Commercial quotation - Riverside One, Kharadi (demo)", "For: Marigold Loop Technologies", "Date: 3 March 2026", "Chargeable area: 20,000 sq ft (chargeable)",
      "Rent Rs. 85 per sq ft per month plus CAM.", "CAM Rs. 12 per sq ft per month.", `Ref ${nonce}`],
    ["Page 2 - other terms", "Security deposit: 6 months rent", "Lock-in: 36 months", "Escalation 5% every 12 months", "Valid till 31 December 2026."],
  ]));
  fs.writeFileSync(path.join(DIR, FILES.quote2), await pdf([
    ["Revised commercial quotation - Riverside One, Kharadi (demo)", "For: Marigold Loop Technologies", "Date: 9 November 2026", "Chargeable area: 20,000 sq ft (chargeable)",
      "Rent Rs. 95 per sq ft per month plus CAM.", "CAM Rs. 12 per sq ft per month.", `Ref ${nonce}`],
    ["Page 2 - other terms", "Security deposit: 6 months rent", "Lock-in: 36 months", "Valid till 31 January 2027."],
  ]));
  // voice note: a short tone (in practice mode there is no speech-to-text, so the video types what was said)
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${300 + (Number(nonce.slice(-3)) % 400)}:duration=4`, "-ac", "1", "-ar", "16000", path.join(DIR, FILES.voice)]);
  // contacts spreadsheet v1 and v2 (same name; v2 changes one value, drops one row, adds and moves columns)
  const H1 = ["Company Name", "Contact Person", "Designation", "Email ID", "Mobile No", "Area Reqd", "Preferred Location", "Lease Expiry", "Remarks"];
  const R1: (string | number | null)[][] = [
    ["Pebblewick Software", "Kavita Nair", "Admin Head", "kavita.nair@pebblewick.example", "+91 98201 33445", "15,000 sq ft", "Baner", "31/03/2027", "Wants options before Diwali"],
    ["Cobaltfern Systems", "Rahul Khanna", "VP Finance", "rahul.k@@cobaltfern.example", "98765 4321", "30000", "Kharadi", "04/05/2027", "Budget not shared"],
    ["Tamarind Stack Labs", "Sneha Patil", "Facilities Manager", "sneha.patil@tamarind.example", "+91 90110 22334", "8,000 sq ft", "Hinjewadi", "Dec 2027", null],
    ["Lanternfish Analytics", "Arjun Mehta", "CFO", "arjun.mehta@lanternfish.example", "+91 97300 55667", "12,000 sq ft carpet", "Viman Nagar", "30/09/2027", `import ${nonce}`],
  ];
  await sheet(path.join(DIR, FILES.sheet), H1, R1);
  const H2 = ["Company Name", "Contact Person", "Designation", "Mobile No", "Email ID", "Area Reqd", "Preferred Location", "Lease Expiry", "Budget (Rs/sf)", "Remarks"];
  const R2 = [
    ["Pebblewick Software", "Kavita Nair", "Admin Head", "+91 98201 33445", "kavita.nair@pebblewick.example", "18,000 sq ft", "Baner", "31/03/2027", "90", "Now needs 18k"],
    ["Tamarind Stack Labs", "Sneha Patil", "Facilities Manager", "+91 90110 22334", "sneha.patil@tamarind.example", "8,000 sq ft", "Hinjewadi", "Dec 2027", null, null],
    ["Lanternfish Analytics", "Arjun Mehta", "CFO", "+91 97300 55667", "arjun.mehta@lanternfish.example", "12,000 sq ft carpet", "Viman Nagar", "30/09/2027", null, `import ${nonce}`],
    ["Velvetbyte Digital", "Pooja Iyer", "HR Director", "+91 98900 77889", "pooja.iyer@velvetbyte.example", "6,500 sq ft", "Wakad", "31/12/2027", "75", "New lead"],
  ];
  await sheet(path.join(DIR, "v2", FILES.sheet), H2, R2);
  // batch of mixed files
  const B = path.join(DIR, "batch");
  fs.writeFileSync(path.join(B, FILES.batch[0]), await pdf([["Hinjewadi Tech Park - Tower C (demo brochure)", "Floor plates 32,000 sq ft", "Quoted rent Rs. 68 per sq ft per month, CAM extra", `Ref ${nonce}`]]));
  fs.writeFileSync(path.join(B, FILES.batch[1]), await Packer.toBuffer(new Document({ sections: [{ children: [
    "Site visit notes - Kharadi (demo)", "Visited Riverside One with Anil Deshmukh from Marigold Loop Technologies.", "They need around 20,000 sq ft by September. Parking for 60 cars is a must.",
    "Send revised layout options Friday.", `Ref ${nonce}`].map((t) => new Paragraph(t)) }] })));
  fs.writeFileSync(path.join(B, FILES.batch[2]), ["Company Name,Contact Person,Email ID,Mobile No,Preferred Location", "Nilgiri Cloudworks,Farhan Shaikh,farhan.shaikh@nilgiri.example,+91 98220 99881,Wakad",
    `Quokka Grid Infotech,Divya Rao,divya.rao@quokka.example,+91 90040 12312,Wakad`, `Ironmonsoon Capital,Nikhil Jain,nikhil.jain@ironmonsoon.example,+91 98903 45120,Baner ${nonce}`].join("\n"));
  await sheet(path.join(B, FILES.batch[3]), ["Company Name", "Contact Person", "Email ID", "Mobile No", "Area Reqd", "Preferred Location"],
    [["Saffron Abacus Bank", "Ritu Kapoor", "ritu.kapoor@saffron.example", "+91 98222 10101", "25,000 sq ft", "Baner"], ["Kestrelbay Payments", "Manish Gupta", "manish.gupta@kestrelbay.example", "+91 98500 20202", `10,000 sq ft ${nonce}`, "Baner"]]);
  fs.writeFileSync(path.join(B, FILES.batch[4]), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from(`legacy ${nonce}`.padEnd(504, " "))]));
  console.log(`files ok → ${DIR}`);
}

// ------------------------------------------------------------------------------------------------ jobs of the latest batch upload
async function jobs(args: string[]) {
  const { handlers: imp } = await import("@/modules/imports/jobs");
  const { handlers: cap } = await import("@/modules/capture/jobs");
  const { refreshRun } = await import("@/modules/imports/runs");
  const db = createAdminClient();
  const fi = args.indexOf("--fail-first"); const failName = fi >= 0 ? args[fi + 1] : null;
  const mi = args.indexOf("--max"); const max = mi >= 0 ? Number(args[mi + 1]) : 99;
  const [run] = (await must(db.from("import_run").select("id").eq("workspace_id", WS).order("created_at", { ascending: false }).limit(1))) as Row[];
  if (!run) { console.log("no run"); return; }
  const items = (await must(db.from("import_run_item").select("id, file_name, batch_id, capture_id, attempts").eq("workspace_id", WS).eq("run_id", run.id))) as Row[];
  const bIds = items.map((i) => i.batch_id).filter(Boolean); const cIds = items.map((i) => i.capture_id).filter(Boolean);
  const queued = ((await must(db.from("job").select("*").eq("workspace_id", WS).eq("state", "queued").in("job_type", ["imports.process", "capture.process"]).order("created_at"))) as Row[])
    .filter((j) => bIds.includes(j.payload?.batch_id) || cIds.includes(j.payload?.captureId));
  let done = 0;
  for (const j of queued) {
    if (done >= max) break;
    const item = items.find((i) => i.batch_id === j.payload?.batch_id || i.capture_id === j.payload?.captureId);
    if (failName && item?.file_name === failName && !(item.attempts > 0)) {
      // synthetic temporary failure (so "Retry failed file" has something to fix)
      await must(db.from("import_batch").update({ status: "failed", error: "Storage did not answer in time (timeout) — temporary, demo failure." }).eq("workspace_id", WS).eq("id", item.batch_id));
      await must(db.from("job").update({ state: "dead", last_error: "demo: temporary failure" }).eq("id", j.id));
    } else {
      try {
        const h = (imp as Row)[j.job_type] ?? (cap as Row)[j.job_type];
        await h({ ...j, workspace_id: WS });
        await must(db.from("job").update({ state: "succeeded", finished_at: new Date().toISOString() }).eq("id", j.id));
      } catch (e) { console.log("job failed", j.job_type, (e as Error).message); await db.from("job").update({ state: "dead", last_error: (e as Error).message.slice(0, 500) }).eq("id", j.id); }
    }
    done++;
  }
  await refreshRun(db as never, WS, run.id);
  console.log(`run ${run.id}: ${done} job(s)`);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const args = process.argv.slice(2);
  if (args[0] === "jobs") return jobs(args.slice(1));
  await data();
  await files();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
