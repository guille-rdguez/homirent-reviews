-- RLS Policies for homirent.reviews
-- Run this in the Supabase SQL Editor after the foundation migration.
--
-- Goal: the anon key (used in form.html) can only INSERT reviews and READ
-- active properties. It cannot read other guests' data, delete, or update.
-- The service_role key (used by Netlify dashboard functions) bypasses RLS
-- automatically — no additional policies needed for it.

-- ─── properties ─────────────────────────────────────────────────────────────
-- Anon needs SELECT to populate the property dropdown in the guest form.

alter table public.properties enable row level security;

create policy "anon_read_active_properties"
  on public.properties
  for select
  to anon
  using (active = true);

-- ─── reviews ────────────────────────────────────────────────────────────────
-- Anon can INSERT (guest submits review) but cannot read, update, or delete.

alter table public.reviews enable row level security;

create policy "anon_insert_reviews"
  on public.reviews
  for insert
  to anon
  with check (true);


