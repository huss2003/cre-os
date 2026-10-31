/**
 * Shared primitives for the synthetic demo dataset: fixed identifiers, deterministic UUIDs,
 * a seeded PRNG and date helpers. Nothing here touches the database.
 *
 * EVERYTHING generated from these helpers is SYNTHETIC. Company names, people, buildings,
 * leases, rents and market numbers are invented for sales demos and UI testing.
 */
import { createHash } from "node:crypto";
import { atLocal, edate, localDate } from "../../src/lib/util/time";

export { edate };

// ------------------------------------------------------------------ fixed identifiers
/** The ONLY workspace this tooling ever writes to or deletes. */
export const DEMO_WORKSPACE_ID = "de000000-0000-4000-8000-000000000001";
export const DEMO_SLUG = "demo-pune";
export const DEMO_NAME = "Demo — Pune CRE (synthetic)";
export const SEED_VERSION = "demo-synthetic-v1";

/** owner@cre-os.local from supabase/seed.sql */
export const OWNER_USER_ID = "00000000-0000-4000-8000-000000000001";

/** Real tenant workspaces — the demo tooling refuses to run if the demo id ever collides with these. */
export const PROTECTED_WORKSPACE_IDS = [
  "10000000-0000-4000-8000-000000000001", // WS1 (real tenant, must stay empty until the owner imports)
  "10000000-0000-4000-8000-000000000002", // WS2
];

export const SYNTHETIC_NOTE = "SYNTHETIC DEMO DATA — invented for demos/testing; not a real person, company or deal.";

// ------------------------------------------------------------------ deterministic UUIDs (RFC 4122 v5)
const NAMESPACE = "8b0f4a52-6c1e-5d3a-9e77-0de5eed0a7a1";
const nsBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");

/** Stable UUID for (kind, key). Same inputs => same id on every run => upserts never duplicate. */
export function did(kind: string, key: string | number): string {
  const h = createHash("sha1").update(nsBytes).update(`${DEMO_WORKSPACE_ID}|${kind}|${key}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ------------------------------------------------------------------ seeded PRNG (mulberry32)
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export class Rng {
  private s: number;
  constructor(seed: string) {
    this.s = hashSeed(`${SEED_VERSION}:${seed}`);
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  float(min: number, max: number, dp = 2): number {
    return Number((min + this.next() * (max - min)).toFixed(dp));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  sample<T>(arr: readonly T[], n: number): T[] {
    return this.shuffle(arr).slice(0, n);
  }
  /** round to a step, e.g. 500 sf */
  step(min: number, max: number, step: number): number {
    return Math.round(this.float(min, max, 4) / step) * step;
  }
}

// ------------------------------------------------------------------ dates (all date-only values are IST calendar dates)
export function todayIst(): string {
  return localDate(new Date());
}
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Instant (ISO, UTC) for an IST wall-clock time on a date. */
export function ist(date: string, hhmm: string): string {
  return atLocal(date, hhmm).toISOString();
}
export function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

// ------------------------------------------------------------------ row plumbing
export type Classification = "public" | "permitted_personal" | "corporate_confidential" | "licensed_restricted";
export type Row = Record<string, unknown>;
export interface TableBatch {
  table: string;
  rows: Row[];
}

/** Standard business-table columns. workspace_id is ALWAYS the demo workspace. */
export function base(classification: Classification = "corporate_confidential"): Row {
  return { workspace_id: DEMO_WORKSPACE_ID, owner_user_id: OWNER_USER_ID, classification };
}

/** Context passed to every generator. */
export interface GenContext {
  today: string; // YYYY-MM-DD (IST)
  sourceObjectId: string; // the single synthetic source_object every evidence-bearing row points at
}
