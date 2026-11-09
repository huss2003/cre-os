import Link from "next/link";
import { decideMatchAction } from "@/app/(app)/imports/actions";

export type Dup = { id: string; entity_type: string; left_id: string; right_id: string; right_raw: Record<string, string>; score: number; suggested: string; decision: string; change_proposal_id: string | null };
type SP = Record<string, string | string[] | undefined>;

const TYPE: Record<string, string> = { organisation: "Company", asset: "Building", person: "Person", geography: "Place" };
const LINK: Record<string, string> = { organisation: "/companies", asset: "/buildings", person: "/people" };
const STATUS: Record<string, [string, string]> = {
  pending: ["Pending", "bg-warn/15 text-warn"], merge_proposed: ["Merge sent", "bg-ok/15 text-ok"], related: ["Linked", "bg-ok/15 text-ok"],
  kept_separate: ["Kept separate", "bg-brand-soft text-brand"], auto_linked: ["Auto-linked", "bg-ok/15 text-ok"],
};
const PER = 10;
const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function Icon({ k, c = "h-5 w-5" }: { k: string; c?: string }) {
  const p: Record<string, React.ReactNode> = {
    organisation: <><path d="M4 21V5l7-2v18M11 9h6l3 2v10M8 8h0M8 12h0M8 16h0M15 14h2M15 18h2" /></>,
    asset: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>,
    person: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>,
    star: <><path d="M12 3l2 6 6 .5-4.6 4 1.4 6.5L12 16.8 7.2 20l1.4-6.5L4 9.5 10 9z" /></>,
    swap: <><path d="M7 7h13l-3-3M17 17H4l3 3" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
    pin: <><path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  };
  return <svg viewBox="0 0 24 24" className={c} {...S} aria-hidden>{p[k] ?? p.organisation}</svg>;
}

