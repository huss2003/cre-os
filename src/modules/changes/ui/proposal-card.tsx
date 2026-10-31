import Link from "next/link";
import { Badge, Input, StaleBanner } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import { RiskBadge, StateBadge, show } from "@/modules/capture/ui/parts";
import { ActionForm, Submit } from "./client";
import { decideAction, editAction, undoAction } from "../actions";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

export interface CardProposal {
  id: string; target_type: string; target_id: string | null; operation: string; risk: string; state: string; reason: string | null;
  patch: { op: string; path: string; value?: unknown }[]; before: AnyRow | null; proposed_by_kind: string; model?: string | null;
  capture_id: string | null; created_at: string; expected_version: number | null; approval_required: boolean;
  target_label?: string | null; current?: Record<string, unknown> | null; current_version?: number | null; stale?: boolean;
}

const OPEN = ["proposed", "approved", "clarify"];

/** Before/after approval card with approve / reject / clarify / edit and (for applied changes) undo. */
export function ProposalCard({ p, role, selectable = false }: { p: CardProposal; role: "owner" | "admin" | "editor" | "viewer"; selectable?: boolean }) {
  const isAdmin = role === "owner" || role === "admin";
  const canDecide = isAdmin || (role === "editor" && p.risk === "routine_internal");
  const snap = (p.before?.kind === "proposal_snapshot" ? p.before.fields : p.before?.fields) ?? {};
  const rows = p.operation === "merge"
    ? [{ path: "/loser_id", before: "separate records", value: `merge into ${p.target_label ?? p.target_id}` }]
    : p.patch.map((op) => {
        const f = op.path.replace(/^\//, "");
        return { path: op.path, before: p.current && f in p.current ? p.current[f] : snap[f], value: op.op === "remove" ? null : op.value };
      });
  const title = `${p.operation === "create" ? "New " : ""}${p.target_type.replace(/_/g, " ")}${p.target_label ? `: ${p.target_label}` : ""}`;
  return (
    <article className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        {selectable ? <input type="checkbox" name="ids" value={p.id} form="batch-undo" aria-label="Select for batch undo" className="size-4" /> : null}
        <h3 className="font-medium">{title}</h3>
        <RiskBadge risk={p.risk} /><StateBadge state={p.state} />
        {p.proposed_by_kind !== "user" ? <Badge tone="accent">{p.proposed_by_kind === "model" ? "AI extracted" : "job"}</Badge> : null}
      </header>
      {p.stale ? <div className="mb-2"><StaleBanner>The record changed since this was proposed (version {p.expected_version} → {p.current_version}). Applying will be refused; edit or re-propose against the current values.</StaleBanner></div> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[18rem] text-sm">
          <thead><tr className="text-left text-xs text-ink-soft"><th className="py-1 pr-2 font-medium">Field</th><th className="py-1 pr-2 font-medium">Now</th><th className="py-1 font-medium">Proposed</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.path} className="border-t border-line align-top">
              <td className="py-1.5 pr-2 font-mono text-xs">{r.path.slice(1)}</td>
              <td className="py-1.5 pr-2 text-ink-soft">{show(r.before)}</td>
              <td className="py-1.5 font-medium">{show(r.value)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="mt-2 text-sm text-ink-soft">{p.reason ?? "No reason given"}
        {p.capture_id ? <> · <Link className="text-brand" href={`/capture/${p.capture_id}`}>evidence: capture</Link></> : null}
        {" · "}{fmt(p.created_at)}</p>

      {OPEN.includes(p.state) && role !== "viewer" ? (
        <div className="mt-3 space-y-2">
          {canDecide ? (
            <ActionForm action={decideAction} className="space-y-2">
              <input type="hidden" name="id" value={p.id} />
              <Input name="note" placeholder="Note (optional; required for clarify)" aria-label="Decision note" />
              <div className="flex flex-wrap gap-2">
                {p.state === "approved" ? <Submit name="op" value="apply">Apply</Submit> : <Submit name="op" value="approve_apply">Approve &amp; apply</Submit>}
                {p.state !== "approved" ? <Submit name="op" value="approve" variant="secondary">Approve only</Submit> : null}
                <Submit name="op" value="clarify" variant="secondary">Ask to clarify</Submit>
                <Submit name="op" value="reject" variant="danger" confirm="Reject this change?">Reject</Submit>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-ink-soft">{p.risk === "high_value" ? "High-value" : p.risk === "identity_merge" ? "Merges" : "Material"} changes need an admin or owner to approve.</p>
          )}
          {["create", "update", "link"].includes(p.operation) ? (
            <details className="rounded-lg border border-line p-2">
              <summary className="cursor-pointer text-sm text-brand">Edit proposed values</summary>
              <ActionForm action={editAction} className="mt-2 space-y-2">
                <input type="hidden" name="id" value={p.id} />
                {p.patch.map((op) => (
                  <label key={op.path} className="block text-xs">
                    <span className="font-mono">{op.path.slice(1)}</span>
                    <input type="hidden" name="path" value={op.path} />
                    <Input name={`value:${op.path}`} defaultValue={typeof op.value === "string" ? op.value : JSON.stringify(op.value ?? null)} />
                  </label>
                ))}
                <p className="text-xs text-ink-soft">Numbers and lists as JSON (e.g. 20000 or a list of ids). Editing invalidates any approval.</p>
                <Submit variant="secondary">Save edit</Submit>
              </ActionForm>
            </details>
          ) : null}
        </div>
      ) : null}

      {["applied", "conflict"].includes(p.state) && role !== "viewer" ? (
        <ActionForm action={undoAction} className="mt-3">
          <input type="hidden" name="id" value={p.id} />
          <Submit variant="secondary" confirm="Undo this change? Fields edited since will be kept and reported.">Undo</Submit>
        </ActionForm>
      ) : null}
    </article>
  );
}
