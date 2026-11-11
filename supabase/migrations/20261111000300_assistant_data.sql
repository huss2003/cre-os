-- Module 12 round 2 (data agent): company locations + typed landlord offers on the versioned quote table.
-- Re-runnable.

-- ---------------------------------------------------------------- org_location
create table if not exists mudar.org_location (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references mudar.organisation(id) on delete cascade,
  location_kind text not null default 'other' check (location_kind in ('hq','office','factory','warehouse','plant','r_and_d','other')),
  name text,
  address text,
  city text,
  area text,                                   -- micro-market / industrial area as written, e.g. "MIDC Chakan", "Hinjewadi"
  geography_id uuid references mudar.geography(id),
  lat numeric(9,6), lon numeric(9,6),
  asset_id uuid references mudar.asset(id),    -- when the site is a known building
  headcount int check (headcount is null or headcount >= 0),
  source text not null default 'user',         -- 'lease' | 'user' | 'assistant' | 'import' | 'research' ...
  source_lease_id uuid references mudar.lease(id) on delete set null,
  source_ref text,                             -- url / doc reference
  fact_status mudar.fact_status not null default 'reported'
    check (fact_status in ('reported','currently_confirmed','ai_inference')),
  observed_at date,
  -- duplicate guard: same company + kind + (building, or normalised area|city|name)
  dedupe_key text generated always as (
    location_kind || '|' || coalesce(asset_id::text,
      lower(regexp_replace(coalesce(area,'') || '|' || coalesce(city,'') || '|' || coalesce(name,''), '\s+', ' ', 'g')))
  ) stored
);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'org_location_touch') then
    perform mudar_app.make_business_table('org_location');
  end if;
end $$;
create unique index if not exists org_location_dedupe_uq on mudar.org_location(workspace_id, org_id, dedupe_key) where archived_at is null;
create index if not exists org_location_org on mudar.org_location(workspace_id, org_id);
create index if not exists org_location_city on mudar.org_location(workspace_id, lower(city));

-- Backfill (and re-sync) office locations from leases → assets. SECURITY INVOKER: runs under the caller's RLS,
-- so a user only backfills what they can see. Existing rows (same dedupe key) are left alone.
create or replace function mudar_app.org_location_backfill(p_workspace uuid) returns int
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
declare n int;
begin
  with recursive geo_up as (
    select g.id as start_id, g.id, g.level, g.name, g.parent_id, 0 as depth from mudar.geography g where g.workspace_id = p_workspace
    union all
    select u.start_id, p.id, p.level, p.name, p.parent_id, u.depth + 1 from geo_up u join mudar.geography p on p.id = u.parent_id where u.depth < 10
  ), city_of as (
    select distinct on (start_id) start_id, name from geo_up where level = 'city' order by start_id, depth
  ), src as (
    select distinct on (l.tenant_org_id, l.asset_id)
      l.workspace_id, l.tenant_org_id, l.asset_id, l.id as lease_id, l.classification, l.owner_user_id,
      a.name, a.address, a.lat, a.lon, coalesce(a.micro_market_id, a.locality_id) as geo_id,
      coalesce(mm.name, lo.name) as area_name,
      coalesce(c1.name, c2.name) as city_name,
      coalesce(l.start_date, l.created_at::date) as observed
    from mudar.lease l
    join mudar.asset a on a.id = l.asset_id and a.workspace_id = l.workspace_id
    left join mudar.geography mm on mm.id = a.micro_market_id
    left join mudar.geography lo on lo.id = a.locality_id
    left join city_of c1 on c1.start_id = a.micro_market_id
    left join city_of c2 on c2.start_id = a.locality_id
    where l.workspace_id = p_workspace and l.archived_at is null and l.tenant_org_id is not null
    order by l.tenant_org_id, l.asset_id, l.start_date desc nulls last
  )
  insert into mudar.org_location (workspace_id, classification, owner_user_id, org_id, location_kind, name, address, city, area,
                                  geography_id, lat, lon, asset_id, source, source_lease_id, fact_status, observed_at)
  select s.workspace_id, s.classification, s.owner_user_id, s.tenant_org_id, 'office', s.name, s.address, s.city_name, s.area_name,
         s.geo_id, s.lat, s.lon, s.asset_id, 'lease', s.lease_id, 'reported', s.observed
  from src s
  where not exists (select 1 from mudar.org_location x where x.workspace_id = s.workspace_id and x.org_id = s.tenant_org_id
                      and x.asset_id = s.asset_id and x.location_kind = 'office' and x.archived_at is null)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function mudar_app.org_location_backfill(uuid) from public, anon;
grant execute on function mudar_app.org_location_backfill(uuid) to authenticated, service_role;

do $$ declare w uuid; begin
  for w in select id from mudar.workspace loop perform mudar_app.org_location_backfill(w); end loop;
end $$;

-- ---------------------------------------------------------------- landlord offers = typed quotes
-- A landlord offer is a quote version (kind='landlord_offer') carrying a schema-validated `offer` jsonb
-- (src/modules/assistant/data/offer-schema.ts). Existing deal screens keep seeing it through terms_json.
alter table mudar.quote add column if not exists kind text not null default 'quote';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_kind_chk') then
    alter table mudar.quote add constraint quote_kind_chk check (kind in ('quote','landlord_offer'));
  end if;
end $$;
alter table mudar.quote add column if not exists offer jsonb;
create index if not exists quote_kind_idx on mudar.quote(workspace_id, kind) where kind <> 'quote';

-- offer / kind follow the same immutability as terms_json (a revision is a new version row)
create or replace function mudar_app.assistant_offer_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
begin
  if not mudar_app.deals_via_proposal() and (new.offer is distinct from old.offer or new.kind is distinct from old.kind) then
    raise exception 'quote versions are immutable: create a new version instead' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists quote_offer_guard on mudar.quote;
create trigger quote_offer_guard before update on mudar.quote for each row execute function mudar_app.assistant_offer_guard();