export function DuplicatesPanel({ all, batchId, sp, basePath }: { all: Dup[]; batchId: string; sp: SP; basePath: string }) {
  const q = typeof sp.dq === "string" ? sp.dq.trim().toLowerCase() : "";
  const type = typeof sp.dtype === "string" ? sp.dtype : "";
  const status = typeof sp.dstatus === "string" ? sp.dstatus : "pending";
  const sort = sp.dsort === "low" ? "low" : "high";
  const page = Math.max(1, Number(sp.dpage) || 1);

  const pending = all.filter((m) => m.decision === "pending").length;
  const merged = all.filter((m) => ["merge_proposed", "related", "auto_linked"].includes(m.decision)).length;
  const kept = all.filter((m) => m.decision === "kept_separate").length;
  const avg = all.length ? all.reduce((a, m) => a + Number(m.score), 0) / all.length : 0;
  const reviewed = all.length - pending;

  const list = all
    .filter((m) => !type || m.entity_type === type)
    .filter((m) => status === "all" || (status === "pending" ? m.decision === "pending" : m.decision !== "pending"))
    .filter((m) => !q || `${m.right_raw?.left_name ?? ""} ${m.right_raw?.name ?? ""} ${m.right_raw?.locality ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => (sort === "high" ? b.score - a.score : a.score - b.score));
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const cur = Math.min(page, pages);
  const shown = list.slice((cur - 1) * PER, cur * PER);
  const types = [...new Set(all.map((m) => m.entity_type))];
  const url = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("dq", q); if (type) u.set("dtype", type); if (status !== "pending") u.set("dstatus", status); if (sort !== "high") u.set("dsort", sort);
    u.set("dpage", String(p));
    return `${basePath}?${u.toString()}#identity`;
  };
  const tile = (icon: string, n: string | number, label: string, bg: string, fg: string) => (
    <div className={`flex items-center gap-4 rounded-2xl p-4 ${bg}`}>
      <span className={`grid h-12 w-12 place-items-center rounded-xl bg-white/70 ${fg}`}><Icon k={icon} c="h-6 w-6" /></span>
      <div><p className="text-2xl font-bold leading-none">{n}</p><p className="mt-1 text-sm text-ink-soft">{label}</p></div>
    </div>
  );
  const sel = "min-h-11 rounded-xl border border-line bg-surface px-3 text-sm";

  return (
    <section id="identity" className="mt-4 rounded-3xl border border-line bg-surface p-5 sm:p-6">
      {/* Header + progress */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-soft text-brand"><Icon k="asset" c="h-7 w-7" /></span>
          <div><h2 className="text-xl font-bold">Possible duplicates</h2><p className="text-sm text-ink-soft">Decide whether to merge each pair or keep them separate.</p></div>
        </div>
        <div className="w-full lg:w-96">
          <div className="flex justify-between text-sm"><span className="font-semibold">{pending} to decide</span><span className="text-ink-soft">{reviewed} / {all.length} reviewed</span></div>
          <div className="mt-2 h-2 rounded-full bg-line"><div className="h-2 rounded-full bg-brand" style={{ width: `${all.length ? (reviewed / all.length) * 100 : 0}%` }} /></div>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tile("copy", pending, "Pending review", "bg-brand-soft/60", "text-brand")}
        {tile("check", merged, "Merged / linked", "bg-ok/10", "text-ok")}
        {tile("asset", kept, "Kept separate", "bg-sky-50", "text-sky-600")}
        {tile("star", avg.toFixed(2), "Avg. match score", "bg-warn/10", "text-warn")}
      </div>

      {/* Filters */}
      <form method="get" action={`${basePath}#identity`} className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <label className="relative flex-1 sm:min-w-64">
          <span className="sr-only">Search duplicates</span>
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft"><Icon k="search" c="h-4 w-4" /></span>
          <input name="dq" defaultValue={q} placeholder="Search company, building or place…" className="min-h-11 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm" />
        </label>
        <select name="dtype" defaultValue={type} aria-label="Type" className={sel}><option value="">All types</option>{types.map((t) => <option key={t} value={t}>{TYPE[t] ?? t}</option>)}</select>
        <select name="dstatus" defaultValue={status} aria-label="Status" className={sel}><option value="pending">Status: Pending</option><option value="done">Status: Decided</option><option value="all">Status: All</option></select>
        <select name="dsort" defaultValue={sort} aria-label="Sort" className={sel}><option value="high">Score: High to low</option><option value="low">Score: Low to high</option></select>
        <button className="min-h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-white">Apply</button>
      </form>

      {/* List header + pager */}
      <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-sm">
        <p><span className="font-semibold">{list.length} pairs</span><span className="text-ink-soft"> · sorted by match score ({sort === "high" ? "high to low" : "low to high"})</span></p>
        <div className="flex items-center gap-2 text-ink-soft">
          <span>{list.length ? `${(cur - 1) * PER + 1}–${Math.min(cur * PER, list.length)} of ${list.length}` : "0"}</span>
          {cur > 1 ? <Link href={url(cur - 1)} className="grid h-9 w-9 place-items-center rounded-lg border border-line" aria-label="Previous page">‹</Link> : <span className="grid h-9 w-9 place-items-center rounded-lg border border-line opacity-40">‹</span>}
          {cur < pages ? <Link href={url(cur + 1)} className="grid h-9 w-9 place-items-center rounded-lg border border-line" aria-label="Next page">›</Link> : <span className="grid h-9 w-9 place-items-center rounded-lg border border-line opacity-40">›</span>}
        </div>
      </div>

      {/* Rows */}
      {shown.length === 0 ? <p className="mt-4 rounded-2xl bg-canvas p-6 text-center text-sm text-ink-soft">{all.length ? "Nothing matches these filters." : "No look-alike names found in this file."}</p> : (
        <ul className="mt-3 space-y-3">
          {shown.map((m) => {
            const [label, cls] = STATUS[m.decision] ?? [m.decision, "bg-canvas text-ink-soft"];
            const related = m.suggested === "relate_group" || m.suggested === "relate_campus";
            const href = (id: string) => `${LINK[m.entity_type] ?? "/search"}/${id}`;
            const Name = ({ id, text, place }: { id: string; text: string; place?: string }) => (
              <Link href={href(id)} className="flex min-h-14 flex-1 items-center gap-3 rounded-xl bg-brand-soft/40 px-3 py-2 text-sm font-medium hover:text-brand">
                <span className="text-brand"><Icon k={m.entity_type} /></span>
                <span>{text}{place ? <span className="ml-1 inline-flex items-center gap-0.5 text-xs font-normal text-ink-soft">· <Icon k="pin" c="h-3 w-3" />{place}</span> : null}</span>
              </Link>
            );
            return (
              <li key={m.id} className="flex flex-col gap-3 rounded-2xl border border-line p-3 lg:flex-row lg:items-center">
                <div className="flex items-center gap-3 lg:w-48 lg:border-r lg:border-line lg:pr-3">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><Icon k={m.entity_type} /></span>
                  <div>
                    <div className="flex items-center gap-2"><span className="text-xs font-semibold uppercase">{TYPE[m.entity_type] ?? m.entity_type}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span></div>
                    <p className="mt-1 text-xs text-ink-soft">Match <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-semibold text-brand">{Number(m.score).toFixed(2)}</span></p>
                  </div>
                </div>
                <div className="flex flex-1 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  <Name id={m.left_id} text={m.right_raw?.left_name ?? "Saved record"} />
                  <span className="self-center text-ink-soft"><Icon k="swap" c="h-4 w-4" /></span>
                  <Name id={m.right_id} text={m.right_raw?.name ?? "From file"} place={m.right_raw?.locality} />
                </div>
                {m.decision === "pending" ? (
                  <form action={decideMatchAction} className="flex gap-2">
                    <input type="hidden" name="batch_id" value={batchId} />
                    <input type="hidden" name="candidate_id" value={m.id} />
                    <button type="submit" name="decision" value={related ? "related" : "link"} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong lg:flex-none">
                      <Icon k="swap" c="h-4 w-4" />{related ? (m.suggested === "relate_campus" ? "Link to campus" : "Same group") : "Same — merge"}
                    </button>
                    <button type="submit" name="decision" value="keep_separate" className="min-h-11 flex-1 rounded-xl border border-line px-4 text-sm font-semibold hover:border-brand/40 lg:flex-none">Keep separate</button>
                  </form>
                ) : m.change_proposal_id ? <Link href="/approvals" className="text-sm text-brand underline">Waiting in Review</Link> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
