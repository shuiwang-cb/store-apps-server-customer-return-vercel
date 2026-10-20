-- Supabase exposes the public schema through its Data API (PostgREST), and
-- tables created in SQL grant the anon/authenticated roles access with RLS
-- off — so anyone holding the project's publishable key could read and write
-- these tables directly. The service connects as the table owner and is not
-- affected by RLS; this closes the Data API path.
--
-- On a plain Postgres (local development) the anon/authenticated roles do not
-- exist, so the revokes are skipped there.

alter table returns          enable row level security;
alter table return_photos    enable row level security;
alter table return_notes     enable row level security;
alter table counters         enable row level security;
alter table store_settings   enable row level security;
alter table idempotency_keys enable row level security;
alter table schema_migrations enable row level security;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on table returns, return_photos, return_notes, counters, '
        'store_settings, idempotency_keys, schema_migrations from %I',
        role_name);
    end if;
  end loop;
end $$;
