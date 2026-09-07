-- ============================================================================
-- PamojaRide — Driver Trip Scheduling: max 2 upcoming trips + overlap/buffer
-- Run this once in the Supabase SQL Editor, AFTER driver_side_final_integration.sql
-- and trip_location_route_validation.sql.
-- ============================================================================
--
-- WHAT THIS REPLACES
-- driver_side_final_integration.sql added a BEFORE INSERT trigger
-- (prevent_concurrent_active_trips) that blocked a driver from creating ANY
-- new trip while they had one "active" (ongoing/completion_pending, or
-- scheduled-but-past-departure). That rule is now too strict — the product
-- requirement is that a driver CAN queue up a second trip while the first
-- is still in progress, as long as it doesn't overlap and respects a
-- safety buffer. This migration drops that trigger/function and replaces
-- it with one that enforces the real rules instead:
--
--   1. A driver may have at most 2 trips at once in a non-terminal status
--      (status NOT IN ('completed','cancelled','expired') — i.e.
--      'scheduled', 'ongoing', or 'completion_pending'). A 3rd is rejected.
--   2. A new trip's [departure_time, estimated_arrival_time + 1h30] window
--      must not overlap any of the driver's other non-terminal trips' same
--      kind of window. This single interval-overlap check also covers
--      "two trips can't start at the same time" (a shared start time is
--      always an overlap) and "must respect the 1h30 safety buffer after
--      the previous trip's estimated arrival" — both are special cases of
--      window overlap, not separate rules to check.
--   3. Once a trip's status becomes 'completed', 'cancelled', or 'expired'
--      it stops counting toward the limit and stops being checked for
--      overlap, so that slot immediately becomes available again — no
--      extra bookkeeping needed since the check always reads live status.
--
-- RACE CONDITIONS: the function takes a per-driver Postgres advisory
-- transaction lock (pg_advisory_xact_lock) as its first step. If a driver
-- has two tabs/requests trying to insert a trip at the same moment, the
-- second one simply waits until the first transaction commits or rolls
-- back, then re-reads the now-current trip list — so two concurrent
-- inserts can never both slip past the count/overlap checks. The lock is
-- released automatically at the end of the transaction.
--
-- SAFE TO RUN MULTIPLE TIMES. Does not touch any table's data, does not
-- remove any other trigger/function/column, and does not change RLS.
-- ============================================================================

-- 1. Helpful index for the per-driver, non-terminal-status lookups this
--    trigger (and driver/Dashboard.jsx, driver/ManageTrips.jsx) already do.
CREATE INDEX IF NOT EXISTS idx_trips_driver_status
  ON public.trips (driver_id, status);

-- 2. Remove the old, now-too-strict trigger and function.
DROP TRIGGER IF EXISTS trg_prevent_concurrent_active_trips ON public.trips;
DROP FUNCTION IF EXISTS public.prevent_concurrent_active_trips();

-- 3. The new scheduling-limit + overlap/buffer enforcement.
CREATE OR REPLACE FUNCTION public.enforce_trip_scheduling_limits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_active_count integer;
  v_new_start timestamptz := NEW.departure_time;
  v_new_end timestamptz := COALESCE(NEW.estimated_arrival_time, NEW.departure_time) + interval '1 hour 30 minutes';
  v_other RECORD;
  v_other_start timestamptz;
  v_other_end timestamptz;
  v_other_arrival timestamptz;
