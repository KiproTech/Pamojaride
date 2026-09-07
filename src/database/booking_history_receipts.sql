-- ============================================================================
-- PamojaRide — Trip/Booking History & Receipts
-- Run this whole script once in the Supabase SQL Editor.
-- Purely additive: it only creates TWO new read-only functions. No existing
-- table, column, RLS policy, trigger, or function is touched, dropped, or
-- replaced. No data is touched. No duplicate booking/payment/transaction
-- tables or statuses are introduced — everything below reads straight from
-- the existing `public.bookings` / `public.trips` / `public.profiles` /
-- `public.driver_profiles` tables, which remain the single source of truth.
-- ============================================================================
--
-- WHY TWO NEW FUNCTIONS INSTEAD OF A RAW SELECT FROM THE FRONTEND:
--
--   The passenger's "My Bookings" list (passenger/MyBookings.jsx) already
--   loads bookings directly via
--     .from('bookings').select('*, trips(...)').eq('passenger_id', user.id)
--   and that keeps working completely unchanged. But a single booking's
--   DETAIL page (opened by clicking a row, or by direct URL like
--   /passenger/bookings/:bookingId) needs one more thing a raw embed can't
--   safely give: the driver's name/phone/vehicle for THAT trip. profiles'
--   RLS only lets a user read their own row (see
--   driver_booking_passenger_visibility.sql / passenger_driver_details.sql
--   for the exact same problem solved the same way already in this
--   project), so a client-side `.select('*, profiles:...')` embed would
--   just come back null for the driver.
--
--   Symmetrically, the driver's booking detail page needs the passenger's
--   name/phone for a specific booking — get_driver_trip_bookings() already
--   solves this for the LIST view; this adds the equivalent single-row,
--   ownership-checked lookup for the DETAIL view (and for the receipt,
--   which reuses the exact same data).
--
-- SECURITY / RLS — the ownership model these enforce:
--
--   get_passenger_booking_detail(p_booking_id):
--     - only ever returns a row when `bookings.passenger_id = auth.uid()`
--       (or the caller is an admin) — mirrors get_my_reports(p_report_id)'s
--       established idiom: requesting someone else's booking id, or an id
--       that doesn't exist, both return ZERO rows. There is no exception
--       and no partial data to distinguish "not yours" from "doesn't
--       exist" — nothing here can be used to enumerate valid booking ids.
--     - exposes the driver's name/phone/photo/vehicle/verification for
--       that trip — the SAME fields get_booked_trip_driver_details()
--       already exposes to this passenger once they hold a confirmed/
--       completed booking on the trip; this just bundles it into one
--       single-row call instead of two.
--
--   get_driver_booking_detail(p_booking_id):
--     - only ever returns a row when the CALLING driver owns the trip the
--       booking belongs to (`trips.driver_id = auth.uid()`), or is an
--       admin — same zero-rows-if-not-yours idiom.
--     - exposes ONLY the passenger's full_name + phone — the exact same
--       two columns (and nothing more — no email, no national_id, no
--       emergency contact) already exposed to this driver today via
--       get_driver_trip_bookings(). No new passenger PII is ever surfaced
--       just because a detail page exists.
--
--   Neither function is a new attack surface for direct URL manipulation:
--   changing /booking/123 to /booking/124 simply gets an authenticated
--   user zero rows back (rendered by the frontend as "Booking not
--   found"), never another user's data and never a distinguishing error.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. get_passenger_booking_detail — passenger-facing booking/trip/driver
--    detail, used by Trip Details + Receipt on the passenger side.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_passenger_booking_detail(p_booking_id uuid)
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
  driver_id uuid,
  driver_name text,
  driver_phone text,
  driver_profile_picture text,
  vehicle_make text,
  vehicle_model text,
  vehicle_plate text,
  vehicle_color text,
  driver_verification_status text
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
    p.id,
    p.full_name,
    p.phone,
    p.profile_picture,
    t.vehicle_make,
    t.vehicle_model,
    t.vehicle_plate,
    t.vehicle_color,
    dp.verification_status
  FROM public.bookings b
  JOIN public.trips t     ON t.id = b.trip_id
  JOIN public.profiles p  ON p.id = t.driver_id
  LEFT JOIN public.driver_profiles dp ON dp.profile_id = t.driver_id
  WHERE b.id = p_booking_id
    AND (b.passenger_id = auth.uid() OR public.is_admin(auth.uid()));
$function$;

GRANT EXECUTE ON FUNCTION public.get_passenger_booking_detail(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. get_driver_booking_detail — driver-facing booking/trip/passenger
--    detail, used by Trip Details + Receipt on the driver side.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_driver_booking_detail(p_booking_id uuid)
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
  passenger_phone text
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
    p.phone
  FROM public.bookings b
  JOIN public.trips t    ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE b.id = p_booking_id
    AND (t.driver_id = auth.uid() OR public.is_admin(auth.uid()));
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_booking_detail(uuid) TO authenticated;
