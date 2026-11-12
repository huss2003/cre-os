import "server-only";
import { extractImageText } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import { localOcrSupports, ocrImage, type OcrResult } from "@/lib/ocr/local";

/**
 * Photo / screenshot / business-card text (feature capture.ocr, docs/ai-policy.md): free local OCR (tesseract.js, eng+hin)
 * first; AI vision only when the mode is backup/on AND local OCR read nothing or read it with low confidence.
 * The text is untrusted evidence either way.
 */
export const LOCAL_OCR_MODEL = "tesseract-local";
/** Mean word confidence (0–1) at or above which local OCR is trusted without AI. */
export const OCR_MIN_CONFIDENCE = 0.6;

export interface PolicyOcrResult { text: string; mocked: boolean; model: string; confidence: number | null; source: "code" | "ai" | "none" }
type LocalOcr = (image: Uint8Array, mime: string) => Promise<Pick<OcrResult, "text" | "confidence"> | null>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { from: (t: string) => any };

export const defaultLocalOcr: LocalOcr = async (image, mime) => {
  if (!localOcrSupports(mime)) return null;
  try { return await ocrImage(image, { langs: ["eng", "hin"] }); } catch { return null; }
};

export function ocrAccept(r: { text: string; confidence: number | null }) {
  return r.text.replace(/\s/g, "").length >= 3 && (r.confidence ?? 0) >= OCR_MIN_CONFIDENCE;
}

export async function ocrWithPolicy(a: {
  db: DbLike | null; workspaceId: string; image: Uint8Array; mimeType: string; workflow: "capture.ocr" | "capture.document_ocr";
  hint: string; classification?: string; mock?: () => string; mode?: AiMode; local?: LocalOcr;
}): Promise<PolicyOcrResult> {
  const mode = a.mode ?? (a.db ? await getAiMode(a.db, a.workspaceId, a.workflow) : "backup");
  const local = a.local ?? defaultLocalOcr;
  let localRead: PolicyOcrResult | null = null;
  const out = await runWithPolicy<PolicyOcrResult>({
    mode,
    code: async () => {
      const r = await local(a.image, a.mimeType);
      localRead = r ? { text: r.text, confidence: r.confidence, mocked: false, model: LOCAL_OCR_MODEL, source: "code" } : null;
      return localRead;
    },
    accept: ocrAccept,
    ai: async () => {
      const r = await extractImageText({ workspaceId: a.workspaceId, image: a.image, mimeType: a.mimeType, workflow: a.workflow, hint: a.hint,
        classification: a.classification as never, mock: a.mock });
      const prev = localRead as PolicyOcrResult | null;
      // No API key (mock): keep a low-confidence local read rather than the mock's empty/typed text.
      if (r.mocked && prev?.text.trim()) return prev;
      return { text: r.text, mocked: r.mocked, model: r.model, confidence: null, source: "ai" };
    },
  });
  return out.value ?? { text: "", mocked: false, model: LOCAL_OCR_MODEL, confidence: null, source: "none" };
}
