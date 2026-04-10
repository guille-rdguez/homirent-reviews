-- Bootstrap inicial para source_accounts y external_listings.
-- Este archivo es un template: reemplaza los valores TODO_* antes de ejecutarlo.
-- Recomendación: correr por bloques desde el SQL Editor de Supabase.

begin;

-- 1) Inspecciona primero tus complejos actuales.
select id, city, name
from public.properties
order by city, name;

-- 2) Crea o asegura las cuentas fuente principales.
insert into public.source_accounts (
  connector,
  label,
  external_account_id,
  metadata
)
select
  'cloudbeds',
  'Cloudbeds Grupo Principal',
  'TODO_CLOUDBEDS_GROUP_ACCOUNT_ID',
  jsonb_build_object(
    'role', 'pms',
    'ingestion', 'api',
    'notes', 'Cuenta principal de Cloudbeds para sincronizar reservas y contexto operativo'
  )
where not exists (
  select 1
  from public.source_accounts
  where connector = 'cloudbeds'
    and external_account_id = 'TODO_CLOUDBEDS_GROUP_ACCOUNT_ID'
);

insert into public.source_accounts (
  connector,
  label,
  external_account_id,
  inbox_address,
  metadata
)
select
  'airbnb',
  'Airbnb Reviews Inbox',
  'TODO_AIRBNB_ACCOUNT_ID',
  'TODO_AIRBNB_FORWARDING_INBOX',
  jsonb_build_object(
    'role', 'reviews',
    'ingestion', 'email_forward',
    'notes', 'Cuenta lógica para reseñas Airbnb recibidas vía email'
  )
where not exists (
  select 1
  from public.source_accounts
  where connector = 'airbnb'
    and external_account_id = 'TODO_AIRBNB_ACCOUNT_ID'
);

insert into public.source_accounts (
  connector,
  label,
  external_account_id,
  inbox_address,
  metadata
)
select
  'email',
  'Inbox Operativo Central',
  'TODO_EMAIL_INBOX_ID',
  'TODO_OPERATIONS_INBOX',
  jsonb_build_object(
    'role', 'shared_inbox',
    'ingestion', 'gmail_or_graph_webhook',
    'notes', 'Inbox central para correos de Booking, Expedia, Airbnb y operación'
  )
where not exists (
  select 1
  from public.source_accounts
  where connector = 'email'
    and external_account_id = 'TODO_EMAIL_INBOX_ID'
);

-- 3) Ejemplos de mappings Airbnb -> property.
-- Usa una fila por listing real de Airbnb.
-- Reemplaza external_listing_id y display_name por los tuyos.

with airbnb_account as (
  select id
  from public.source_accounts
  where connector = 'airbnb'
    and external_account_id = 'TODO_AIRBNB_ACCOUNT_ID'
  limit 1
)
insert into public.external_listings (
  property_id,
  source_account_id,
  connector,
  channel,
  external_listing_id,
  display_name,
  metadata
)
select
  p.id,
  airbnb_account.id,
  'airbnb',
  'airbnb',
  seed.external_listing_id,
  seed.display_name,
  jsonb_build_object(
    'seed_type', 'example',
    'notes', seed.notes
  )
from (
  values
    ('Querétaro', 'Hacienda Santa Bárbara', 'TODO_AIRBNB_LISTING_HSB_01', 'Airbnb - Hacienda Santa Barbara Loft 1', 'Ejemplo de mapping para un complejo con una o varias listings'),
    ('Ciudad de México', 'Balsas', 'TODO_AIRBNB_LISTING_BALSAS_01', 'Airbnb - Balsas Centro 1', 'Ejemplo de mapping para CDMX'),
    ('Mérida', 'Suites Reforma', 'TODO_AIRBNB_LISTING_REFORMA_01', 'Airbnb - Suites Reforma 1', 'Ejemplo de mapping para Merida')
) as seed(city, property_name, external_listing_id, display_name, notes)
join public.properties p
  on p.city = seed.city
 and p.name = seed.property_name
cross join airbnb_account
where not exists (
  select 1
  from public.external_listings l
  where l.connector = 'airbnb'
    and l.external_listing_id = seed.external_listing_id
);

-- 4) Opcional: mapea el ID interno de property en Cloudbeds hacia tu property.
-- Esto te ayuda a tener una referencia estable cuando importes reservas desde Cloudbeds.

with cloudbeds_account as (
  select id
  from public.source_accounts
  where connector = 'cloudbeds'
    and external_account_id = 'TODO_CLOUDBEDS_GROUP_ACCOUNT_ID'
  limit 1
)
insert into public.external_listings (
  property_id,
  source_account_id,
  connector,
  channel,
  external_listing_id,
  external_property_id,
  display_name,
  metadata
)
select
  p.id,
  cloudbeds_account.id,
  'cloudbeds',
  'pms',
  seed.external_listing_id,
  seed.external_property_id,
  seed.display_name,
  jsonb_build_object(
    'seed_type', 'example',
    'notes', 'Mapping del property/rooming identity de Cloudbeds al complejo interno'
  )
from (
  values
    ('Querétaro', 'Hacienda Santa Bárbara', 'TODO_CLOUDBEDS_PROPERTY_HSB', 'TODO_CLOUDBEDS_PROPERTY_HSB', 'Cloudbeds - Hacienda Santa Bárbara'),
    ('Ciudad de México', 'Balsas', 'TODO_CLOUDBEDS_PROPERTY_BALSAS', 'TODO_CLOUDBEDS_PROPERTY_BALSAS', 'Cloudbeds - Balsas'),
    ('Mérida', 'Suites Reforma', 'TODO_CLOUDBEDS_PROPERTY_REFORMA', 'TODO_CLOUDBEDS_PROPERTY_REFORMA', 'Cloudbeds - Suites Reforma')
) as seed(city, property_name, external_listing_id, external_property_id, display_name)
join public.properties p
  on p.city = seed.city
 and p.name = seed.property_name
cross join cloudbeds_account
where not exists (
  select 1
  from public.external_listings l
  where l.connector = 'cloudbeds'
    and l.external_listing_id = seed.external_listing_id
);

-- 5) Verificación rápida.
select
  l.connector,
  l.channel,
  p.city,
  p.name as property_name,
  l.external_listing_id,
  l.display_name,
  sa.label as source_account
from public.external_listings l
join public.properties p on p.id = l.property_id
left join public.source_accounts sa on sa.id = l.source_account_id
order by l.connector, p.city, p.name, l.display_name nulls last;

commit;
