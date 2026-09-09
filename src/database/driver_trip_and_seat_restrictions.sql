-- ============================================================================
-- PamojaRide — Remove max-2-active-trips cap, enforce real vehicle-capacity
-- seat limits (frontend + backend), and keep the codebase escrow-ready.
-- Run this once in the Supabase SQL Editor.
-- ============================================================================
--
-- CONTEXT (found via inspection of src/database/*.sql and the frontend):
--
--   1. database/driver_trip_scheduling_limits.sql added
--      enforce_trip_scheduling_limits() (BEFORE INSERT trigger on trips)
--      with TWO rules bundled into one function:
--        Rule 1: at most 2 non-terminal trips per driver at once.
--        Rule 2: a new trip's [departure, arrival + 1h30 buffer] window
--                must not overlap any of the driver's other non-terminal
--                trips' windows.
--      check_trip_schedule_availability() (a read-only RPC TripForm.jsx
--      calls live, before submit) mirrors the exact same two rules so the
--      driver sees the verdict before they even try to post.
--      This migration removes Rule 1 from BOTH and keeps Rule 2 in both
--      (unchanged) — the product still wants to block a driver from
--      posting two trips that physically overlap, just not cap the total
--      *count* of trips they can have queued up.
--
--   2. There was NO real seat cap enforced anywhere in the database. The
--      only thing limiting "seats to offer" was TripForm.jsx's dropdown,
--      which capped itself at driver_profiles.max_seats_per_trip (a
--      "trust level" number, default 2, unrelated to the driver's actual
--      vehicle) — trivially bypassable by anyone calling the API/RPC
--      directly, since trips only had `total_seats > 0`. This migration
--      adds a real BEFORE INSERT check: total_seats can never exceed the
--      driver's own driver_profiles.vehicle_seats. max_seats_per_trip is
--      left in the schema untouched (other triggers already reference it
--      as a privileged/admin-only column, and driver/Profile.jsx still
--      shows it as a trust stat) — it's simply no longer used to gate
--      trip creation.
--
-- ESCROW COMPATIBILITY: neither the old nor the new trip-count is used
-- anywhere as a proxy for payment/escrow state, and nothing here ties
-- trip count to money changing hands — trips and bookings already track
-- their own status/refund_status independently. Removing the count cap
-- does not require any escrow-related follow-up; a future escrow layer
-- can key off booking/payment status exactly as it does today, with no
-- "how many trips can this driver have open" logic to unwind.
-- ============================================================================


-- ============================================================================
-- 1. enforce_trip_scheduling_limits() — drop the max-2 count rule, keep the
--    overlap/buffer rule. Same function name and trigger, so nothing else
--    needs to change to pick this up.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_trip_scheduling_limits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
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

  -- No cap on the number of non-terminal trips a driver may have at
  -- once — a driver can queue up as many trips as they want, as long as
  -- none of them overlap each other (checked below). This is the one
  -- rule removed by this migration; see file header for why.

  -- Still enforced: no overlap (including the 1h30 post-arrival safety
  -- buffer) with any of the driver's other non-terminal trips. This is
  -- what actually prevents a driver double-booking themselves into two
  -- places at once, which the count cap never really protected against
  -- anyway (two trips scheduled back-to-back could already overlap even
  -- while "only 2" were open).
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

-- Trigger itself is unchanged (still points at the same function name),
-- re-asserted idempotently per this project's existing convention.
DROP TRIGGER IF EXISTS trg_enforce_trip_scheduling_limits ON public.trips;
CREATE TRIGGER trg_enforce_trip_scheduling_limits
BEFORE INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.enforce_trip_scheduling_limits();


-- ============================================================================
-- 2. check_trip_schedule_availability() — same removal, kept in sync with
--    the trigger above (as documented in the original file). Still
--    returns active_trip_count for anyone still reading it (now purely
--    informational, no longer something that can flip `allowed` to
--    false).
-- ============================================================================

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

  -- No count-based rejection anymore -- v_active_count is only returned
  -- for information (e.g. a "you have N trips open" note in the UI if
  -- ever wanted), never used to set allowed = false.

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
-- 3. Real seat-capacity enforcement: total_seats can never exceed the
--    driver's own registered vehicle capacity. This did not exist at the
--    database level before this migration at all — only a frontend
--    dropdown limited itself to max_seats_per_trip, which (a) wasn't
--    vehicle-capacity-based and (b) was trivially bypassable by anyone
--    calling supabase.from('trips').insert(...) or the REST API directly
--    with a larger total_seats. total_seats is already a privileged,
--    driver-uneditable-after-creation column (see
--    bookings_trips_hardening.sql), so this only needs to run at INSERT.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_trip_seat_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_vehicle_seats integer;
BEGIN
  SELECT vehicle_seats INTO v_vehicle_seats
  FROM public.driver_profiles
  WHERE profile_id = NEW.driver_id;

  IF v_vehicle_seats IS NULL THEN
    RAISE EXCEPTION 'Your vehicle seat capacity is not set yet. Update your vehicle details before posting a trip.';
  END IF;

  IF NEW.total_seats > v_vehicle_seats THEN
    RAISE EXCEPTION 'You cannot offer more seats than your vehicle''s capacity (% seats).', v_vehicle_seats;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_trip_seat_capacity ON public.trips;
CREATE TRIGGER trg_enforce_trip_seat_capacity
BEFORE INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.enforce_trip_seat_capacity();


-- ============================================================================
-- Done. Summary:
--   Replaced: enforce_trip_scheduling_limits()          (dropped max-2 count rule)
--             check_trip_schedule_availability()        (dropped max-2 count rule)
--   New:      enforce_trip_seat_capacity() + trigger     (real vehicle-capacity check)
--   Untouched: max_seats_per_trip column (still a valid privileged/trust
--              column elsewhere, just no longer read by trip creation),
--              all RLS policies, bookings, cancellation, completion,
--              notifications.
-- ============================================================================
