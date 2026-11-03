# changes module

Part of the capture module. See `src/modules/capture/README.md` (approvals, apply, reversal, merges, person moves, routes).

## Real-data fix — stale detector paging (`stale-paging.db.test.ts`, migration `20261101000700_real_data_fixes.sql`)
`runStaleDetector` read candidates and `record_freshness` in single responses capped at PostgREST max_rows (1000): with
1,231 imported companies only 1,000 were flagged. Both reads now page (`STALE_PAGE`); the candidate RPC has a total order.
