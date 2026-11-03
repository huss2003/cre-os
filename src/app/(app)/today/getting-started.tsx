import Link from "next/link";
import type { AppContext } from "@/lib/auth/context";

/**
 * Five-step guide shown on Today until the workspace has gone once through the core journey:
 * import data -> review -> requirement -> shortlist -> document. Each step links to the screen that does it.
 * Counts only (head requests in parallel), RLS-scoped to what this user can see.
 */
export async function GettingStarted({ ctx }: { ctx: AppContext }) {
  const head = (table: string) => ctx.db.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", ctx.workspaceId);
  const [imports, pending, reqs, shortlists, docs] = await Promise.all([
    head("import_batch"),
    head("change_proposal").in("state", ["proposed", "clarify"]),
    head("requirement").is("archived_at", null),
    head("shortlist_version"),
    head("document_version"),
  ]);
  const n = (r: { count: number | null }) => r.count ?? 0;
  const steps = [
    { done: n(imports) > 0, title: "Import your data", why: "Upload the building, lease and transaction Excel files.", href: "/imports", cta: "Open Imports" },
    { done: n(imports) > 0 && n(pending) === 0, title: "Review what the import found", why: n(pending) > 0 ? `${n(pending)} item(s) waiting for your approval.` : "Approve matches and conflicts.", href: "/approvals", cta: "Open Review" },
    { done: n(reqs) > 0, title: "Add a client requirement", why: "Area, budget, locations, dates — leave unknowns blank.", href: "/requirements/new", cta: "New requirement" },
    { done: n(shortlists) > 0, title: "Run a shortlist", why: "Open the requirement and press Run shortlist.", href: "/requirements", cta: "Open Requirements" },
    { done: n(docs) > 0, title: "Generate a proposal or deck", why: "Pick the requirement and generate an editable document.", href: "/documents", cta: "Open Documents" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="rounded-xl border border-brand/30 bg-brand/5 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Getting started</h2>
        <span className="text-xs text-ink-soft">{doneCount} of {steps.length} done</span>
      </div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-start gap-3">
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? "bg-ok text-white" : i === next ? "bg-brand text-white" : "bg-line text-ink-soft"}`}>{s.done ? "✓" : i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-medium ${s.done ? "text-ink-soft line-through" : ""}`}>{s.title}</div>
              {!s.done ? <div className="text-xs text-ink-soft">{s.why}</div> : null}
            </div>
            {!s.done && i === next ? <Link href={s.href} className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white">{s.cta}</Link> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
