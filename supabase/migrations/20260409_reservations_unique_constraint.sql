-- Add proper unique constraint on cloudbeds_reservation_id so PostgREST
-- can resolve ON CONFLICT upserts via ?on_conflict=cloudbeds_reservation_id.
-- The partial index in the foundation migration is not enough for this.

alter table public.reservations
  add constraint reservations_cloudbeds_reservation_id_key
  unique (cloudbeds_reservation_id);
