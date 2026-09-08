-- ============================================================================
-- PamojaRide — Task 14: Driver Booking Report — route distance (DB fix).
-- Run this in the Supabase SQL Editor, AFTER driver_booking_report_fields.sql.
-- ============================================================================
--
-- CONTEXT — this closes a gap that was already identified and documented in
-- src/database/driver_report_distance_no_db_changes.sql:
--
--   src/lib/reports/driverBookingReport.js (the driver's downloadable
--   booking report) has been ready to render a per-trip "Distance" line
--   since Task 10 — it reads `route_distance_km` off each booking row and
--   simply omits the line when the field is null/undefined (see
--   fmtDistanceKm() in that file). But the RPC that actually feeds this
--   report, get_driver_trip_bookings() (see
--   driver_booking_report_fields.sql), never selected
--   trips.route_distance_km in the first place — so no row has ever
--   carried the field, and the report has never shown a Distance line,
--   even for trips where the distance genuinely was computed and is
--   available (see database/trip_location_route_validation.sql).
--
--   This was left as a known, documented gap rather than fixed at the time
--   because that task's instructions explicitly said not to touch the
--   database. This task's testing confirmed the gap is real (Task 14, item
--   9 — "Confirm route distance appears correctly when available" — FAIL
--   without this migration) and this task does not carry that restriction,
--   so it's fixed here.
--
-- WHAT THIS DOES — same DROP FUNCTION + CREATE FUNCTION pattern already
-- used by driver_booking_report_fields.sql (Postgres won't let
-- CREATE OR REPLACE change a function's RETURNS TABLE column list): adds
-- ONE new column, t.route_distance_km, to the end of
-- get_driver_trip_bookings()'s return type. Nothing else changes —
-- same SECURITY DEFINER model, same `t.driver_id = auth.uid()` ownership
-- check, same columns/rows otherwise, same grant. A driver still only ever
-- sees their own bookings; this does not add any passenger PII or any
-- new authorization path.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_driver_trip_bookings(uuid);

CREATE FUNCTION public.get_driver_trip_bookings(p_trip_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  booking_reference text,
  trip_id uuid,
  passenger_id uuid,
  passenger_name text,
  passenger_phone text,
  seats_booked integer,
  total_price numeric,
  status text,
  refund_status text,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_at timestamptz,
  origin text,
  destination text,
  pickup_point text,
  dropoff_point text,
  departure_time timestamptz,
  trip_status text,
  route_distance_km numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    b.id,
    b.booking_reference,
    b.trip_id,
    b.passenger_id,
    p.full_name,
    p.phone,
    b.seats_booked,
    b.total_price,
    b.status,
    b.refund_status,
    b.cancellation_reason,
    b.cancelled_at,
    b.created_at,
    t.origin,
    t.destination,
    t.pickup_point,
    t.dropoff_point,
    t.departure_time,
    t.status,
    t.route_distance_km
  FROM public.bookings b
  JOIN public.trips t   ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE t.driver_id = auth.uid()
    AND (p_trip_id IS NULL OR b.trip_id = p_trip_id)
  ORDER BY t.departure_time DESC, b.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_trip_bookings(uuid) TO authenticated;
