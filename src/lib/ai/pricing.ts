/** Model pins and published rates from the spec (verified 23 Oct 2026). Change => bump PRICING_VERSION and rerun evals. */
export const PRICING_VERSION = "2026-10-23";

export type ModelTier = "luna" | "sol";

export const MODELS = {
  luna: process.env.OPENAI_MODEL_LUNA || "gpt-6-luna",       // routine extraction/classification
  sol: process.env.OPENAI_MODEL_SOL || "gpt-6.1-sol",        // difficult synthesis/review
  transcribe: process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe",
} as const;

export const PRICING = {
  luna: { inputPerM: 0.1, outputPerM: 0.5 },
  sol: { inputPerM: 2, outputPerM: 10 },
  webSearchPerCall: 0.01,
  transcribe: { perMinute: 0.003 },
  fxInrPerUsd: 90, // planning assumption, not a live rate
} as const;
