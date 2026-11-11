-- Backfill: strip internal ids that older assistant/capture writers put into task titles/descriptions,
-- e.g. "Assistant: terms from attached document (extraction 9cf1cacf-…)". Display also cleans these (changes/display cleanText).
-- Re-runnable: only rows that still contain such a marker are touched.
update mudar.task
set title = btrim(regexp_replace(regexp_replace(title,
      '\s*\((extraction|capture|document|attachment|draft|source)\s+[0-9a-f][0-9a-f-]{5,}…?\)', '', 'gi'),
      '\s*\(capture document [0-9a-f]{6,}[^)]*\)', '', 'gi'))
where title ~* '\((extraction|capture|document|attachment|draft|source)\s+[0-9a-f][0-9a-f-]{5,}'
   or title ~* '\(capture document [0-9a-f]{6,}';

update mudar.task
set description = btrim(regexp_replace(description,
      '\s*\((extraction|capture|document|attachment|draft|source)\s+[0-9a-f][0-9a-f-]{5,}…?\)', '', 'gi'))
where description ~* '\((extraction|capture|document|attachment|draft|source)\s+[0-9a-f][0-9a-f-]{5,}';
