-- Minimal Supabase-PLATFORM shim for the integration harness (2026-09-27).
--
-- supabase/migrations/ is written for a Supabase project, which provides the
-- `auth` and `storage` schemas and the standard roles before any migration
-- runs. On a vanilla postgis image the very first migration failed with
-- `schema "auth" does not exist`, and 108 of 188 then cascaded (public.users
-- was never created) — so this suite had been testing a mostly empty schema.
--
-- Platform objects ONLY. Never add an application table here: if a migration
-- needs an app object that does not exist yet, that is a real defect the
-- harness must surface. With this shim all 188 migrations applied cleanly and
-- the resulting public schema matched the live dump of 2026-09-20 table-for-
-- table and column-for-column.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(), email text, phone text,
  raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create or replace function auth.jwt() returns jsonb language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin',
    'supabase_functions_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop; end $$;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(),
  updated_at timestamptz default now());
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz default now());
create or replace function storage.foldername(name text) returns text[] language sql immutable
  as $$ select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;
