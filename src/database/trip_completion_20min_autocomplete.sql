-- ============================================================================
-- PamojaRide — Trip completion: 20-minute passenger confirmation window,
-- with genuine PER-PASSENGER auto-completion on timeout.
--
-- Run this whole script once in the Supabase SQL Editor, AFTER every file
-- already in src/database — specifically after
-- trip_completion_individual_confirmations.sql and
-- trip_lifecycle_hardening_and_reminders.sql (this file only
-- CREATE OR REPLACEs complete_trip() and auto_complete_pending_trips(), and
-- widens two existing CHECK constraints — nothing is dropped, no row is
-- deleted, no table is duplicated). Idempotent — safe to re-run.
--
-- This deliberately does NOT touch respond_trip_completion() — the
-- Accept/Decline path (including the admin-report-on-decline logic added
-- in trip_lifecycle_hardening_and_reminders.sql) is unchanged and correct
-- as-is; only the "what happens if nobody responds" side of the workflow
-- changes here.
-- ============================================================================
--
-- ROOT CAUSE OF THE GAP THIS FIXES:
--
--   trip_completion_individual_confirmations.sql already made each
--   passenger's Accept/Decline fully independent — but its 48-hour
--   "backstop" (auto_complete_pending_trips()) only ever closed the TRIP's
--   own status once EVERY passenger had personally answered. A passenger
--   who simply never opened the app stayed 'pending' forever: their
--   booking never became 'completed' (so they could never be rated or
--   rate the driver), and — worse — the trip itself could never finalize
--   either, because "zero remaining pending" was never reached. This
--   migration makes the timeout genuinely per-passenger, exactly as
--   requested:
--     - The window is now 20 minutes (was 48 hours), set once when the
--       driver requests completion (complete_trip()) — unchanged for
--       every trip already in flight when this migration runs; only
--       newly-requested completions use the new 20-minute window.
--     - auto_complete_pending_trips() (name kept, so the existing
--       pg_cron job and lib/tripCompletion.js's nudgeAutoCompletion()
--       both keep working with zero other changes) now walks every
--       STILL-PENDING passenger confirmation on a trip whose deadline has
--       passed, and for each one:
--         * sets response = 'auto_completed' (new, distinct from
--           'accepted' — see the widened CHECK constraint below) so the
--           driver/admin can always tell "the passenger actively
--           confirmed" apart from "nobody answered in time",
--         * marks ONLY that passenger's own booking 'completed',
--         * notifies ONLY that passenger, with a message that explains
--           it happened automatically.
--     - A passenger who already answered (accepted OR declined) is never
--       touched by this — the query only ever looks at response =
--       'pending' rows, so a rejection can never be silently overwritten
--       into a completion after the fact, exactly as required.
--     - Once no passenger is left pending, the trip itself finalizes to
--       'completed', same as the manual-response path already does.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Widen the response CHECK on trip_completion_confirmations to allow
--    the new 'auto_completed' outcome, alongside the existing
--    'pending' / 'accepted' / 'declined'. Default-named constraint from
--    the original inline `ADD COLUMN ... CHECK (...)` in
--    trip_completion_individual_confirmations.sql, so this is the actual
--    constraint name Postgres would have generated for it.
-- ----------------------------------------------------------------------------

ALTER TABLE public.trip_completion_confirmations
  DROP CONSTRAINT IF EXISTS trip_completion_confirmations_response_check;
ALTER TABLE public.trip_completion_confirmations
  ADD CONSTRAINT trip_completion_confirmations_response_check
  CHECK (response = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'auto_completed'::text]));

-- ----------------------------------------------------------------------------
-- 2. One new notification type for "you didn't respond in time, so this
--    was auto-completed" — additive only, every existing type is kept.
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
    'trip_completion_auto_completed'::text,
    'kyc_submitted'::text, 'kyc_approved'::text, 'kyc_rejected'::text,
    'verification_required'::text, 'account_suspended'::text, 'account_reactivated'::text,
    'account_banned'::text,
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text,
    'complaint_submitted'::text,
    'support_request_submitted'::text, 'support_update'::text
  ]));

