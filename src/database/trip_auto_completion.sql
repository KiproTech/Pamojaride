-- ============================================================================
-- PamojaRide — 20-minute automatic trip completion
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- driver_trip_cancellation.sql / bookings_trips_hardening.sql (it replaces
-- complete_trip() and extends protect_trips_privileged_columns() defined
-- there — everything else in those files is untouched).
-- ============================================================================
--
-- What this does:
--   1. Adds the "completion_pending" trip status plus the bookkeeping
--      columns needed to run a 20-minute passenger-confirmation window.
--   2. Adds a trip_completion_confirmations table — one row per passenger
--      who has confirmed a given trip is finished.
--   3. Replaces complete_trip() so a driver marking a trip finished no
--      longer completes it instantly. Instead:
--        - If the trip has zero confirmed passengers, it still completes
--          immediately (nothing to confirm) — unchanged from before.
--        - Otherwise the trip moves to 'completion_pending', a 20-minute
--          deadline is stored on the row, and every passenger with a
--          confirmed booking is notified to confirm.
--   4. Adds confirm_trip_completion() — a passenger RPC that records their
--      confirmation and finalizes the trip the moment >= 50% of the
--      passengers who were on it when the countdown started have confirmed.
--   5. Adds auto_complete_pending_trips() — a server-side function that
--      finalizes any trip whose 20-minute deadline has passed without
--      enough confirmations. This is the piece that makes the timeout real
--      even if every browser involved is closed: it is meant to be run on
--      a schedule by pg_cron (set up at the bottom of this file), not by
--      any frontend timer.
--   6. Adds get_trip_completion_status() — a read-only RPC the driver and
--      passenger UIs poll to show "3 of 5 confirmed · 12m left".
--   7. Extends the existing privileged-column trigger and notifications
--      type check to cover the new columns/notification type.
--
-- Nothing here touches payments/refunds, cancellation, verification,
-- bookings creation, or any other existing RPC/table not listed above.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1a. New columns on trips for the completion-pending countdown.
-- ----------------------------------------------------------------------------

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS completion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS completion_total_passengers integer,
  ADD COLUMN IF NOT EXISTS completion_required_confirmations integer,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_completed boolean NOT NULL DEFAULT false;

-- 1b. Allow the new 'completion_pending' status value.
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_status_check;
ALTER TABLE public.trips ADD CONSTRAINT trips_status_check
  CHECK (status = ANY (ARRAY[
    'scheduled'::text, 'ongoing'::text, 'completion_pending'::text,
    'completed'::text, 'cancelled'::text, 'expired'::text
  ]));

-- 1c. Partial index so the timeout scan (WHERE status = 'completion_pending'
--     AND completion_deadline <= now()) never scans the whole table.
CREATE INDEX IF NOT EXISTS idx_trips_completion_pending
  ON public.trips (completion_deadline)
  WHERE status = 'completion_pending';

-- ----------------------------------------------------------------------------
-- 2. trip_completion_confirmations — one row per passenger confirmation.
--    UNIQUE(trip_id, passenger_id) makes a double click / double RPC call a
--    no-op instead of double-counting (handled via ON CONFLICT DO NOTHING
--    in confirm_trip_completion below).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.trip_completion_confirmations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  passenger_id uuid NOT NULL REFERENCES public.profiles(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_completion_confirmations_pkey PRIMARY KEY (id),
  CONSTRAINT trip_completion_confirmations_unique UNIQUE (trip_id, passenger_id)
);

ALTER TABLE public.trip_completion_confirmations ENABLE ROW LEVEL SECURITY;

-- Read-only for the people who have a legitimate reason to see it. All
-- writes happen exclusively through the SECURITY DEFINER RPCs below (there
-- are deliberately no INSERT/UPDATE/DELETE policies here), the same
-- pattern already used for trips/bookings' privileged columns.
DROP POLICY IF EXISTS "passenger can view own confirmations" ON public.trip_completion_confirmations;
CREATE POLICY "passenger can view own confirmations"
ON public.trip_completion_confirmations FOR SELECT
USING (passenger_id = auth.uid());

DROP POLICY IF EXISTS "driver can view confirmations for own trips" ON public.trip_completion_confirmations;
CREATE POLICY "driver can view confirmations for own trips"
ON public.trip_completion_confirmations FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.trips t WHERE t.id = trip_completion_confirmations.trip_id AND t.driver_id = auth.uid()
));

