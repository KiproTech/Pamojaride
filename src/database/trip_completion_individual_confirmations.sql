-- ============================================================================
-- PamojaRide — Individual (per-passenger) trip completion confirmation
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- trip_auto_completion.sql and password_reset_and_trips_completed_fix.sql
-- (it CREATE OR REPLACEs complete_trip(), confirm_trip_completion() [kept
-- as a thin backward-compatible alias], auto_complete_pending_trips(), and
-- get_trip_completion_status() defined there — everything else in those
-- files, and every other file, is untouched). Idempotent — safe to re-run.
-- ============================================================================
--
-- WHY THIS REPLACES THE EXISTING WORKFLOW:
--
--   trip_auto_completion.sql's complete_trip() started a 20-minute window
--   in which the trip completed for EVERY confirmed passenger the moment
--   >= 50% of them confirmed (or the window timed out) — one shared
--   "trip-level" outcome. That directly conflicts with the requirement
--   that each passenger's confirmation be independent: a passenger who
--   never boarded, or whose trip didn't happen, could get swept into
--   "completed" (and become rateable) purely because other passengers on
--   the same trip confirmed, and there was no way for a passenger to
--   actively say "no, this didn't happen" with a reason.
--
--   This migration keeps the same table (trip_completion_confirmations)
--   and the same general shape (driver starts it, passengers respond,
--   a scheduled job closes the window) but makes the unit of confirmation
--   the INDIVIDUAL passenger, never a majority:
--     - Driver marks trip finished -> every confirmed passenger gets their
--       OWN 'pending' confirmation row + notification, individually.
--     - Passenger accepts -> ONLY THAT passenger's booking becomes
--       'completed' (unlocking rating for them specifically).
--     - Passenger declines -> a reason is required, ONLY THAT passenger's
--       booking is marked 'no_show' (never 'completed'), the driver is
--       notified with the reason, and it's visible to admins. No other
--       passenger's booking is touched.
--     - A passenger who never responds simply stays 'pending' — nothing
--       ever auto-accepts on their behalf.
--   The trip record itself still needs a real end-state for the driver's
--   dashboard / admin oversight lists, so once every passenger who was
--   asked has answered (accepted or declined — no one left 'pending'),
--   OR a 48-hour deadline passes (whichever first), the TRIP is finalized
--   to 'completed'. That finalization never touches an individual
--   passenger's still-pending confirmation or their booking status.
--
-- WHAT THIS DOES NOT CHANGE:
--   - The `trip_completion_confirmations` table is extended, not replaced
--     (no duplicate table). Its RLS policies (SELECT-only, all writes via
--     SECURITY DEFINER RPCs) are untouched.
--   - `public.ratings` / rating_relationship_is_valid() (see
--     ratings_security_hardening.sql) are untouched and need no change:
--     they already gate on `bookings.status = 'completed'`, which this
--     migration continues to set only when THAT passenger personally
--     accepted — so "can only rate after personally confirming
--     completion" (and "only a booking on their own trip") keep working
--     exactly as designed, with no new code.
--   - Booking cancellation, trip cancellation, seat counting, payments —
--     none of that is touched.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extend trip_completion_confirmations with the columns an individual,
--    reasoned accept/decline needs. `confirmed_at` (existing column) is
--    kept for backward compatibility and now means "the row was last
--    touched" (set at request time and again on accept); the new columns
--    carry the actual per-passenger workflow state.
-- ----------------------------------------------------------------------------

ALTER TABLE public.trip_completion_confirmations
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES public.bookings(id),
  ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS response text NOT NULL DEFAULT 'pending'
    CHECK (response = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])),
  ADD COLUMN IF NOT EXISTS decline_reason text,
  ADD COLUMN IF NOT EXISTS decline_comment text,
  ADD COLUMN IF NOT EXISTS responded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_trip_completion_confirmations_booking_id
  ON public.trip_completion_confirmations (booking_id);

-- Backfill booking_id for any pre-existing rows from the old majority-vote
-- workflow (harmless no-op on a fresh install where the table is empty).
UPDATE public.trip_completion_confirmations c
SET booking_id = b.id
FROM public.bookings b
WHERE c.booking_id IS NULL
  AND b.trip_id = c.trip_id
  AND b.passenger_id = c.passenger_id;

