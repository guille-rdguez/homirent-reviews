create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.source_accounts (
  id uuid primary key default gen_random_uuid(),
  connector text not null,
  label text not null,
  external_account_id text,
  inbox_address text,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists source_accounts_connector_external_account_id_key
  on public.source_accounts (connector, external_account_id)
  where external_account_id is not null;

create unique index if not exists source_accounts_connector_inbox_address_key
  on public.source_accounts (connector, inbox_address)
  where inbox_address is not null;

create table if not exists public.external_listings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  source_account_id uuid references public.source_accounts(id) on delete set null,
  connector text not null,
  channel text not null,
  external_listing_id text not null,
  external_property_id text,
  display_name text,
  listing_url text,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists external_listings_connector_listing_key
  on public.external_listings (connector, external_listing_id);

create index if not exists external_listings_property_id_idx
  on public.external_listings (property_id);

create index if not exists external_listings_channel_idx
  on public.external_listings (channel);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete restrict,
  source_account_id uuid references public.source_accounts(id) on delete set null,
  listing_id uuid references public.external_listings(id) on delete set null,
  connector text not null,
  channel text not null,
  cloudbeds_reservation_id text,
  external_reservation_id text,
  guest_name text,
  guest_email text,
  room_name text,
  status text not null default 'pending',
  check_in date,
  check_out date,
  booked_at timestamptz,
  cancelled_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists reservations_cloudbeds_reservation_key
  on public.reservations (cloudbeds_reservation_id)
  where cloudbeds_reservation_id is not null;

create unique index if not exists reservations_connector_external_reservation_key
  on public.reservations (connector, external_reservation_id)
  where external_reservation_id is not null;

create index if not exists reservations_property_id_idx
  on public.reservations (property_id);

create index if not exists reservations_channel_idx
  on public.reservations (channel);

create index if not exists reservations_check_out_idx
  on public.reservations (check_out);

create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid references public.source_accounts(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  reservation_id uuid references public.reservations(id) on delete set null,
  connector text not null,
  channel_guess text,
  external_message_id text,
  thread_id text,
  from_email text,
  subject text,
  received_at timestamptz not null default now(),
  parse_status text not null default 'pending',
  raw_text text,
  raw_html text,
  headers jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists inbound_messages_connector_external_message_key
  on public.inbound_messages (connector, external_message_id)
  where external_message_id is not null;

create index if not exists inbound_messages_property_id_idx
  on public.inbound_messages (property_id);

create index if not exists inbound_messages_reservation_id_idx
  on public.inbound_messages (reservation_id);

create index if not exists inbound_messages_parse_status_idx
  on public.inbound_messages (parse_status);

alter table public.reviews
  add column if not exists source_account_id uuid,
  add column if not exists listing_id uuid,
  add column if not exists reservation_id uuid,
  add column if not exists connector text not null default 'direct_app',
  add column if not exists channel text not null default 'direct',
  add column if not exists source_type text not null default 'direct_form',
  add column if not exists external_review_id text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists is_public boolean not null default false,
  add column if not exists match_confidence numeric(5,4),
  add column if not exists response_status text not null default 'not_applicable',
  add column if not exists response_text text,
  add column if not exists responded_at timestamptz,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.reviews
set connector = coalesce(connector, 'direct_app'),
    channel = coalesce(channel, 'direct'),
    source_type = coalesce(source_type, 'direct_form'),
    reviewed_at = coalesce(reviewed_at, created_at, now()),
    is_public = coalesce(is_public, false),
    response_status = coalesce(response_status, 'not_applicable'),
    raw_payload = coalesce(raw_payload, '{}'::jsonb),
    metadata = coalesce(metadata, '{}'::jsonb)
where connector is null
   or channel is null
   or source_type is null
   or reviewed_at is null
   or is_public is null
   or response_status is null
   or raw_payload is null
   or metadata is null;

alter table public.reviews
  alter column reviewed_at set default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reviews_source_account_id_fkey'
  ) then
    alter table public.reviews
      add constraint reviews_source_account_id_fkey
      foreign key (source_account_id)
      references public.source_accounts(id)
      on delete set null;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reviews_listing_id_fkey'
  ) then
    alter table public.reviews
      add constraint reviews_listing_id_fkey
      foreign key (listing_id)
      references public.external_listings(id)
      on delete set null;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reviews_reservation_id_fkey'
  ) then
    alter table public.reviews
      add constraint reviews_reservation_id_fkey
      foreign key (reservation_id)
      references public.reservations(id)
      on delete set null;
  end if;
end
$$;

create index if not exists reviews_channel_idx
  on public.reviews (channel);

create index if not exists reviews_source_type_idx
  on public.reviews (source_type);

create index if not exists reviews_reservation_id_idx
  on public.reviews (reservation_id);

create index if not exists reviews_listing_id_idx
  on public.reviews (listing_id);

create index if not exists reviews_reviewed_at_idx
  on public.reviews (reviewed_at desc);

create index if not exists reviews_external_review_id_idx
  on public.reviews (external_review_id)
  where external_review_id is not null;

drop trigger if exists set_updated_at_source_accounts on public.source_accounts;
create trigger set_updated_at_source_accounts
before update on public.source_accounts
for each row
execute function public.set_updated_at();

drop trigger if exists set_updated_at_external_listings on public.external_listings;
create trigger set_updated_at_external_listings
before update on public.external_listings
for each row
execute function public.set_updated_at();

drop trigger if exists set_updated_at_reservations on public.reservations;
create trigger set_updated_at_reservations
before update on public.reservations
for each row
execute function public.set_updated_at();

drop trigger if exists set_updated_at_inbound_messages on public.inbound_messages;
create trigger set_updated_at_inbound_messages
before update on public.inbound_messages
for each row
execute function public.set_updated_at();