-- ----------------------------------------------------------------------------
-- 3. complete_trip(): only the deadline and the passenger-facing message
--    text change (20 minutes, and the exact wording requested) — the
--    authorization/guard rules and the zero-passengers immediate-complete
--    path are byte-for-byte the same as
--    trip_completion_individual_confirmations.sql.
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

  -- ── CHANGED: 20-minute window (was 48 hours), per the brief. This is
  --    still only ever a backstop for a passenger who never answers —
  --    see auto_complete_pending_trips() below for what actually happens
  --    once it passes.
  UPDATE public.trips
    SET status = 'completion_pending',
        completion_requested_at = now(),
        completion_deadline = now() + interval '20 minutes',
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

    -- ── CHANGED: exact wording requested, including the 20-minute /
    --    auto-complete explanation up front so a passenger who only ever
    --    sees the toast (never opens the popup) still knows the rule.
    PERFORM public.notify(
      v_booking.passenger_id, 'trip_completion_pending', 'Confirm your trip is complete',
      format(
        'The driver has marked this trip as complete. Please confirm whether the trip from %s to %s was completed successfully. If you do not respond within 20 minutes, the trip will automatically be marked as complete.',
        v_trip.origin, v_trip.destination
      ),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.booking_id)
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_trip(uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_trip_completion_status(): adds auto_completed_count so the
--    driver/passenger-facing summary can show "X accepted · Y declined ·
--    Z auto-completed · W awaiting" instead of silently folding
--    auto-completions into "accepted". caller_response already surfaces
--    'auto_completed' for the calling passenger with zero changes (it was
--    always just "whatever this row's response column says").
--    Dropped first: adding a column to the RETURNS TABLE shape is a
--    different function signature, same reason every other shape change
--    in this project has needed a DROP first.
-- ----------------------------------------------------------------------------

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
   auto_completed_count integer,
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
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.response = 'auto_completed'),
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.response = 'pending'),
    (SELECT c.response FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.passenger_id = v_caller),
    (SELECT c.decline_reason FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.passenger_id = v_caller),
    v_trip.auto_completed,
    v_trip.completed_at;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_trip_completion_status(uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 5. auto_complete_pending_trips(): kept under its existing name (the
--    pg_cron job already scheduled by trip_auto_completion.sql, and
--    lib/tripCompletion.js's nudgeAutoCompletion(), both call it by name —
--    no re-scheduling or frontend change needed) but now does real
--    per-passenger auto-completion instead of only closing the trip.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_complete_pending_trips()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_confirmation RECORD;
  v_finalized integer := 0;
BEGIN
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'completion_pending'
      AND completion_deadline IS NOT NULL
      AND completion_deadline <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);

    -- Auto-complete every STILL-PENDING passenger on this trip — never one
    -- who already accepted or declined. Each passenger's own booking is
    -- the only thing touched per iteration, exactly like
    -- respond_trip_completion()'s manual-accept path.
    FOR v_confirmation IN
      SELECT * FROM public.trip_completion_confirmations
      WHERE trip_id = v_trip.id AND response = 'pending'
      FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.trip_completion_confirmations
        SET response = 'auto_completed', responded_at = now(), confirmed_at = now()
        WHERE id = v_confirmation.id;

      UPDATE public.bookings
        SET status = 'completed'
        WHERE id = v_confirmation.booking_id AND status = 'confirmed';

      PERFORM public.notify(
        v_confirmation.passenger_id, 'trip_completion_auto_completed', 'Trip automatically marked complete',
        format(
          'You did not respond within 20 minutes, so your trip from %s to %s has been automatically marked as completed.',
          v_trip.origin, v_trip.destination
        ),
        jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_confirmation.booking_id, 'auto_completed', true)
      );
    END LOOP;

    -- Every passenger has now either accepted, declined, or just been
    -- auto-completed above — nobody is left pending, so the trip itself
    -- can always finalize here (this mirrors the "zero remaining pending"
    -- finalization in respond_trip_completion(), just reached via timeout
    -- instead of a manual response).
    UPDATE public.trips
      SET status = 'completed', completed_at = now(), auto_completed = true
      WHERE id = v_trip.id;

    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

    v_finalized := v_finalized + 1;
  END LOOP;

  RETURN v_finalized;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.auto_complete_pending_trips() TO authenticated;

-- pg_cron schedule from trip_auto_completion.sql already points at
-- auto_complete_pending_trips() by name, running every minute — with a
-- 20-minute window that's frequent enough that no trip will sit
-- unfinalized for more than a minute past its deadline. No re-scheduling
-- needed. To verify:
--   SELECT jobid, jobname, schedule, active FROM cron.job
--   WHERE jobname = 'pamojaride-auto-complete-trips';

-- ============================================================================
-- End of migration. respond_trip_completion(), get_trip_passenger_completions()
-- (which already returns whatever `response` a row holds, so 'auto_completed'
-- shows up there with zero changes), RLS policies, ratings, cancellations,
-- reminders, and every other function/table are untouched.
-- ============================================================================
