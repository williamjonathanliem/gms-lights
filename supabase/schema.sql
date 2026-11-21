-- GMS Lighting Dashboard: database schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.

-- One row per service (e.g. "Sunday Service 1, 30 Nov"). Its setlist,
-- songs and cues live in the `songs` JSON column.
create table if not exists public.services (
  id           uuid primary key default gen_random_uuid(),
  name         text not null default 'Untitled service',
  service_date date,
  notes        text not null default '',
  songs        jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);
create index if not exists services_date_idx on public.services (service_date desc);

-- Shared library: scenes, saved pattern names/previews, favourites, light names.
-- Keys used by the app: 'scenes', 'patterns', 'favs', 'aliases'.
create table if not exists public.library (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Only signed-in team members can read or change anything.
alter table public.services enable row level security;
alter table public.library  enable row level security;

drop policy if exists "team read services"  on public.services;
drop policy if exists "team write services" on public.services;
drop policy if exists "team read library"   on public.library;
drop policy if exists "team write library"  on public.library;

create policy "team read services"  on public.services for select to authenticated using (true);
create policy "team write services" on public.services for all    to authenticated using (true) with check (true);
create policy "team read library"   on public.library  for select to authenticated using (true);
create policy "team write library"  on public.library  for all    to authenticated using (true) with check (true);

-- Live sync between devices (an edit on one phone shows up on the others).
do $$
begin
  begin alter publication supabase_realtime add table public.services; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.library;  exception when duplicate_object then null; end;
end $$;