BEGIN
  -- Serialize scheduling decisions per-driver so two concurrent inserts
  -- (two tabs, a double-click, etc.) can't both read the same "before"
  -- state and both pass. Released automatically at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.driver_id::text));

  -- Rule 1: at most 2 non-terminal (upcoming/in-progress) trips at once.
  SELECT count(*) INTO v_active_count
  FROM public.trips
  WHERE driver_id = NEW.driver_id
    AND status NOT IN ('completed', 'cancelled', 'expired');

  IF v_active_count >= 2 THEN
    RAISE EXCEPTION 'You already have 2 scheduled trips. Complete or cancel one before posting another.';
  END IF;

  -- Rule 2: no overlap (including the 1h30 post-arrival safety buffer)
  -- with any of the driver's other non-terminal trips.
  FOR v_other IN
    SELECT departure_time, estimated_arrival_time
    FROM public.trips
    WHERE driver_id = NEW.driver_id
      AND status NOT IN ('completed', 'cancelled', 'expired')
  LOOP
    v_other_start := v_other.departure_time;
    v_other_arrival := COALESCE(v_other.estimated_arrival_time, v_other.departure_time);
    v_other_end := v_other_arrival + interval '1 hour 30 minutes';

    IF v_new_start < v_other_end AND v_other_start < v_new_end THEN
      RAISE EXCEPTION 'Your next trip can start from % because your previous trip is estimated to finish at %.',
        to_char(v_other_end AT TIME ZONE 'Africa/Nairobi', 'FMHH12:MI AM'),
        to_char(v_other_arrival AT TIME ZONE 'Africa/Nairobi', 'FMHH12:MI AM');
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_trip_scheduling_limits ON public.trips;
CREATE TRIGGER trg_enforce_trip_scheduling_limits
BEFORE INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.enforce_trip_scheduling_limits();

-- 4. Read-only helper the frontend calls BEFORE attempting to insert, so it
--    can show a specific, friendly message (or the earliest allowed start
--    time) instead of only finding out after a failed insert. This runs
--    the exact same logic as the trigger (kept in sync deliberately) but
--    never writes anything, so it's safe to call as often as the UI needs
--    (e.g. every time the departure time or locations change).
CREATE OR REPLACE FUNCTION public.check_trip_schedule_availability(
  p_departure_time timestamptz,
  p_estimated_arrival_time timestamptz
)
 RETURNS TABLE (
   allowed boolean,
   reason text,
   earliest_start timestamptz,
   active_trip_count integer
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver uuid := auth.uid();
  v_active_count integer;
  v_new_start timestamptz := p_departure_time;
  v_new_end timestamptz := COALESCE(p_estimated_arrival_time, p_departure_time) + interval '1 hour 30 minutes';
  v_other RECORD;
  v_other_start timestamptz;
  v_other_end timestamptz;
  v_other_arrival timestamptz;
BEGIN
  SELECT count(*) INTO v_active_count
  FROM public.trips
  WHERE driver_id = v_driver
    AND status NOT IN ('completed', 'cancelled', 'expired');

  IF v_active_count >= 2 THEN
    RETURN QUERY SELECT false,
      'You already have 2 scheduled trips. Complete or cancel one before posting another.'::text,
      NULL::timestamptz, v_active_count;
    RETURN;
  END IF;

  FOR v_other IN
    SELECT departure_time, estimated_arrival_time
    FROM public.trips
    WHERE driver_id = v_driver
      AND status NOT IN ('completed', 'cancelled', 'expired')
  LOOP
    v_other_start := v_other.departure_time;
    v_other_arrival := COALESCE(v_other.estimated_arrival_time, v_other.departure_time);
    v_other_end := v_other_arrival + interval '1 hour 30 minutes';

    IF v_new_start < v_other_end AND v_other_start < v_new_end THEN
      RETURN QUERY SELECT false,
        format('Your next trip can start from %s because your previous trip is estimated to finish at %s.',
          to_char(v_other_end AT TIME ZONE 'Africa/Nairobi', 'FMHH12:MI AM'),
          to_char(v_other_arrival AT TIME ZONE 'Africa/Nairobi', 'FMHH12:MI AM')
        ),
        v_other_end, v_active_count;
      RETURN;
    END IF;
  END LOOP;

  RETURN QUERY SELECT true, NULL::text, NULL::timestamptz, v_active_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_trip_schedule_availability(timestamptz, timestamptz) TO authenticated;

-- ============================================================================
-- Nothing else changes: RLS policies, other trips columns, bookings,
-- cancellation, completion, and notifications are all untouched. The only
-- other write path for `trips` in the whole project is UPDATE (used by
-- cancel_trip/complete_trip/etc.), and this trigger only fires on INSERT.
-- ============================================================================
