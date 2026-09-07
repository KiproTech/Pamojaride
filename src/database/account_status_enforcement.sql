-- ============================================================================
-- PamojaRide — close ban-bypass gap in RLS (account_status enforcement)
-- ============================================================================
-- Found via live schema/policy introspection: is_verified_driver() only
-- checks verification_status = 'verified'. It does NOT check account_status.
-- So a driver who was verified and later banned/suspended could still pass
-- trips_insert_verified_driver's WITH CHECK and create trips directly via
-- the Supabase client, completely bypassing the ban — the frontend route
-- guard (ProtectedRoute → Banned page) only stops them from clicking
-- "Create Trip" in the UI, not from calling the API directly.
--
-- Same gap on the passenger side: bookings_insert_own only checks
-- passenger_id = auth.uid() and trip capacity — a banned passenger could
-- still create bookings.
--
-- This migration is a straight "CREATE OR REPLACE" on is_verified_driver()
-- (same function, all existing callers keep working unchanged) plus one
-- new helper + a policy replacement on bookings. No data is touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_verified_driver(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.driver_profiles
    where profile_id = uid
      and verification_status = 'verified'
      and account_status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_active_passenger(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.passenger_profiles
    where profile_id = uid
      and account_status = 'active'
  );
$function$;

-- bookings_insert_own: same policy as before, with an added
-- is_active_passenger() check. A suspended/banned passenger can still be
-- SELECTed (to see their own past bookings, per bookings_select_participant_or_admin)
-- but can no longer create new ones.
drop policy if exists "bookings_insert_own" on public.bookings;
create policy "bookings_insert_own"
on public.bookings for insert
to authenticated
with check (
  passenger_id = auth.uid()
  and public.is_active_passenger(auth.uid())
  and exists (
    select 1 from trips t
    where t.id = bookings.trip_id
      and t.status = 'scheduled'
      and t.available_seats >= bookings.seats_booked
  )
);

-- ── Optional: give bans their own notification type ─────────────────────
-- The current notifications.type CHECK doesn't include 'account_banned', so
-- the admin UI correctly falls back to 'admin_announcement' for bans today.
-- This adds the dedicated type so bans and suspensions are distinguishable
-- in the notifications table going forward. Existing rows are untouched;
-- this only affects what NEW rows are allowed to say.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = ANY (ARRAY[
    'booking_created'::text, 'booking_confirmed'::text, 'booking_cancelled'::text,
    'trip_cancelled'::text, 'trip_reminder'::text, 'trip_completed'::text,
    'kyc_submitted'::text, 'kyc_approved'::text, 'kyc_rejected'::text,
    'verification_required'::text, 'account_suspended'::text, 'account_reactivated'::text,
    'account_banned'::text,
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text
  ]));