-- ----------------------------------------------------------------------------
-- 2. Notifications: two new types for the driver-facing side of an
--    individual passenger's response. Every type ever added by any other
--    migration in this project (booking_no_show, trip_started,
--    complaint_submitted, support_request_submitted/update, etc.) is
--    preserved below — this is additive only.
-- ----------------------------------------------------------------------------

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'booking_created'::text, 'booking_confirmed'::text, 'booking_cancelled'::text,
    'booking_no_show'::text,
    'trip_started'::text, 'trip_cancelled'::text, 'trip_reminder'::text,
    'trip_completion_pending'::text, 'trip_completed'::text,
    'trip_completion_confirmed_by_passenger'::text,
    'trip_completion_declined_by_passenger'::text,
    'kyc_submitted'::text, 'kyc_approved'::text, 'kyc_rejected'::text,
    'verification_required'::text, 'account_suspended'::text, 'account_reactivated'::text,
    'account_banned'::text,
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text,
    'complaint_submitted'::text,
    'support_request_submitted'::text, 'support_update'::text
  ]));

-- ----------------------------------------------------------------------------
-- 3. complete_trip(): driver/admin action. Unchanged authorization/guard
--    rules from trip_auto_completion.sql (must own the trip or be admin,
--    trip must be scheduled/ongoing, departure time must have passed,
--    trips with zero confirmed passengers complete immediately). What
--    changes is what happens when there ARE passengers: instead of a
--    single majority threshold, every confirmed passenger gets their own
--    'pending' row and notification.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_trip(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_total_passengers integer;
  v_booking RECORD;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF NOT (v_trip.driver_id = v_caller OR public.is_admin(v_caller)) THEN
    RAISE EXCEPTION 'Not authorized to complete this trip';
  END IF;
  IF v_trip.status NOT IN ('scheduled', 'ongoing') THEN
    RAISE EXCEPTION 'Trip is already % and cannot be completed', v_trip.status;
  END IF;
  IF v_trip.departure_time > now() THEN
    RAISE EXCEPTION 'Trip cannot be marked completed before its departure time';
  END IF;

  SELECT count(*) INTO v_total_passengers
  FROM public.bookings
  WHERE trip_id = p_trip_id AND status = 'confirmed';

  PERFORM set_config('pamojaride.system_update', 'true', true);

  IF v_total_passengers = 0 THEN
    -- Nothing to confirm — complete immediately, exactly as before.
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id
      RETURNING * INTO v_trip;

    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;
    RETURN v_trip;
  END IF;

  -- 48-hour window is a backstop only (so a trip doesn't sit open forever
  -- if a passenger simply never opens the app again) — it is NEVER used to
  -- decide any individual passenger's outcome; see auto_complete_pending_trips()
  -- below, which only ever closes the TRIP's own status, never a booking.
  UPDATE public.trips
    SET status = 'completion_pending',
        completion_requested_at = now(),
        completion_deadline = now() + interval '48 hours',
        completion_total_passengers = v_total_passengers,
        completion_required_confirmations = NULL
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  FOR v_booking IN
    SELECT b.id AS booking_id, b.passenger_id
    FROM public.bookings b
    WHERE b.trip_id = p_trip_id AND b.status = 'confirmed'
  LOOP
    INSERT INTO public.trip_completion_confirmations
      (trip_id, passenger_id, booking_id, requested_at, response, confirmed_at)
    VALUES (p_trip_id, v_booking.passenger_id, v_booking.booking_id, now(), 'pending', now())
    ON CONFLICT ON CONSTRAINT trip_completion_confirmations_unique DO UPDATE
      SET booking_id = EXCLUDED.booking_id,
          requested_at = now(),
          response = 'pending',
          decline_reason = NULL,
          decline_comment = NULL,
          responded_at = NULL,
          confirmed_at = now();

    PERFORM public.notify(
      v_booking.passenger_id, 'trip_completion_pending', 'Confirm your trip is complete',
      format('Your driver has marked your trip from %s to %s as completed. Please confirm whether you completed this journey.',
        v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.booking_id)
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 4. respond_trip_completion(): the passenger action — Accept or Decline,
--    entirely independent of every other passenger on the same trip.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.respond_trip_completion(
  p_trip_id uuid,
  p_response text,
  p_decline_reason text DEFAULT NULL,
  p_decline_comment text DEFAULT NULL
) RETURNS public.trip_completion_confirmations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_trip public.trips%ROWTYPE;
  v_confirmation public.trip_completion_confirmations%ROWTYPE;
  v_passenger_name text;
  v_remaining_pending integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Must be authenticated to respond to a trip completion request';
  END IF;
  IF p_response NOT IN ('accepted', 'declined') THEN
    RAISE EXCEPTION 'Invalid response';
  END IF;

  -- Locks the trip row so this can't race auto_complete_pending_trips()
  -- flipping the trip's own status mid-response.
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF v_trip.status <> 'completion_pending' THEN
    RAISE EXCEPTION 'This trip is not awaiting completion confirmation (status: %)', v_trip.status;
  END IF;

  SELECT * INTO v_confirmation
  FROM public.trip_completion_confirmations
  WHERE trip_id = p_trip_id AND passenger_id = v_caller
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'You do not have a pending completion confirmation for this trip';
  END IF;
  IF v_confirmation.response <> 'pending' THEN
    RAISE EXCEPTION 'You have already responded to this trip''s completion request';
  END IF;

  IF p_response = 'declined' THEN
    IF p_decline_reason IS NULL OR btrim(p_decline_reason) = '' THEN
      RAISE EXCEPTION 'A reason is required to decline a trip completion confirmation';
    END IF;
    IF p_decline_reason = 'other' AND (p_decline_comment IS NULL OR btrim(p_decline_comment) = '') THEN
      RAISE EXCEPTION 'Please add a short comment when selecting "Other"';
    END IF;
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.trip_completion_confirmations
    SET response = p_response,
        responded_at = now(),
        confirmed_at = now(),
        decline_reason = CASE WHEN p_response = 'declined' THEN p_decline_reason ELSE NULL END,
        decline_comment = CASE WHEN p_response = 'declined' THEN nullif(btrim(p_decline_comment), '') ELSE NULL END
    WHERE id = v_confirmation.id
    RETURNING * INTO v_confirmation;

  IF p_response = 'accepted' THEN
    -- Only THIS passenger's booking — never any other passenger's.
    UPDATE public.bookings SET status = 'completed' WHERE id = v_confirmation.booking_id AND status = 'confirmed';
  ELSE
    UPDATE public.bookings SET status = 'no_show' WHERE id = v_confirmation.booking_id AND status = 'confirmed';
  END IF;

  SELECT full_name INTO v_passenger_name FROM public.profiles WHERE id = v_caller;

  IF p_response = 'accepted' THEN
    PERFORM public.notify(
      v_trip.driver_id, 'trip_completion_confirmed_by_passenger', 'Passenger confirmed trip completion',
      format('%s has confirmed that they completed the trip %s -> %s.',
        coalesce(v_passenger_name, 'A passenger'), v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_confirmation.booking_id, 'passenger_id', v_caller)
    );
  ELSE
    PERFORM public.notify(
      v_trip.driver_id, 'trip_completion_declined_by_passenger', 'Passenger declined trip completion',
      format('%s declined to confirm completion of the trip %s -> %s. Reason: %s.',
        coalesce(v_passenger_name, 'A passenger'), v_trip.origin, v_trip.destination, p_decline_reason),
      jsonb_build_object(
        'trip_id', v_trip.id, 'booking_id', v_confirmation.booking_id, 'passenger_id', v_caller,
        'decline_reason', p_decline_reason, 'decline_comment', p_decline_comment
      )
    );
  END IF;

  -- Finalize the TRIP itself once nobody is left 'pending' — this closes
  -- out the driver/admin-facing trip status, and never overrides any
  -- individual passenger's already-recorded accept/decline.
  SELECT count(*) INTO v_remaining_pending
  FROM public.trip_completion_confirmations
  WHERE trip_id = p_trip_id AND response = 'pending';

  IF v_remaining_pending = 0 THEN
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id AND status = 'completion_pending';
    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;
  END IF;

  RETURN v_confirmation;
END;
$function$;

-- Backward-compatible alias for any old client code still calling
-- confirm_trip_completion(p_trip_id) directly — behaves as an Accept.
-- The old version of this function (trip_auto_completion.sql) returned
-- `trips`; this one returns `trip_completion_confirmations`, so Postgres
-- won't let a plain CREATE OR REPLACE swap the return type — it has to be
-- dropped first. This DROP only removes the old function definition, never
-- any data.
DROP FUNCTION IF EXISTS public.confirm_trip_completion(uuid);

CREATE FUNCTION public.confirm_trip_completion(p_trip_id uuid)
 RETURNS public.trip_completion_confirmations
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.respond_trip_completion(p_trip_id, 'accepted', NULL, NULL);
$function$;

-- ----------------------------------------------------------------------------
-- 5. auto_complete_pending_trips(): the 48-hour backstop. Only ever closes
--    the TRIP's own status/completed_at — it never touches a booking or a
--    passenger's confirmation row. A passenger who never responded simply
--    stays 'pending' forever after this runs; their booking stays
--    'confirmed' (never silently becomes 'completed').
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_complete_pending_trips()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_processed integer := 0;
BEGIN
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'completion_pending'
      AND completion_deadline IS NOT NULL
      AND completion_deadline <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);

    UPDATE public.trips
      SET status = 'completed', completed_at = now(), auto_completed = true
      WHERE id = v_trip.id;

    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN v_processed;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 6. get_trip_completion_status(): read-only aggregate summary — powers
--    the driver's/passenger's "3 accepted · 1 declined · 1 pending" card.
--    Replaces the old majority-vote shape (confirmed_count/required) with
--    a per-response breakdown, plus the CALLING passenger's own response
--    (never anyone else's).
-- ----------------------------------------------------------------------------

-- The previous version of this function (trip_auto_completion.sql)
-- returned a different column set (confirmed_count/required_confirmations/
-- caller_confirmed instead of the accepted/declined/pending breakdown
-- below), so — same reason as confirm_trip_completion() above — it has to
-- be dropped before it can be recreated with a different RETURNS TABLE
-- shape. This only removes the old function definition, never any data.
DROP FUNCTION IF EXISTS public.get_trip_completion_status(uuid);

CREATE FUNCTION public.get_trip_completion_status(p_trip_id uuid)
 RETURNS TABLE (
   trip_id uuid,
   status text,
   completion_requested_at timestamptz,
   completion_deadline timestamptz,
   seconds_remaining integer,
   total_passengers integer,
   accepted_count integer,
   declined_count integer,
   pending_count integer,
   caller_response text,
   caller_decline_reason text,
   auto_completed boolean,
   completed_at timestamptz
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_authorized boolean;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  SELECT (
    v_trip.driver_id = v_caller
    OR public.is_admin(v_caller)
    OR EXISTS (SELECT 1 FROM public.bookings WHERE trip_id = p_trip_id AND passenger_id = v_caller)
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized to view this trip''s completion status';
  END IF;

  RETURN QUERY
  SELECT
    v_trip.id,
    v_trip.status,
    v_trip.completion_requested_at,
    v_trip.completion_deadline,
    CASE WHEN v_trip.completion_deadline IS NULL THEN NULL
         ELSE GREATEST(0, EXTRACT(EPOCH FROM (v_trip.completion_deadline - now()))::integer)
    END,
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id),
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.response = 'accepted'),
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.response = 'declined'),
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.response = 'pending'),
    (SELECT c.response FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.passenger_id = v_caller),
    (SELECT c.decline_reason FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.passenger_id = v_caller),
    v_trip.auto_completed,
    v_trip.completed_at;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 7. get_trip_passenger_completions(): the per-passenger breakdown for the
