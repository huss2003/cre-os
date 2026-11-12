import "server-only";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Worker } from "tesseract.js";

/**
 * Free local OCR (tesseract.js, Apache-2.0) — no AI call, no network.
 * Language data comes from the npm packages @tesseract.js-data/eng and @tesseract.js-data/hin
 * (gzipped "fast" 4.0.0 models). Tesseract needs every language in ONE langPath folder, so on first
 * use the .gz files are copied into os.tmpdir()/cre-os-tessdata (writable on Vercel /tmp).
 * One worker per language set is kept warm and reused; calls are serialised per worker.
 * next.config: tesseract.js is a serverExternalPackage and the .gz files are traced into the function.
 */

export type OcrLang = "eng" | "hin";
export interface OcrWord { text: string; confidence: number }
export interface OcrResult { text: string; confidence: number; words: OcrWord[]; langs: OcrLang[]; ms: number }

const DATA_DIR = path.join(tmpdir(), "cre-os-tessdata");
const workers = new Map<string, Promise<Worker>>();
const queues = new Map<string, Promise<unknown>>();

async function prepareLangDir(langs: OcrLang[]) {
  await mkdir(DATA_DIR, { recursive: true });
  for (const l of langs) {
    const dest = path.join(DATA_DIR, `${l}.traineddata.gz`);
    try { await stat(dest); continue; } catch { /* copy below */ }
    // Resolve the data file by path (not require), so the bundler never tries to pack the model files.
    const src = path.join(process.cwd(), "node_modules", "@tesseract.js-data", l, "4.0.0", `${l}.traineddata.gz`);
    await copyFile(src, dest);
  }
  return DATA_DIR;
}

async function getWorker(langs: OcrLang[]): Promise<Worker> {
  const key = langs.join("+");
  let w = workers.get(key);
  if (!w) {
    w = (async () => {
      const langPath = await prepareLangDir(langs);
      const { createWorker } = await import("tesseract.js");
      return createWorker(langs, 1, { langPath, gzip: true, cacheMethod: "none" });
    })();
    workers.set(key, w);
    w.catch(() => workers.delete(key));
  }
  return w;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
}

/** OCR an image buffer (png/jpeg/webp/bmp/gif). confidence is 0–1 (tesseract's mean word confidence / 100). */
export async function ocrImage(image: Buffer | Uint8Array, opts: { langs?: OcrLang[]; timeoutMs?: number } = {}): Promise<OcrResult> {
  const langs = opts.langs?.length ? opts.langs : (["eng", "hin"] as OcrLang[]);
  const key = langs.join("+");
  const started = Date.now();
  const run = async () => {
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(Buffer.from(image), {}, { text: true, blocks: true });
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, confidence: w.confidence / 100 });
    const text = (data.text ?? "").replace(/[ \t]+\n/g, "\n").trim();
    return { text, confidence: text ? Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)) : 0, words, langs, ms: Date.now() - started };
  };
  const prev = queues.get(key) ?? Promise.resolve();
  const job = prev.catch(() => undefined).then(() => withTimeout(run(), opts.timeoutMs ?? 45_000, "local OCR"));
  queues.set(key, job.catch(() => undefined));
  try { return await job; } catch (e) {
    // A timed-out worker may be stuck: drop it so the next call starts fresh.
    if (/timed out/.test(String((e as Error).message))) { const w = workers.get(key); workers.delete(key); w?.then((x) => x.terminate()).catch(() => undefined); }
    throw e;
  }
}

/** Image types tesseract can read. HEIC is not supported locally. */
export function localOcrSupports(mime: string) { return /^image\/(png|jpe?g|webp|bmp|gif)$/i.test(mime); }

/** Stop all workers (tests / graceful shutdown). */
export async function terminateOcr() {
  const all = [...workers.values()]; workers.clear(); queues.clear();
  await Promise.all(all.map((w) => w.then((x) => x.terminate()).catch(() => undefined)));
}
