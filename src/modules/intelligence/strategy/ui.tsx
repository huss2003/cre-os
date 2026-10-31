import Link from "next/link";
import type { FactRef } from "./strategist";

/* Strategist presentational helpers (server-safe). Every recommendation shows the recorded facts it rests on and its assumptions. */

const href = (f: FactRef, oppId: string): string | null => {
  if (!f.id) return null;
  if (f.kind === "stakeholder" || f.kind === "stage" || f.kind === "objection" || f.kind === "opportunity") return `/deals/${oppId}`;
  if (f.kind === "requirement") return `/requirements/${f.id}`;
  return null;
};

export function Basis({ basis, assumptions, oppId }: { basis: FactRef[]; assumptions?: string[]; oppId: string }) {
  if (!basis.length && !assumptions?.length) return null;
  return (
    <div className="mt-0.5 space-y-0.5 text-xs text-ink-soft">
      {basis.length > 0 && (
        <div className="break-words"><span className="font-medium">Based on:</span>{" "}
          {basis.map((b, i) => {
            const h = href(b, oppId);
            return <span key={i}>{i ? "; " : ""}{h ? <Link className="text-brand" href={h}>{b.label}</Link> : b.label}</span>;
          })}
        </div>
      )}
      {assumptions && assumptions.length > 0 && <div className="break-words text-warn"><span className="font-medium">Assumption:</span> {assumptions.join(" ")}</div>}
    </div>
  );
}
