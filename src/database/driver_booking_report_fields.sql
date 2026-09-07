-- Run this in the Supabase SQL Editor, AFTER driver_booking_passenger_visibility.sql
-- (which created get_driver_trip_bookings() in the first place).
-- ============================================================================
-- Driver Booking Report — adds pickup_point / dropoff_point to the existing
-- get_driver_trip_bookings() RPC.
--
-- The report needs the trip's specific pickup/drop-off points (trips.pickup_
-- point / trips.dropoff_point), not just the origin/destination city pair
-- the Bookings page already showed. Postgres won't let CREATE OR REPLACE
-- change a function's RETURNS TABLE column list, so this drops and recreates
-- it -- same security model as before (SECURITY DEFINER, re-checks
-- trips.driver_id = auth.uid() itself, still only returns the passenger's
-- name/phone and never other profile columns, still no price/payment
-- fields going into the report).
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
  trip_status text
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
    t.status
  FROM public.bookings b
  JOIN public.trips t   ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE t.driver_id = auth.uid()
    AND (p_trip_id IS NULL OR b.trip_id = p_trip_id)
  ORDER BY t.departure_time DESC, b.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_trip_bookings(uuid) TO authenticated;
