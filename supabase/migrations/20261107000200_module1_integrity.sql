-- Module 1 QA fixes: integrity rules the UI tests expect the database itself to enforce.
-- NOT VALID: existing rows are not re-checked (no data is rewritten); every new/updated row is.
alter table mudar.employment drop constraint if exists employment_dates_chk;
alter table mudar.employment add constraint employment_dates_chk check (end_date is null or start_date is null or end_date >= start_date) not valid;
alter table mudar.availability drop constraint if exists availability_dates_chk;
alter table mudar.availability add constraint availability_dates_chk check (valid_until is null or available_from is null or valid_until >= available_from) not valid;
alter table mudar.availability drop constraint if exists availability_rent_chk;
alter table mudar.availability add constraint availability_rent_chk check ((asking_rent_min is null or asking_rent_min >= 0) and (asking_rent_max is null or asking_rent_min is null or asking_rent_max >= asking_rent_min)) not valid;
alter table mudar.lease drop constraint if exists lease_dates_chk;
alter table mudar.lease add constraint lease_dates_chk check (contractual_expiry is null or start_date is null or contractual_expiry >= start_date) not valid;
alter table mudar.lease drop constraint if exists lease_area_chk;
alter table mudar.lease add constraint lease_area_chk check ((area_sf is null or area_sf > 0) and (rent_per_sf is null or rent_per_sf >= 0)) not valid;
alter table mudar.geography drop constraint if exists geography_latlon_chk;
alter table mudar.geography add constraint geography_latlon_chk check ((lat is null or lat between -90 and 90) and (lon is null or lon between -180 and 180)) not valid;
alter table mudar.geography drop constraint if exists geography_self_parent_chk;
alter table mudar.geography add constraint geography_self_parent_chk check (parent_id is null or parent_id <> id) not valid;
alter table mudar.asset drop constraint if exists asset_latlon_chk;
alter table mudar.asset add constraint asset_latlon_chk check ((lat is null or lat between -90 and 90) and (lon is null or lon between -180 and 180)) not valid;
alter table mudar.relationship_edge drop constraint if exists relationship_edge_self_chk;
alter table mudar.relationship_edge add constraint relationship_edge_self_chk check (from_person_id is null or from_person_id <> to_person_id) not valid;
alter table mudar.lease_space drop constraint if exists lease_space_area_chk;
alter table mudar.lease_space add constraint lease_space_area_chk check (area_sf is null or area_sf > 0);
alter table mudar.space drop constraint if exists space_seats_chk;
alter table mudar.space add constraint space_seats_chk check (seats is null or seats >= 0) not valid;

-- Geography: no cycles (a place cannot sit inside its own descendant).
create or replace function mudar_app.geography_no_cycle() returns trigger language plpgsql as $$
declare cur uuid := new.parent_id; n int := 0;
begin
  while cur is not null and n < 20 loop
    if cur = new.id then raise exception 'geography cycle: % cannot be inside itself', new.name using errcode = '23514'; end if;
    select parent_id into cur from mudar.geography where id = cur; n := n + 1;
  end loop;
  return new;
end $$;
drop trigger if exists geography_no_cycle on mudar.geography;
create trigger geography_no_cycle before insert or update of parent_id on mudar.geography for each row execute function mudar_app.geography_no_cycle();

-- Fee allocation: total share per milestone cannot exceed 1.
create or replace function mudar_app.fee_allocation_total() returns trigger language plpgsql as $$
declare total numeric;
begin
  select coalesce(sum(share),0) into total from mudar.fee_allocation where fee_milestone_id = new.fee_milestone_id and archived_at is null and id <> new.id;
  if total + new.share > 1 then raise exception 'fee share total % exceeds 1', total + new.share using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists fee_allocation_total on mudar.fee_allocation;
create trigger fee_allocation_total before insert or update on mudar.fee_allocation for each row execute function mudar_app.fee_allocation_total();
