// Local "fast" run for low-memory PCs: builds the optimised version with more memory and without the type-check step
// (types are checked before every push), then starts it. Usage: npm run fast
import { spawnSync } from "node:child_process";
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim(), SKIP_TYPECHECK: "1", NEXT_TELEMETRY_DISABLED: "1" };
const run = (args) => { const r = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", ...args], { stdio: "inherit", env }); if (r.status !== 0) process.exit(r.status ?? 1); };
run(["build"]);
run(["start"]);
