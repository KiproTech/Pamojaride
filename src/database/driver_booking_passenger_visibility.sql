-- Run this in the Supabase SQL Editor.
-- ============================================================================
-- ROOT CAUSE — "Unknown Passenger" on the Driver Bookings page
-- ============================================================================
-- driver/Bookings.jsx (and driver/Dashboard.jsx) fetch bookings with a
-- PostgREST embed:
--   .select('*, profiles:passenger_id(full_name, phone), trips!inner(...)')
--
-- The foreign key (bookings.passenger_id -> profiles.id) is fine, and the
-- driver's own RLS access to `bookings`/`trips` is fine (that's why the
-- booking row, seats, price, etc. already show up correctly). The piece
-- that silently fails is the embedded `profiles` row: public.profiles has
-- no policy letting one user read another user's row (only self, via the
-- default "id = auth.uid()" policy already in place live). PostgREST does
-- NOT error when a to-one embed is blocked by RLS -- it just returns that
-- embedded object as null. So every booking's `profiles` comes back null,
-- and the UI's fallback text ("Unknown" name / "Passenger" label) is what
-- actually renders -- this is the "Unknown Passenger" bug, with no console
-- or Supabase error anywhere to point at.
--
-- This mirrors exactly the reasoning already written up in
-- critical_security_fixes.sql for driver_profiles: the fix is NOT to open
-- public.profiles up with a broad "drivers can read passenger profiles"
-- SELECT policy, because RLS is row-level, not column-level -- a policy
-- like that would let any driver run `.from('profiles').select('*')` for
-- any passenger they've ever had a booking with and pull back email,
-- national_id, emergency contacts, etc., none of which the Bookings page
-- needs. Instead, exactly like get_trip_contact() already does for the
-- reverse direction (passenger -> driver contact reveal), this adds one
-- SECURITY DEFINER function that:
--   - re-checks driver ownership itself (trips.driver_id = auth.uid()),
--     so it grants nothing that RLS wasn't already conceptually allowing
--     the driver to see about their own bookings,
--   - returns ONLY the columns the Bookings page actually renders
--     (passenger full_name + phone, never email/national_id/etc.),
--   - is the sole path to that data: base profiles RLS stays exactly as
--     restrictive as it is today, so a driver poking at
--     `.from('profiles').select('*').eq('id', somePassengerId)` directly
--     from devtools still gets nothing back.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_driver_trip_bookings(p_trip_id uuid DEFAULT NULL)
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
    t.departure_time,
    t.status
  FROM public.bookings b
  JOIN public.trips t   ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE t.driver_id = auth.uid()
    AND (p_trip_id IS NULL OR b.trip_id = p_trip_id)
  ORDER BY b.created_at DESC;
$function$;

-- Only signed-in users may call it at all; the WHERE t.driver_id =
-- auth.uid() inside the function is what actually restricts each caller
-- to their own bookings (a passenger or a different driver calling this
-- just gets an empty result set, never an error and never someone else's
-- rows).
GRANT EXECUTE ON FUNCTION public.get_driver_trip_bookings(uuid) TO authenticated;
