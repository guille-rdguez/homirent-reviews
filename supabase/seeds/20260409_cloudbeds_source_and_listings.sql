-- Cloudbeds source account + external_listings mapping
-- organizationID: 242744
-- Run in Supabase SQL Editor after both migrations.

-- ─── 1. Source account ───────────────────────────────────────────────────────

insert into public.source_accounts (connector, label, external_account_id, metadata)
values (
  'cloudbeds',
  'Cloudbeds Homi Rent',
  '242744',
  '{"organizationID": "242744"}'::jsonb
)
on conflict do nothing;

-- ─── 2. External listings (Cloudbeds propertyID → Supabase property) ─────────

do $$
declare
  sa_id uuid;
begin
  select id into sa_id from public.source_accounts
  where connector = 'cloudbeds' and external_account_id = '242744';

  if sa_id is null then
    raise exception 'source_account de Cloudbeds no encontrado';
  end if;

  -- Allende
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '317882', '317882', 'Allende By Homi Rent'
  from public.properties p where p.name = 'Allende'
  on conflict (connector, external_listing_id) do nothing;

  -- Balsas
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '241608', '241608', 'Balsas by Homi Rent'
  from public.properties p where p.name = 'Balsas'
  on conflict (connector, external_listing_id) do nothing;

  -- Damian Carmona
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '320046', '320046', 'Damian Carmona by Homi Rent'
  from public.properties p where p.name = 'Damian Carmona'
  on conflict (connector, external_listing_id) do nothing;

  -- El Doce
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '241598', '241598', 'El Doce by Homi Rent'
  from public.properties p where p.name = 'El Doce'
  on conflict (connector, external_listing_id) do nothing;

  -- Ezequiel Montes
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '318801', '318801', 'Ezequiel Montes By Homirent'
  from public.properties p where p.name = 'Ezequiel Montes'
  on conflict (connector, external_listing_id) do nothing;

  -- Hacienda Santa Bárbara
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '306895', '306895', 'Hacienda Santa Barbara By Homirent'
  from public.properties p where p.name = 'Hacienda Santa Bárbara'
  on conflict (connector, external_listing_id) do nothing;

  -- Lago Zirahuén
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '241738', '241738', 'Lago Zirahúen by Homi Rent'
  from public.properties p where p.name = 'Lago Zirahuén'
  on conflict (connector, external_listing_id) do nothing;

  -- Liquidambar
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '318228', '318228', 'Liquidámbar by Homirent'
  from public.properties p where p.name = 'Liquidambar'
  on conflict (connector, external_listing_id) do nothing;

  -- Morelos
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '241600', '241600', 'Morelos by Homi Rent'
  from public.properties p where p.name = 'Morelos'
  on conflict (connector, external_listing_id) do nothing;

  -- Musgo
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '314998', '314998', 'Musgo By HomiRent'
  from public.properties p where p.name = 'Musgo'
  on conflict (connector, external_listing_id) do nothing;

  -- Pájaros
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '318642', '318642', 'Pajaros by Homi Rent'
  from public.properties p where p.name = 'Pájaros'
  on conflict (connector, external_listing_id) do nothing;

  -- Primavera
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '318643', '318643', 'Primavera by Homirent'
  from public.properties p where p.name = 'Primavera'
  on conflict (connector, external_listing_id) do nothing;

  -- Prosperidad
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '241601', '241601', 'Prosperidad by Homi Rent'
  from public.properties p where p.name = 'Prosperidad'
  on conflict (connector, external_listing_id) do nothing;

  -- Suite Álamos
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '318925', '318925', 'Suites Alamos by Homirent'
  from public.properties p where p.name = 'Suite Álamos'
  on conflict (connector, external_listing_id) do nothing;

  -- Suites Reforma
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '261861', '261861', 'Suites Reforma by HomiRent'
  from public.properties p where p.name = 'Suites Reforma'
  on conflict (connector, external_listing_id) do nothing;

  -- Universidad
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '316390', '316390', 'Universidad by HomiRent'
  from public.properties p where p.name = 'Universidad'
  on conflict (connector, external_listing_id) do nothing;

  -- Wenceslao
  insert into public.external_listings
    (property_id, source_account_id, connector, channel, external_listing_id, external_property_id, display_name)
  select p.id, sa_id, 'cloudbeds', 'direct', '318515', '318515', 'Wenceslao by Homi Rent'
  from public.properties p where p.name = 'Wenceslao'
  on conflict (connector, external_listing_id) do nothing;

end $$;

-- ─── Verificación ────────────────────────────────────────────────────────────
-- Corre esto después para confirmar que todas las propiedades quedaron mapeadas:
--
-- select el.display_name, el.external_property_id, p.name as supabase_name
-- from external_listings el
-- join properties p on p.id = el.property_id
-- where el.connector = 'cloudbeds'
-- order by p.name;
