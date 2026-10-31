import { describe, it, expect } from "vitest";
import { asRole, type Q } from "../../../tests/security/pg";
import { WS1, WS2, tag } from "../../../tests/helpers";

/**
 * Durable-queue acceptance tests (workflow 22: "retry exhaustion is surfaced", "the owner can pause processing").
 * Everything runs inside a transaction that is rolled back, so the shared queue and other builders' jobs are untouched;
 * claims are restricted to this test's unique job types.
 */
type JobRow = { id: string; state: string; attempts: number; last_error: string | null; due_at: Date; duration_ms: number | null; started_at: Date | null; finished_at: Date | null };

async function mkJob(db: Q, type: string, ws: string | null, extra: Record<string, unknown> = {}) {
  const cols = ["workspace_id", "job_type", ...Object.keys(extra)];
  const vals = [ws, type, ...Object.values(extra)];
  const r = await db.q<{ id: string }>(`insert into mudar.job(${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, vals);
  if (r.error) throw r.error;
  return r.rows[0].id;
}
const job = async (db: Q, id: string) => (await db.q<JobRow>("select * from mudar.job where id = $1", [id])).rows[0];
const claim = async (db: Q, types: string[]) => {
  const r = await db.q<JobRow>("select * from mudar_app.claim_jobs('test-worker', 5, 300, $1)", [types]);
  if (r.error) throw r.error;
  return r.rows;
};

describe("durable queue: dead-letter, expired leases, retry, timing", () => {
  it("fail_job reaches dead after max attempts (retry exhaustion is surfaced)", async () => {
    await asRole("service_role", async (db) => {
      const type = tag("test.fail");
      const id = await mkJob(db, type, WS1, { max_attempts: 3 });
      for (let i = 1; i <= 3; i++) {
        const got = await claim(db, [type]);
        expect(got.map((j) => j.id)).toEqual([id]);
        await db.q("select mudar_app.fail_job($1, $2)", [id, `boom ${i}`]);
        const j = await job(db, id);
        expect(j.attempts).toBe(i);
        expect(j.state).toBe(i < 3 ? "queued" : "dead");
        expect(j.duration_ms).not.toBeNull();
        if (i < 3) await db.q("update mudar.job set due_at = now() - interval '1 second' where id = $1", [id]); // skip back-off
      }
      expect(await claim(db, [type])).toEqual([]); // dead is never claimed again
      expect((await job(db, id)).last_error).toBe("boom 3");
    });
  });

  it("expired-lease loop reaches dead instead of looping forever (worker crash / timeout)", async () => {
    await asRole("service_role", async (db) => {
      const type = tag("test.crash");
      const id = await mkJob(db, type, WS1, { max_attempts: 3 });
      for (let i = 1; i <= 3; i++) {
        const got = await claim(db, [type]);
        expect(got.map((j) => j.id)).toEqual([id]);
        expect(got[0].attempts).toBe(i);
        // the worker "crashes": never calls complete/fail; the lease runs out
        await db.q("update mudar.job set lease_until = now() - interval '1 second' where id = $1", [id]);
        await claim(db, ["__none__"]); // any claim call sweeps expired leases
        const j = await job(db, id);
        if (i < 3) {
          expect(j.state).toBe("queued");
          expect(j.last_error).toMatch(/lease expired on attempt/);
          expect(j.due_at.getTime()).toBeGreaterThan(Date.now() - 5_000); // re-queued with back-off, not immediately
          await db.q("update mudar.job set due_at = now() - interval '1 second' where id = $1", [id]);
        } else {
          expect(j.state).toBe("dead");
          expect(j.last_error).toMatch(/^lease expired after 3 attempts/);
        }
      }
      expect(await claim(db, [type])).toEqual([]);
    });
  });

  it("retry_job resets a dead job (admin only, audited)", async () => {
    await asRole("service_role", async (db) => {
      const type = tag("test.retry");
      const id = await mkJob(db, type, WS1, { state: "dead", attempts: 5, last_error: "x", duration_ms: 10 });
      await db.become("colleague"); // editor, not admin
      expect((await db.q("select mudar_app.retry_job($1)", [id])).error?.message).toMatch(/admin/);
      await db.become("owner");
      expect((await db.q("select mudar_app.retry_job($1)", [id])).error).toBeNull();
      await db.become("service_role");
      const j = await job(db, id);
      expect(j).toMatchObject({ state: "queued", attempts: 0, duration_ms: null, started_at: null });
      const audit = await db.q("select action from mudar.audit_event where job_id = $1", [id]);
      expect(audit.rows.map((r) => r.action)).toContain("retry");
      expect((await claim(db, [type])).map((x) => x.id)).toEqual([id]);
    });
  });

  it("records started/finished timestamps and duration_ms; job_latency_stats returns p50/p95 per type", async () => {
    await asRole("service_role", async (db) => {
      const type = tag("test.timed");
      const ids = [await mkJob(db, type, WS1), await mkJob(db, type, WS1)];
      await claim(db, [type]);
      for (const id of ids) await db.q("select mudar_app.complete_job($1, '{}'::jsonb)", [id]);
      const j = await job(db, ids[0]);
      expect(j.state).toBe("succeeded");
      expect(j.started_at).toBeInstanceOf(Date);
      expect(j.finished_at!.getTime()).toBeGreaterThanOrEqual(j.started_at!.getTime());
      expect(j.duration_ms).toBeGreaterThanOrEqual(0);
      await db.q("update mudar.job set duration_ms = case when id = $1 then 100 else 900 end where id = any($2)", [ids[0], ids]);
      await db.become("owner");
      const stats = await db.q<{ job_type: string; runs_24h: number; p50_ms: string; p95_ms: string; max_ms: number }>(
        "select * from mudar_app.job_latency_stats($1) where job_type = $2", [WS1, type]);
      expect(stats.error).toBeNull();
      expect(stats.rows[0]).toMatchObject({ runs_24h: 2, max_ms: 900 });
      expect(Number(stats.rows[0].p50_ms)).toBe(500);
      expect(Number(stats.rows[0].p95_ms)).toBe(860);
      await db.become("colleague"); // not admin => RLS hides the jobs
      expect((await db.q("select * from mudar_app.job_latency_stats($1) where job_type = $2", [WS1, type])).rows).toEqual([]);
    });
  });
});

describe("kill switch: the owner can pause processing", () => {
  it("workspace pause makes claim_jobs skip that workspace's jobs except backups; audited; admin-only; resume restores", async () => {
    await asRole("service_role", async (db) => {
      const type = tag("test.paused");
      const ws1Job = await mkJob(db, type, WS1);
      const ws2Job = await mkJob(db, type, WS2);
      // due far in the past so these sort ahead of any real queued backups on the shared DB
      const backup = await mkJob(db, "admin.export", WS1, { dedupe_key: tag("test-export"), due_at: new Date("2000-01-01") });

      await db.become("colleague");
      expect((await db.q("select mudar_app.set_jobs_paused($1, true, 'x')", [WS1])).error?.code).toBe("42501");
      await db.become("owner");
      expect((await db.q("select mudar_app.set_jobs_paused($1, true, 'incident drill')", [WS1])).error).toBeNull();
      const audit = await db.q("select action, after from mudar.audit_event where workspace_id = $1 and action = 'pause_jobs' order by id desc limit 1", [WS1]);
      expect(audit.rows[0]?.after).toMatchObject({ jobs_paused: true, reason: "incident drill" });
      await db.become("service_role");

      const got = (await claim(db, [type, "admin.export"])).map((j) => j.id);
      expect(got).toEqual(expect.arrayContaining([ws2Job, backup])); // WS2 and the WS1 backup run
      expect(got).not.toContain(ws1Job); // WS1's ordinary job waits
      expect((await job(db, ws1Job)).state).toBe("queued");

      await db.become("owner");
      await db.q("select mudar_app.set_jobs_paused($1, false)", [WS1]);
      await db.become("service_role");
      expect((await claim(db, [type])).map((j) => j.id)).toEqual([ws1Job]);
    });
  });

  it("platform-wide pause stops every tenant's jobs except backups; only platform admins can set it", async () => {
    await asRole("service_role", async (db) => {
      const type = tag("test.global");
      const a = await mkJob(db, type, WS1);
      const b = await mkJob(db, type, WS2);
      const backup = await mkJob(db, "admin.restore_sample", WS2, { dedupe_key: tag("test-restore"), due_at: new Date("2000-01-01") });
      await db.become("colleague");
      expect((await db.q("select mudar_app.set_jobs_paused(null, true)")).error?.code).toBe("42501");
      await db.become("owner"); // seeded platform admin
      expect((await db.q("select mudar_app.set_jobs_paused(null, true, 'platform incident')")).error).toBeNull();
      await db.become("service_role");
      const audit = await db.q("select count(*)::int as n from mudar.audit_event where action = 'platform_pause_jobs' and workspace_id = any($1)", [[WS1, WS2]]);
      expect(audit.rows[0].n).toBe(2); // written to every tenant's audit log
      const got = (await claim(db, [type, "admin.restore_sample"])).map((j) => j.id);
      expect(got).toContain(backup);
      expect(got).not.toContain(a);
      expect(got).not.toContain(b);
      await db.become("owner");
      await db.q("select mudar_app.set_jobs_paused(null, false)");
      await db.become("service_role");
      expect((await claim(db, [type])).map((j) => j.id).sort()).toEqual([a, b].sort());
    });
  });
});

describe("scheduler heartbeat", () => {
  it("begin_scheduler_run records each tick with the gap since the previous one; heartbeat RPC exposes only aggregates", async () => {
    await asRole("service_role", async (db) => {
      await db.q("insert into mudar.scheduler_run(started_at, finished_at, ms) values (now() - interval '40 minutes', now() - interval '39 minutes', 1000)");
      const r = await db.q<{ begin_scheduler_run: { id: number; gap_minutes: number; prev_started_at: string } }>("select mudar_app.begin_scheduler_run('w-test', 'test')");
      expect(r.error).toBeNull();
      const run = r.rows[0].begin_scheduler_run;
      expect(Number(run.gap_minutes)).toBeGreaterThanOrEqual(40);
      expect(run.prev_started_at).toBeTruthy();
      await db.become("colleague");
      expect((await db.q("select * from mudar.scheduler_run")).rows).toEqual([]); // platform admins only
      const hb = await db.q<{ scheduler_heartbeat: Record<string, unknown> }>("select mudar_app.scheduler_heartbeat()");
      expect(hb.error).toBeNull();
      expect(Object.keys(hb.rows[0].scheduler_heartbeat)).not.toContain("schedule_errors");
      expect(hb.rows[0].scheduler_heartbeat.last_tick_at).toBeTruthy();
      await db.become("anon");
      expect((await db.q("select mudar_app.scheduler_heartbeat()")).error).not.toBeNull();
    });
  });

  it("keeps only the latest ~2000 scheduler_run rows", async () => {
    await asRole("service_role", async (db) => {
      await db.q("insert into mudar.scheduler_run(started_at) select now() - make_interval(mins => g) from generate_series(1, 2100) g");
      await db.q("select mudar_app.begin_scheduler_run('w-test')");
      const n = await db.q<{ n: number }>("select count(*)::int as n from mudar.scheduler_run");
      expect(n.rows[0].n).toBeLessThanOrEqual(2001);
    });
  });
});