DROP POLICY IF EXISTS "admin can view all confirmations" ON public.trip_completion_confirmations;
CREATE POLICY "admin can view all confirmations"
ON public.trip_completion_confirmations FOR SELECT
USING (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- 3. Extend the trips privileged-columns trigger (from
--    bookings_trips_hardening.sql) to also guard the new completion columns.
--    Same admin / pamojaride.system_update carve-outs as before.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_trips_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('pamojaride.system_update', true), '') = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.available_seats IS DISTINCT FROM OLD.available_seats
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.total_seats IS DISTINCT FROM OLD.total_seats
     OR NEW.completion_requested_at IS DISTINCT FROM OLD.completion_requested_at
     OR NEW.completion_deadline IS DISTINCT FROM OLD.completion_deadline
     OR NEW.completion_total_passengers IS DISTINCT FROM OLD.completion_total_passengers
     OR NEW.completion_required_confirmations IS DISTINCT FROM OLD.completion_required_confirmations
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.auto_completed IS DISTINCT FROM OLD.auto_completed
  THEN
    RAISE EXCEPTION 'This field can only be changed by the system or an administrator';
  END IF;

  RETURN NEW;
END;
$function$;
-- Trigger trg_protect_trips_privileged_columns already points at this
-- function name — no need to touch the trigger itself.

-- ----------------------------------------------------------------------------
-- 4. Notifications: add the 'trip_completion_pending' type (same pattern as
--    account_status_enforcement.sql's 'account_banned' addition). Existing
--    types, including 'trip_completed' (reused for both a confirmation-
--    triggered and an auto-triggered completion), are untouched.
-- ----------------------------------------------------------------------------

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'booking_created'::text, 'booking_confirmed'::text, 'booking_cancelled'::text,
    'trip_cancelled'::text, 'trip_reminder'::text, 'trip_completion_pending'::text,
    'trip_completed'::text,
    'kyc_submitted'::text, 'kyc_approved'::text, 'kyc_rejected'::text,
    'verification_required'::text, 'account_suspended'::text, 'account_reactivated'::text,
    'account_banned'::text,
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text
  ]));

-- ----------------------------------------------------------------------------
-- 5. complete_trip(): driver/admin action that now STARTS the 20-minute
--    window instead of completing the trip outright (unless there is no
--    one to confirm with, in which case behaviour is unchanged).
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
  v_required integer;
  v_passenger RECORD;
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

  SELECT count(DISTINCT passenger_id) INTO v_total_passengers
  FROM public.bookings
  WHERE trip_id = p_trip_id AND status = 'confirmed';

  -- Set once, up front, so it covers every privileged write below (trips,
  -- bookings, profiles.trips_completed) for the rest of this transaction.
  PERFORM set_config('pamojaride.system_update', 'true', true);

  IF v_total_passengers = 0 THEN
    -- Nothing to confirm — complete immediately, exactly as before this
    -- feature existed.
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id
      RETURNING * INTO v_trip;

    UPDATE public.bookings SET status = 'completed' WHERE trip_id = p_trip_id AND status = 'confirmed';
    UPDATE public.profiles SET trips_completed = trips_completed + 1 WHERE id = v_trip.driver_id;

    RETURN v_trip;
  END IF;

  v_required := ceil(v_total_passengers / 2.0)::integer;

  UPDATE public.trips
    SET status = 'completion_pending',
        completion_requested_at = now(),
        completion_deadline = now() + interval '20 minutes',
        completion_total_passengers = v_total_passengers,
        completion_required_confirmations = v_required
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  FOR v_passenger IN
    SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = p_trip_id AND status = 'confirmed'
  LOOP
    PERFORM public.notify(
      v_passenger.passenger_id, 'trip_completion_pending', 'Confirm your trip is complete',
      format('Your driver marked the trip %s -> %s as finished. Please confirm in the app within 20 minutes — once enough passengers confirm (or the 20 minutes run out), it will be marked completed automatically.',
        v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id)
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 6. confirm_trip_completion(): passenger action. Idempotent (a repeat
--    confirmation from the same passenger is a no-op), and finalizes the
--    trip itself the instant the required threshold is reached.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_trip_completion(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_has_booking boolean;
  v_confirmed_count integer;
  v_passenger RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Must be authenticated to confirm trip completion';
  END IF;

  -- Locks the row: if auto_complete_pending_trips() is finalizing this same
  -- trip concurrently, this blocks until that commits, then re-reads the
  -- now-'completed' row and correctly raises below instead of double-
  -- processing it.
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  IF v_trip.status <> 'completion_pending' THEN
    RAISE EXCEPTION 'This trip is not awaiting completion confirmation (status: %)', v_trip.status;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.bookings
    WHERE trip_id = p_trip_id AND passenger_id = v_caller AND status IN ('confirmed', 'completed')
  ) INTO v_has_booking;

  IF NOT v_has_booking THEN
    RAISE EXCEPTION 'Only passengers with a confirmed booking on this trip may confirm its completion';
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  INSERT INTO public.trip_completion_confirmations (trip_id, passenger_id)
  VALUES (p_trip_id, v_caller)
  ON CONFLICT ON CONSTRAINT trip_completion_confirmations_unique DO NOTHING;

  SELECT count(*) INTO v_confirmed_count
  FROM public.trip_completion_confirmations
  WHERE trip_id = p_trip_id;

  IF v_confirmed_count >= v_trip.completion_required_confirmations THEN
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id
      RETURNING * INTO v_trip;

    UPDATE public.bookings SET status = 'completed' WHERE trip_id = p_trip_id AND status = 'confirmed';
    UPDATE public.profiles SET trips_completed = trips_completed + 1 WHERE id = v_trip.driver_id;

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = p_trip_id AND status = 'completed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_completed', 'Trip completed',
        format('Your trip %s -> %s has been confirmed completed by passengers.', v_trip.origin, v_trip.destination),
        jsonb_build_object('trip_id', v_trip.id, 'auto_completed', false)
      );
    END LOOP;
  END IF;

  RETURN v_trip;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 7. auto_complete_pending_trips(): the server-side timeout enforcer. Meant
