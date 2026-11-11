/** Group run steps for the run page. Each step lands in exactly one bucket; a queued step is "waiting", not "in progress". */
export function groupSteps<T extends { status?: unknown }>(steps: T[], runStatus?: string) {
  const st = (s: T) => String(s.status ?? "");
  const paused = runStatus === "paused";
  return {
    current: paused ? [] : steps.filter((s) => st(s) === "running"),
    completed: steps.filter((s) => st(s) === "done" || st(s) === "skipped"),
    failedSteps: steps.filter((s) => st(s) === "failed" || st(s) === "dead"),
    remaining: steps.filter((s) => ["waiting_dependency", "waiting_approval", "queued", "paused"].includes(st(s)) || (paused && st(s) === "running")),
  };
}
