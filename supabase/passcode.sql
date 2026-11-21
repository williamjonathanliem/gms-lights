-- GMS Lighting Dashboard: shared team passcode ("guest mode")
-- Run after schema.sql. The app talks to the database only through these
-- functions, and each one checks the passcode on the server. Direct table
-- access stays blocked for anyone who isn't a signed-in Supabase user.
--
-- Only a SHA-256 hash of the passcode is stored. To change the passcode,
-- replace the hash in gms_ok() with the hash of the new one:
--   select encode(extensions.digest('NEWCODE', 'sha256'), 'hex');

create extension if not exists pgcrypto with schema extensions;

create or replace function public.gms_ok(code text)
returns boolean language sql immutable as $$
  select encode(extensions.digest(coalesce(code, ''), 'sha256'), 'hex')
         = '9b901e365d592abf0d4e5f1f1089d800fa9757e87613c853b32f5f612879a4f4'
$$;

-- Check a passcode (used by the unlock screen). Small delay slows guessing.
create or replace function public.gms_check(code text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not gms_ok(code) then perform pg_sleep(0.8); return false; end if;
  return true;
end $$;

-- Everything the app needs in one call
create or replace function public.gms_pull(code text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not gms_ok(code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  return jsonb_build_object(
    'services', coalesce((select jsonb_agg(to_jsonb(s) order by s.service_date desc nulls last) from services s), '[]'::jsonb),
    'library',  coalesce((select jsonb_agg(to_jsonb(l)) from library l), '[]'::jsonb),
    'version',  greatest((select max(updated_at) from services), (select max(updated_at) from library))
  );
end $$;

-- Cheap change check for polling (replaces realtime for passcode users)
create or replace function public.gms_version(code text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not gms_ok(code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  return coalesce(greatest((select max(updated_at) from services), (select max(updated_at) from library))::text, '')
      || ':' || (select count(*) from services)::text;
end $$;

create or replace function public.gms_save_service(code text, row_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not gms_ok(code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  insert into services (id, name, service_date, notes, songs, updated_at)
  values ((row_data->>'id')::uuid, coalesce(row_data->>'name', 'Untitled service'), nullif(row_data->>'service_date', '')::date,
          coalesce(row_data->>'notes', ''), coalesce(row_data->'songs', '[]'::jsonb), now())
  on conflict (id) do update set name = excluded.name, service_date = excluded.service_date, notes = excluded.notes,
    songs = excluded.songs, updated_at = now();
end $$;

create or replace function public.gms_delete_service(code text, service_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not gms_ok(code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  delete from services where id = service_id;
end $$;

create or replace function public.gms_save_library(code text, lib_key text, lib_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not gms_ok(code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  if lib_key not in ('scenes', 'patterns', 'favs', 'aliases') then raise exception 'Unknown key'; end if;
  insert into library (key, value, updated_at) values (lib_key, lib_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- Only these entry points are callable without an account
revoke all on function public.gms_ok(text) from public, anon;
grant execute on function public.gms_check(text), public.gms_pull(text), public.gms_version(text),
  public.gms_save_service(text, jsonb), public.gms_delete_service(text, uuid), public.gms_save_library(text, text, jsonb)
  to anon, authenticated;
