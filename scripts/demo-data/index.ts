/**
 * Builds the complete synthetic demo dataset in FK-safe insert order. Pure function of `today`:
 * same date => byte-identical rows (seeded PRNG + deterministic UUIDs).
 */
import { DEMO_WORKSPACE_ID, SEED_VERSION, SYNTHETIC_NOTE, base, did, type GenContext, type TableBatch } from "./core";
import { buildGeography } from "./geography";
import { buildOrganisations } from "./organisations";
import { buildPeople, personRoster } from "./people";
import { buildAssets } from "./assets";
import { buildLeases, buildMarket } from "./leases-market";
import { buildDeals } from "./deals";
import { buildActivity } from "./activity";

export * from "./core";

export function buildDemoDataset(today: string): TableBatch[] {
  const ctx: GenContext = { today, sourceObjectId: did("source_object", "demo-seed") };
  const roster = personRoster(today);
  const geography = buildGeography();
  const { organisations, relations } = buildOrganisations();
  const people = buildPeople(ctx, roster);
  const assets = buildAssets(ctx, roster);
  const { leases, events } = buildLeases(ctx, assets.defs, assets.spaceDefs);
  const market = buildMarket(ctx, assets.defs);
  const deals = buildDeals(ctx, roster, assets.defs, assets.spaceDefs);
  const activity = buildActivity(ctx, roster, assets.defs, leases);

  const sourceObject = {
    ...base(), id: ctx.sourceObjectId, kind: "manual", uri: null, file_name: "demo-seed (synthetic fixtures)", sha256: null,
    licensed_source_id: null, licence_note: SYNTHETIC_NOTE, version: 1, previous_version_id: null,
    meta: { synthetic: true, seed_version: SEED_VERSION, generator: "scripts/demo-seed.ts", anchor_date: today },
  };

  const batches: TableBatch[] = [
    { table: "source_object", rows: [sourceObject] },
    { table: "geography", rows: geography },
    { table: "organisation", rows: organisations },
    { table: "organisation_relation", rows: relations },
    { table: "person", rows: people.persons },
    { table: "contact_method", rows: people.contacts },
    { table: "employment", rows: people.employment },
    { table: "relationship_edge", rows: people.edges },
    { table: "consent_permission", rows: people.consents },
    { table: "asset", rows: assets.assets },
    { table: "space", rows: assets.spaces },
    { table: "availability", rows: assets.availability },
    { table: "lease", rows: leases },
    { table: "lease_event", rows: events },
    { table: "market_transaction", rows: market.transactions },
    { table: "market_observation", rows: market.observations },
    { table: "requirement", rows: deals.requirements },
    { table: "stakeholder", rows: deals.stakeholders },
    { table: "opportunity", rows: deals.opportunities },
    { table: "opportunity_stage_history", rows: deals.history },
    { table: "quote", rows: deals.quotes },
    { table: "fee_milestone", rows: deals.fees },
    { table: "interaction", rows: activity.interactions },
    { table: "interaction_link", rows: activity.links },
    { table: "task", rows: activity.tasks },
    { table: "meeting_visit", rows: activity.meetings },
    { table: "signal_claim", rows: activity.signals },
  ];

  // Hard invariant: nothing may target any workspace other than the demo workspace; ids are unique.
  const seen = new Set<string>();
  for (const b of batches) {
    for (const r of b.rows) {
      if (r.workspace_id !== DEMO_WORKSPACE_ID) throw new Error(`${b.table} row ${String(r.id)} targets a non-demo workspace`);
      const k = `${b.table}:${String(r.id)}`;
      if (seen.has(k)) throw new Error(`duplicate id ${k}`);
      seen.add(k);
    }
  }
  return batches;
}
