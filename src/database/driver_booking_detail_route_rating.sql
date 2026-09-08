-- ============================================================================
-- PamojaRide — Task 8: Add route distance and driver rating to driver
-- booking detail.
-- Run this once in the Supabase SQL Editor. Purely additive in effect: it
-- touches exactly one function (see the DROP+CREATE note below for why a
-- drop is unavoidable here) and no table, RLS policy, trigger, or other
-- RPC is touched, dropped, or replaced. No data is touched.
-- ============================================================================
--
-- WHAT THIS CHANGES:
--
--   get_driver_booking_detail(p_booking_id) — defined in
--   booking_history_receipts.sql — is re-created with three additional
--   output columns appended to the END of the existing RETURNS TABLE
--   list:
--
--     - route_distance_km   → public.trips.route_distance_km (existing
--       column, added in trip_location_route_validation.sql). Returned
--       as-is, including NULL for trips whose distance isn't set.
--     - driver_avg_rating   → the CALLING driver's own rating, aggregated
--       live from public.ratings where rating_type = 'passenger_to_driver'
--       and removed_at IS NULL, keyed on t.driver_id (the trip owner —
--       which this function has already verified is the caller).
--     - driver_rating_count → count of the same rating rows.
--
--   This is the same driver, and the same rating fields, already added to
--   get_passenger_booking_detail() in
--   passenger_booking_detail_route_rating.sql, and it follows the exact
--   same LATERAL-join pattern used there and in
--   trip_search_driver_preview.sql's get_trip_driver_previews(): a driver
--   with zero qualifying ratings gets driver_avg_rating = NULL and
--   driver_rating_count = 0, never a fake 0.0 average. Nothing here writes
--   to public.ratings.
--
-- WHAT IS DELIBERATELY UNCHANGED:
--
--   - Every column already returned by get_driver_booking_detail is kept,
--     in the same order, with the same type and same source expression —
--     only new columns are appended.
--   - No passenger rating field is added. The existing function has never
--     exposed one (it returns only passenger_id/name/phone), and nothing
--     in this task adds new passenger data — only driver-side fields.
--   - The ownership/authorization check is byte-for-byte identical:
--       WHERE b.id = p_booking_id
--         AND (t.driver_id = auth.uid() OR public.is_admin(auth.uid()));
--     A booking that doesn't belong to the calling driver's trip (or
--     doesn't exist) still returns zero rows — never partial data, never
--     a distinguishing error.
--   - LANGUAGE sql / STABLE / SECURITY DEFINER / SET search_path stay the
--     same; the GRANT is re-issued so callers regain access immediately.
--   - get_passenger_booking_detail, RLS policies, and every other
--     table/RPC in the project are untouched.
--
-- NOTE ON DROP + CREATE (not a plain CREATE OR REPLACE):
--
--   Postgres implements RETURNS TABLE(...) as OUT parameters, and it
--   refuses CREATE OR REPLACE FUNCTION whenever the OUT-parameter row
--   shape changes — which adding three output columns necessarily does
--   (error 42P13: "cannot change return type of existing function").
--   The only way Postgres allows adding columns to an existing
--   RETURNS TABLE function is DROP FUNCTION followed by CREATE FUNCTION.
--   This is a two-statement mechanical swap, not a redesign: the
--   function's name, argument signature, security model, and every
--   existing column/expression are identical to before, and the GRANT is
--   re-issued immediately after creation so there is no gap in access.
--   Nothing else in the project references this function at the SQL
--   level (only frontend .rpc('get_driver_booking_detail') calls, which
--   are unaffected by a drop/recreate as long as the name and grant are
--   restored).
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_driver_booking_detail(uuid);

CREATE FUNCTION public.get_driver_booking_detail(p_booking_id uuid)
RETURNS TABLE (
  booking_id uuid,
  booking_reference text,
  booking_status text,
  refund_status text,
  seats_booked integer,
  price_per_seat_snapshot numeric,
  total_price numeric,
  booking_pickup_point text,
  booking_dropoff_point text,
  booking_created_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  estimated_arrival_time timestamptz,
  trip_status text,
  trip_pickup_point text,
  trip_dropoff_point text,
  vehicle_make text,
  vehicle_model text,
  vehicle_plate text,
  vehicle_color text,
  passenger_id uuid,
  passenger_name text,
  passenger_phone text,
  route_distance_km numeric,
  driver_avg_rating numeric,
  driver_rating_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    b.id,
    b.booking_reference,
    b.status,
    b.refund_status,
    b.seats_booked,
    b.price_per_seat_snapshot,
    b.total_price,
    b.pickup_point,
    b.dropoff_point,
    b.created_at,
    b.cancelled_at,
    b.cancellation_reason,
    t.id,
    t.origin,
    t.destination,
    t.departure_time,
    t.estimated_arrival_time,
    t.status,
    t.pickup_point,
    t.dropoff_point,
    t.vehicle_make,
    t.vehicle_model,
    t.vehicle_plate,
    t.vehicle_color,
    p.id,
    p.full_name,
    p.phone,
    t.route_distance_km,
    r.avg_rating,
    coalesce(r.rating_count, 0)
  FROM public.bookings b
  JOIN public.trips t    ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  LEFT JOIN LATERAL (
    SELECT
      round(avg(rt.rating)::numeric, 2) AS avg_rating,
      count(*)::integer AS rating_count
    FROM public.ratings rt
    WHERE rt.ratee_id = t.driver_id
      AND rt.rating_type = 'passenger_to_driver'
      AND rt.removed_at IS NULL
  ) r ON true
  WHERE b.id = p_booking_id
    AND (t.driver_id = auth.uid() OR public.is_admin(auth.uid()));
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_booking_detail(uuid) TO authenticated;
