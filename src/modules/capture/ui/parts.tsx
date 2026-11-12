import { Badge } from "@/components/ui";

const STATUS: Record<string, [string, "neutral" | "brand" | "ok" | "warn" | "bad"]> = {
  received: ["Received", "neutral"], transcribing: ["Transcribing", "brand"], extracting: ["Extracting", "brand"],
  needs_review: ["Needs review", "warn"], reviewed: ["Reviewed", "ok"], failed: ["Failed", "bad"],
};
export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}

const RISK: Record<string, [string, "neutral" | "brand" | "ok" | "warn" | "bad" | "accent"]> = {
  routine_internal: ["Routine", "neutral"], material_fact: ["Material", "warn"], identity_merge: ["Merge", "accent"],
  high_value: ["High value", "bad"], external_message: ["External message", "brand"],
};
export function RiskBadge({ risk }: { risk: string }) {
  const [label, tone] = RISK[risk] ?? [risk, "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}

const STATE: Record<string, "neutral" | "brand" | "ok" | "warn" | "bad"> = {
  proposed: "warn", approved: "brand", clarify: "warn", applied: "ok", rejected: "neutral", reversed: "neutral", conflict: "bad", expired: "neutral",
};
export function StateBadge({ state }: { state: string }) {
  const label: Record<string, string> = { proposed: "Awaiting review", clarify: "Needs clarification", conflict: "Conflict" };
  return <Badge tone={STATE[state] ?? "neutral"}>{label[state] ?? (state ? state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, " ") : "—")}</Badge>;
}

export function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "number") return v.toLocaleString("en-IN");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
