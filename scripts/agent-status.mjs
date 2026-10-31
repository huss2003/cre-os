// Collects build progress per agent from the repo itself (what exists on disk), writes /tmp/agent-status.json.
// Progress = weighted checklist of each module's definition of done. ETA = remaining % / observed rate (estimate).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = "/home/claude/cre-os";
const STATE = path.join(ROOT, ".agent-state.json");          // coordinator-maintained: finished/stopped flags, start times
const HIST = path.join(ROOT, ".agent-status-history.json");  // progress snapshots for rate estimation
const now = Date.now();
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const hist = fs.existsSync(HIST) ? JSON.parse(fs.readFileSync(HIST, "utf8")) : [];

const MODULES = {
  imports: { title: "Imports & data matching", pages: ["imports"], apis: ["api/v1/imports"], mig: "0010" },
  capture: { title: "Capture & approvals", pages: ["capture", "approvals"], apis: ["api/v1/captures", "api/v1/changes"], mig: "0011", extra: ["src/modules/changes"],
             security: { label: "Critical approval-forgery fix", test: () => grepMig("0011", /propose_change/i) } },
  brief: { title: "Today, 08:00 brief & scoring", pages: ["today", "tasks", "leases"], apis: ["api/v1/briefs", "api/v1/tasks"], mig: "0012" },
  deals: { title: "Deals, finance & documents", pages: ["requirements", "deals", "finance", "documents", "fees"], apis: ["api/v1/requirements", "api/v1/finance", "api/v1/documents", "api/v1/opportunities"], mig: "0013" },
  integrations: { title: "Email, calendar & drafts", pages: ["drafts", "calendar", "settings/connections"], apis: ["api/v1/drafts", "api/oauth", "api/v1/calendar"], mig: "0014",
             security: { label: "Draft self-approval fix", test: () => grepMig("0014", /content_hash[\s\S]{0,400}(trigger|before (insert|update))|create trigger [a-z_]*draft/i) } },
  intelligence: { title: "Research, network, legal & insights", pages: ["research", "network", "market", "legal", "content", "insights"], apis: ["api/v1/research", "api/v1/legal", "api/v1/market", "api/v1/content", "api/v1/insights"], mig: "0015" },
  admin: { title: "Search, records, settings & admin", pages: ["search", "companies", "people", "buildings", "settings", "admin", "platform"], apis: ["api/v1/search", "api/v1/admin"], mig: "0016",
             security: { label: "Search name-leak fix", test: () => grepMig("0016", /alias_matches[\s\S]{0,600}security invoker/i) } },
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push({ p, m: fs.statSync(p).mtimeMs });
  }
  return out;
}
function migFiles(prefix) {
  return fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.startsWith("2026103100" + prefix.slice(2)) || f.startsWith("20261031" + prefix)).map((f) => path.join(ROOT, "supabase/migrations", f));
}
function grepMig(prefix, re) {
  return migFiles(prefix).some((f) => re.test(fs.readFileSync(f, "utf8")));
}
function friendly(p) {
  const r = p.replace(ROOT + "/", "");
  let m;
  if ((m = r.match(/src\/app\/\(app\)\/(.+?)\/(page|actions|layout)\.tsx?$/))) return `${m[1]} page${m[2] === "actions" ? " (actions)" : ""}`;
  if ((m = r.match(/src\/app\/(api\/.+)\/route\.ts$/))) return `${m[1]} endpoint`;
  if ((m = r.match(/supabase\/migrations\/(.+)\.sql$/))) return `database migration`;
  if (/\.test\.ts$/.test(r)) return `tests: ${path.basename(r)}`;
  if (/README\.md$/.test(r)) return "README";
  return r.replace(/^src\/modules\//, "").replace(/\.(ts|tsx)$/, "");
}

const rows = [];
for (const [key, mod] of Object.entries(MODULES)) {
  const owned = [
    ...walk(path.join(ROOT, "src/modules", key)),
    ...(mod.extra ?? []).flatMap((d) => walk(path.join(ROOT, d))),
    ...mod.pages.flatMap((pg) => walk(path.join(ROOT, "src/app/(app)", pg)).filter((f) => key === "admin" && pg === "settings" ? !f.p.includes("/settings/connections") : true)),
    ...mod.apis.flatMap((a) => walk(path.join(ROOT, "src/app", a))),
    ...migFiles(mod.mig).map((p) => ({ p, m: fs.statSync(p).mtimeMs })),
  ];
  const pagesBuilt = mod.pages.filter((pg) => fs.existsSync(path.join(ROOT, "src/app/(app)", pg, "page.tsx"))).length;
  const apisBuilt = mod.apis.filter((a) => walk(path.join(ROOT, "src/app", a)).some((f) => f.p.endsWith("route.ts"))).length;
  const tests = owned.filter((f) => /\.test\.ts$/.test(f.p)).length;
  const services = owned.filter((f) => f.p.includes("/src/modules/") && /\.tsx?$/.test(f.p) && !/\.test\.ts$/.test(f.p) && !f.p.endsWith("/jobs.ts")).length;
  const hasMig = migFiles(mod.mig).length > 0;
  const readme = fs.existsSync(path.join(ROOT, "src/modules", key, "README.md"));
  const sec = mod.security ? (mod.security.test() ? "fixed" : "pending") : "n/a";

  let pct = (hasMig ? 10 : 0) + Math.min(services / 10, 1) * 15 + (pagesBuilt / mod.pages.length) * 35 +
            (apisBuilt / mod.apis.length) * 15 + Math.min(tests / 4, 1) * 15 + (readme ? 10 : 0);
  if (sec === "pending") pct = Math.min(pct, 90);
  const st = state[key] ?? {};
  let status = st.status ?? "running";
  if (status === "finished") pct = Math.max(pct, 100);
  pct = Math.round(Math.min(pct, 100));

  const last = owned.reduce((a, f) => Math.max(a, f.m), 0);
  const idleMin = last ? Math.round((now - last) / 60000) : null;
  const recent = owned.filter((f) => now - f.m < 15 * 60000).sort((a, b) => b.m - a.m).slice(0, 3).map((f) => friendly(f.p));
  const doing = status === "finished" ? "Finished — report received" : status === "stopped" ? "Stopped" :
    recent.length ? `Working on ${[...new Set(recent)].join(", ")}` : idleMin !== null && idleMin > 15 ? "Reading / running tests (no file changes in 15+ min)" : "Starting up";

  // ETA from progress rate over the last 30 minutes of snapshots
  const past = hist.filter((h) => h.agents?.[key] !== undefined && now - h.t <= 35 * 60000 && now - h.t >= 8 * 60000).sort((a, b) => a.t - b.t)[0];
  let eta = null;
  if (status === "finished") eta = 0;
  else if (past && pct > past.agents[key]) {
    const rate = (pct - past.agents[key]) / ((now - past.t) / 60000); // % per minute
    eta = Math.round(Math.min(240, (100 - pct) / rate));
  }
  rows.push({
    agent: key, area: mod.title, status, progress: pct,
    eta_minutes: eta, eta_label: status === "finished" ? "done" : eta === null ? "estimating" : `~${eta} min`,
    doing,
    last_change_min_ago: idleMin,
    pages: `${pagesBuilt}/${mod.pages.length}`, pages_built: pagesBuilt, pages_expected: mod.pages.length,
    api: `${apisBuilt}/${mod.apis.length}`, tests, service_files: services,
    migration: hasMig ? "yes" : "no", readme: readme ? "yes" : "no", security_fix: sec,
    started: st.started ?? "15:02",
  });
}
for (const [key, title] of [["docs", "Docs & handover pack"], ["security", "Security review & tests"], ["demo", "Demo data seeder"]]) {
  rows.push({ agent: key, area: title, status: "finished", progress: 100, eta_minutes: 0, eta_label: "done", doing: "Finished — report received",
    last_change_min_ago: null, pages: "—", pages_built: 0, pages_expected: 0, api: "—", tests: key === "security" ? 8 : 0, service_files: 0,
    migration: "—", readme: "—", security_fix: "n/a", started: "14:20" });
}

hist.push({ t: now, agents: Object.fromEntries(rows.map((r) => [r.agent, r.progress])) });
fs.writeFileSync(HIST, JSON.stringify(hist.slice(-200)));
const ist = new Date(now + 330 * 60000).toISOString().replace("T", " ").slice(0, 16) + " IST";
const out = { generated_at: new Date(now).toISOString(), generated_ist: ist, rows };
for (const r of rows) r.snapshot_ist = ist;
fs.writeFileSync("/home/claude/agent-status.json", JSON.stringify(rows, null, 1));
console.log(JSON.stringify({ ist, summary: rows.map((r) => `${r.agent}:${r.progress}%/${r.eta_label}`) }));
