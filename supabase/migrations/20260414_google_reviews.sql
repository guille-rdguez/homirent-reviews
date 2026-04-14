-- Google Reviews table
-- Stores reviews fetched from Google Places API (New).
-- Limited to ~5 most recent/relevant reviews per property.

create table if not exists public.google_reviews (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  source            text not null default 'google',
  external_id       text not null,
  guest_name        text,
  rating            integer,
  comment           text,
  review_url        text,
  place_id          text,
  original_language text,
  published_at      timestamptz,
  responded         boolean not null default false,
  responded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists google_reviews_external_id_key
  on public.google_reviews (external_id);

create index if not exists google_reviews_property_id_idx
  on public.google_reviews (property_id);

create index if not exists google_reviews_responded_idx
  on public.google_reviews (responded);

-- RLS
alter table public.google_reviews enable row level security;

-- updated_at trigger
drop trigger if exists set_updated_at_google_reviews on public.google_reviews;
create trigger set_updated_at_google_reviews
  before update on public.google_reviews
  for each row execute function public.set_updated_at();