--    to be invoked on a schedule (see pg_cron setup at the bottom) — this is
--    what makes the 20-minute limit real even with every browser closed.
--
--    FOR UPDATE SKIP LOCKED means two overlapping runs of this function (or
--    a run overlapping with a passenger's confirm_trip_completion call)
--    never block each other or double-process the same trip: whichever
--    transaction gets the row first wins, the other simply skips it (and,
--    for confirm_trip_completion, re-checks status after acquiring its own
--    lock — see above).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_complete_pending_trips()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_passenger RECORD;
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

    UPDATE public.bookings SET status = 'completed' WHERE trip_id = v_trip.id AND status = 'confirmed';
    UPDATE public.profiles SET trips_completed = trips_completed + 1 WHERE id = v_trip.driver_id;

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = v_trip.id AND status = 'completed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_completed', 'Trip automatically completed',
        format('Your trip %s -> %s was automatically marked completed after the 20-minute confirmation window closed.',
          v_trip.origin, v_trip.destination),
        jsonb_build_object('trip_id', v_trip.id, 'auto_completed', true)
      );
    END LOOP;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN v_processed;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 8. get_trip_completion_status(): read-only status for the driver's
--    "Mark completed" card and the passenger's "Confirm completion" card.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_trip_completion_status(p_trip_id uuid)
 RETURNS TABLE (
   trip_id uuid,
   status text,
   completion_requested_at timestamptz,
   completion_deadline timestamptz,
   seconds_remaining integer,
   total_passengers integer,
   required_confirmations integer,
   confirmed_count integer,
   caller_confirmed boolean,
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
    v_trip.completion_total_passengers,
    v_trip.completion_required_confirmations,
    (SELECT count(*)::integer FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id),
    (EXISTS (SELECT 1 FROM public.trip_completion_confirmations c WHERE c.trip_id = p_trip_id AND c.passenger_id = v_caller)),
    v_trip.auto_completed,
    v_trip.completed_at;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 9. Grants. Postgres grants EXECUTE on new functions to PUBLIC by default,
--    same as every other RPC in this project, but these are explicit for
--    clarity. auto_complete_pending_trips is safe to expose to authenticated
--    users too: it only ever finalizes trips whose deadline has already
--    passed, so the frontend can opportunistically call it (e.g. on page
--    load) as a defense-in-depth backup — pg_cron below remains the
--    mechanism that guarantees it runs with nobody's browser open at all.
-- ----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.confirm_trip_completion(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trip_completion_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.auto_complete_pending_trips() TO authenticated;

-- ============================================================================
-- 10. pg_cron: schedule the real, server-side enforcement of the 20-minute
--     limit. Run this section once (it's idempotent — cron.schedule with a
--     job name that already exists just updates it in modern pg_cron, but
--     the unschedule-first line below makes that explicit either way).
--
--     REQUIRES the pg_cron extension. In the Supabase dashboard:
--     Database -> Extensions -> enable "pg_cron" (and "pg_net" is not
--     needed here since this calls the SQL function directly, not an
--     HTTP endpoint). Then run the two statements below in the SQL Editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pamojaride-auto-complete-trips';

SELECT cron.schedule(
  'pamojaride-auto-complete-trips',
  '* * * * *',                      -- every minute
  $$ SELECT public.auto_complete_pending_trips(); $$
);

-- To verify the job is registered:
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'pamojaride-auto-complete-trips';
-- To see its run history:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
