-- ============================================================================
-- PamojaRide — Passenger: View Driver Details for a Booked Trip
-- Run this whole script once in the Supabase SQL Editor. Purely additive:
-- it only creates ONE new function. No existing table, view, function,
-- policy, or trigger is touched, dropped, or replaced. No data is touched.
-- ============================================================================
--
-- WHY A NEW FUNCTION INSTEAD OF CHANGING SOMETHING EXISTING:
--
--   The public-safe driver preview a passenger sees before booking already
--   works today via the `driver_public_profile` view (name, trust level,
--   trips completed — see passenger/TripDetails.jsx) — it deliberately never
--   exposes phone or other PII, and is left completely untouched here.
--
--   The driver's phone is already gated correctly by the existing
--   `get_trip_contact()` RPC (used by passenger/MyBookings.jsx's old
--   "Contact driver" button) — also left completely untouched.
--
--   This task asks for a richer, persistent "driver details" card (name,
--   photo, phone, vehicle, plate, verification status) shown automatically
--   once a passenger has a confirmed booking, in one place, in one request.
--   Rather than change the return shape of an existing, already-working,
--   already-gated function (risky — anything else relying on its current
--   column set could break), this adds ONE new read-only RPC that returns
--   everything the card needs in a single call. The old "Contact driver"
--   button/RPC keep working exactly as before if anything else ever
--   depends on them; the frontend for MyBookings.jsx is simply updated to
--   call this new function instead of duplicating both.
--
-- WHERE EACH FIELD COMES FROM (per "Correct Data Relationships"):
--
--   - full_name, profile_picture, phone   → public.profiles (the driver's
--     own identity/contact row).
--   - vehicle_make, vehicle_model,
--     vehicle_plate, vehicle_color        → public.trips itself, NOT
--     driver_profiles. Trips already snapshot the vehicle used for that
--     specific trip at creation time (see driver/CreateTrip.jsx), which is
--     the correct source: it reflects the vehicle actually used for THIS
--     trip even if the driver's profile vehicle changes later, and this
--     data is already public/queryable on `trips` for anyone browsing
--     search results — no privacy gate needed for it here.
--   - verification_status, trust_level,
--     trips_completed                     → public.driver_profiles, the
--     driver's current standing (same fields already shown to a passenger
--     pre-booking via driver_public_profile, just bundled here too so the
--     card doesn't need a second request).
--
-- PRIVACY / AUTHORIZATION (enforced here, not just hidden in the UI):
--
--   A caller may see the phone number and the rest of this bundle ONLY if:
--     (a) they have a booking on this trip, as its passenger, with status
--         'confirmed' or 'completed' (a trip that already happened is still
--         a legitimate past booking — e.g. to report an issue or leave a
--         rating — but a 'cancelled' booking is not); OR
--     (b) they ARE the driver of this trip (their own contact info); OR
--     (c) they are an admin (support/moderation, same pattern used
--         throughout every other RPC in this project).
--   Anyone else gets an exception, not partial or empty data — so this
--   can never be used to enumerate whether a trip/driver exists.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_booked_trip_driver_details(p_trip_id uuid)
 RETURNS TABLE (
   driver_id uuid,
   full_name text,
   profile_picture text,
   phone text,
   vehicle_make text,
   vehicle_model text,
   vehicle_plate text,
   vehicle_color text,
   verification_status text,
   trust_level integer,
   trips_completed integer
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_trip public.trips%ROWTYPE;
  v_authorized boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  SELECT (
    v_trip.driver_id = v_caller
    OR public.is_admin(v_caller)
    OR EXISTS (
      SELECT 1 FROM public.bookings
      WHERE trip_id = p_trip_id
        AND passenger_id = v_caller
        AND status IN ('confirmed', 'completed')
    )
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized to view this driver''s details';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.full_name,
    p.profile_picture,
    p.phone,
    v_trip.vehicle_make,
    v_trip.vehicle_model,
    v_trip.vehicle_plate,
    v_trip.vehicle_color,
    dp.verification_status,
    dp.trust_level,
    dp.trips_completed
  FROM public.profiles p
  LEFT JOIN public.driver_profiles dp ON dp.profile_id = p.id
  WHERE p.id = v_trip.driver_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_booked_trip_driver_details(uuid) TO authenticated;