--    driver's own trip and for admin oversight — "who accepted, who
--    declined (and why), who's still pending" for a single trip, one row
--    per passenger. A passenger caller only ever gets their own row back
--    (never another passenger's) — same "row visibility narrows per
--    caller role" idiom used by get_driver_trip_bookings().
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_trip_passenger_completions(p_trip_id uuid)
 RETURNS TABLE (
   confirmation_id uuid,
   booking_id uuid,
   booking_reference text,
   passenger_id uuid,
   passenger_name text,
   passenger_picture text,
   seats_booked integer,
   booking_status text,
   response text,
   decline_reason text,
   decline_comment text,
   requested_at timestamptz,
   responded_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.id,
    b.id,
    b.booking_reference,
    p.id,
    p.full_name,
    p.profile_picture,
    b.seats_booked,
    b.status,
    c.response,
    c.decline_reason,
    c.decline_comment,
    c.requested_at,
    c.responded_at
  FROM public.trip_completion_confirmations c
  JOIN public.bookings b ON b.id = c.booking_id
  JOIN public.profiles p ON p.id = c.passenger_id
  WHERE c.trip_id = p_trip_id
    AND (
      EXISTS (SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.driver_id = auth.uid())
      OR public.is_admin(auth.uid())
      OR c.passenger_id = auth.uid()
    )
  ORDER BY b.created_at ASC;
$function$;

-- ----------------------------------------------------------------------------
-- 8. Grants — same explicit-for-clarity pattern as trip_auto_completion.sql.
-- ----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.respond_trip_completion(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_trip_completion(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trip_completion_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trip_passenger_completions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.auto_complete_pending_trips() TO authenticated;

-- pg_cron schedule from trip_auto_completion.sql already points at
-- auto_complete_pending_trips() by name — CREATE OR REPLACE above is
-- enough to pick up the new behaviour, no re-scheduling needed.

-- ============================================================================
-- End of migration. Nothing else (RLS policies, storage buckets, other
-- tables/functions, ratings, cancellations, payments) was touched.
-- ============================================================================
