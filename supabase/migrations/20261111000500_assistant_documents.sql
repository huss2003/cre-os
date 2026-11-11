-- Module 12 round 2 — documents agent: page-aware attachments, lease-term extractions, doc_chunk vector store. Re-runnable.
set search_path = mudar, mudar_app, public, extensions;

create extension if not exists vector with schema extensions;

-- Per-page text of an attachment (PDF: one entry per page; DOCX/TXT: one entry). Untrusted evidence.
alter table mudar.assistant_attachment add column if not exists page_texts jsonb;

-- Lease-term extraction results (category B tool output; saved so save_lease_terms never re-trusts model-passed values).
create table if not exists mudar.assistant_lease_extraction (
  id uuid primary key default gen_random_uuid(),
  attachment_id uuid not null references mudar.assistant_attachment(id) on delete cascade,
  doc_kind text,
  terms jsonb not null default '{}',     -- {field: {raw, normalised, page, snippet, confidence, verified, flag}}
  flags jsonb not null default '[]',
  mocked boolean not null default false,
  model text,
  run_id uuid
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_lease_extraction' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_lease_extraction');
  end if;
end $$;
create index if not exists assistant_lease_extraction_att on mudar.assistant_lease_extraction(workspace_id, attachment_id);

-- Chunks for hybrid (vector + full-text) retrieval.
create table if not exists mudar.doc_chunk (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('attachment','meeting_note','interaction','document','memory')),
  source_id uuid not null,
  page int,
  chunk_index int not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('simple', coalesce(text, ''))) stored,
  embedding extensions.vector(1024),
  model text,
  content_hash text not null
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='doc_chunk' and column_name='workspace_id') then
    perform mudar_app.make_business_table('doc_chunk', false);
  end if;
end $$;
create unique index if not exists doc_chunk_uq on mudar.doc_chunk(workspace_id, source_type, source_id, chunk_index);
create index if not exists doc_chunk_tsv on mudar.doc_chunk using gin(tsv);
create index if not exists doc_chunk_src on mudar.doc_chunk(workspace_id, source_type, source_id);
create index if not exists doc_chunk_embedding_hnsw on mudar.doc_chunk using hnsw (embedding extensions.vector_cosine_ops);

-- Vector top-k. SECURITY INVOKER: the caller's RLS applies; workspace filtered explicitly too.
create or replace function mudar_app.match_doc_chunks(p_workspace uuid, p_embedding text, p_k int default 20, p_source_types text[] default null)
returns table (id uuid, source_type text, source_id uuid, page int, chunk_index int, text text, similarity double precision)
language sql stable security invoker set search_path = mudar, mudar_app, public, extensions as $$
  select c.id, c.source_type, c.source_id, c.page, c.chunk_index, c.text,
         1 - (c.embedding <=> p_embedding::extensions.vector) as similarity
  from mudar.doc_chunk c
  where c.workspace_id = p_workspace and c.archived_at is null and c.embedding is not null
    and (p_source_types is null or c.source_type = any(p_source_types))
  order by c.embedding <=> p_embedding::extensions.vector
  limit least(greatest(coalesce(p_k, 20), 1), 100)
$$;
grant execute on function mudar_app.match_doc_chunks(uuid, text, int, text[]) to authenticated, service_role;
