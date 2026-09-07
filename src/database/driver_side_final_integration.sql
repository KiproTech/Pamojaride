-- ============================================================================
-- PamojaRide — Driver-side final integration fixes (Prompts 1–9 review)
-- Run this once in the Supabase SQL Editor, AFTER notifications_fix.sql.
-- ============================================================================
--
-- This is a full audit-and-fix pass over the entire Driver workflow
-- (login → dashboard → verification → create trip → my trips → bookings →
-- passenger names → reports → cancellation → start → complete →
-- confirmation → 50% threshold → 20-minute timeout → notifications).
--
-- Everything else on that list was re-checked line by line against the
-- live function/RLS/trigger definitions and found to already be correct
-- and consistent end-to-end (see chat for the full audit). Exactly ONE
-- real gap was found, and it's the only change in this file:
--
--   ROOT CAUSE: "Driver cannot create another trip while an active trip
--   is ongoing" was never actually enforced anywhere. CreateTrip.jsx does
--   a plain client-side INSERT into `trips` with no such check, and no
--   database function or RLS policy blocked it either — a driver could
--   post an unlimited number of simultaneously "ongoing"/"completion_
--   pending" trips.
--
-- FIX: a BEFORE INSERT trigger on public.trips, independent of whatever
-- the existing trips_insert_verified_driver RLS policy already checks (so
-- this is purely additive and can't loosen or conflict with it). It uses
-- the exact same definition of "active" already used throughout the
-- frontend (driver/Dashboard.jsx and driver/ManageTrips.jsx's
-- isActiveTrip()): status IN ('ongoing', 'completion_pending'), OR still
-- 'scheduled' but past its departure time. A driver can still freely post
-- multiple *future* scheduled trips — this only blocks starting a new one
-- while one is currently in progress, which is the actual real-world rule
-- (a driver can't be driving two trips at once).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prevent_concurrent_active_trips()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.trips
    WHERE driver_id = NEW.driver_id
      AND (
        status IN ('ongoing', 'completion_pending')
        OR (status = 'scheduled' AND departure_time <= now())
      )
  ) THEN
    RAISE EXCEPTION 'You already have an active trip in progress. Finish or wait for it to complete before posting a new one.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_concurrent_active_trips ON public.trips;
CREATE TRIGGER trg_prevent_concurrent_active_trips
BEFORE INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.prevent_concurrent_active_trips();

-- No data is touched, no existing constraint/trigger/function is removed
-- or altered, and this only fires on INSERT — every other Driver-side RPC
-- (complete_trip, confirm_trip_completion, cancel_trip, book_seats,
-- mark_no_show, auto_complete_pending_trips, auto_start_departed_trips)
-- only ever UPDATEs trips, so none of them are affected by this trigger.
