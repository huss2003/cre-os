-- Content Editor (workflow 20): enforce the approval rules in the database, not only in app code.
--  * 'approved' requires a non-empty body and a review checklist whose items are all ok (same rule as checklistPasses).
--  * 'published_manually' is reachable only from 'approved' (or stays published); publishing itself is manual.
--  * editing the body of an approved/published post drops it back to 'in_review' (re-review before sharing again).
-- Re-runnable.
set search_path = mudar, mudar_app, public, extensions;

create or replace function mudar_app.content_post_status_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
declare passes boolean;
begin
  if tg_op = 'UPDATE' and new.body is distinct from old.body and old.status in ('approved', 'published_manually')
     and new.status is not distinct from old.status then
    new.status := 'in_review';
  end if;
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved' or new.body is distinct from old.body
                                   or new.review_checklist is distinct from old.review_checklist) then
    passes := coalesce(trim(new.body), '') <> ''
              and jsonb_typeof(new.review_checklist) = 'array' and jsonb_array_length(new.review_checklist) > 0
              and not exists (select 1 from jsonb_array_elements(new.review_checklist) i where coalesce((i->>'ok')::boolean, false) = false);
    if not passes then
      raise exception 'content post cannot be approved: draft missing or review checklist has open items' using errcode = '42501';
    end if;
  end if;
  if new.status = 'published_manually' and (tg_op = 'INSERT' or old.status not in ('approved', 'published_manually')) then
    raise exception 'content post must be approved before it is marked published' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function mudar_app.content_post_status_guard() from public, anon, authenticated;
drop trigger if exists content_post_status_guard on mudar.content_post;
create trigger content_post_status_guard before insert or update on mudar.content_post
  for each row execute function mudar_app.content_post_status_guard();
