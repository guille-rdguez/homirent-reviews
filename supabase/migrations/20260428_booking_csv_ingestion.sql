create table if not exists public.booking_import_batches (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  source_filename text,
  uploaded_by text,
  rows_detected integer not null default 0,
  rows_new integer not null default 0,
  rows_duplicate_existing integer not null default 0,
  rows_duplicate_in_file integer not null default 0,
  rows_invalid integer not null default 0,
  rows_translated integer not null default 0,
  review_date_from timestamptz,
  review_date_to timestamptz,
  status text not null default 'completed',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists booking_import_batches_property_id_idx
  on public.booking_import_batches (property_id);

create index if not exists booking_import_batches_created_at_idx
  on public.booking_import_batches (created_at desc);

create table if not exists public.booking_review_details (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  import_batch_id uuid references public.booking_import_batches(id) on delete set null,
  property_id uuid not null references public.properties(id) on delete cascade,
  booking_review_key text not null,
  source_filename text,
  review_date timestamptz not null,
  guest_name text not null,
  reservation_number text not null,
  review_title text,
  positive_review text,
  negative_review text,
  property_reply text,
  combined_comment text,
  translated_title text,
  translated_positive_review text,
  translated_negative_review text,
  translated_property_reply text,
  translated_combined_comment text,
  source_language text,
  translation_provider text,
  translation_status text not null default 'not_needed',
  rating_overall_10 numeric(5,2) not null,
  rating_general_5 integer not null,
  score_staff numeric(5,2),
  score_cleanliness numeric(5,2),
  score_location numeric(5,2),
  score_facilities numeric(5,2),
  score_comfort numeric(5,2),
  score_value_for_money numeric(5,2),
  score_average_10 numeric(5,2),
  raw_csv jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists booking_review_details_review_id_key
  on public.booking_review_details (review_id);

create unique index if not exists booking_review_details_booking_review_key_key
  on public.booking_review_details (booking_review_key);

create index if not exists booking_review_details_property_id_idx
  on public.booking_review_details (property_id);

create index if not exists booking_review_details_review_date_idx
  on public.booking_review_details (review_date desc);

create index if not exists booking_review_details_import_batch_id_idx
  on public.booking_review_details (import_batch_id);

alter table public.booking_import_batches enable row level security;
alter table public.booking_review_details enable row level security;

drop trigger if exists set_updated_at_booking_import_batches on public.booking_import_batches;
create trigger set_updated_at_booking_import_batches
  before update on public.booking_import_batches
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_booking_review_details on public.booking_review_details;
create trigger set_updated_at_booking_review_details
  before update on public.booking_review_details
  for each row execute function public.set_updated_at();
