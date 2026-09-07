-- ============================================================================
-- PamojaRide — Passenger: Driver Trust Preview on Trip Search / Trip Details
-- Run this whole script once in the Supabase SQL Editor. Purely additive:
-- it only creates ONE new function. No existing table, view, function,
-- policy, or trigger is touched, dropped, or replaced. No data is touched.
-- ============================================================================
--
-- ROOT CAUSE OF THE BUG BEING FIXED:
--
--   TripDetails.jsx currently does:
--     supabase.from('driver_public_profile').select('*').eq('id', ...)
--
--   `driver_public_profile` is not defined anywhere in this project's SQL
--   files, and critical_security_fixes.sql (FIX 2) locked driver_profiles
--   down to admin-only SELECT ("anyone can read minimal driver info" was
--   dropped because it leaked national_id, licence_number, KYC rejection
--   reasons, etc. to literally anyone). Whatever `driver_public_profile`
--   is/was, a non-admin passenger querying it today gets back no row —
--   which is exactly why the driver name collapses to a bare initial ("J")
--   and trust level silently falls back to the frontend's default of 1.
--   Trip search (SearchTrips.jsx / TripCard.jsx) shows no driver info at
--   all pre-booking today — there's nothing to break there.
--
--   The fix is NOT to reopen driver_profiles — FIX 2's reasoning (don't
--   leak KYC/licence data) still applies. Instead, this adds one
--   SECURITY DEFINER function, following the exact same pattern already
--   used for the post-booking case (get_booked_trip_driver_details in
--   passenger_driver_details.sql): it runs with elevated privileges but
--   only ever returns a hand-picked, non-sensitive column list.
--
-- WHAT'S DELIBERATELY EXCLUDED:
--
--   - email, national_id, licence_number, KYC documents/reasons,
--     emergency contacts, dispute_count, flagged_for_review, etc.: never
--     appropriate to show a passenger, at any stage.
--
--   Phone IS included below, per explicit product decision: passengers
--   should be able to see and call the driver before booking, not just
--   after. This intentionally departs from get_trip_contact()'s
--   after-booking-only gating (passenger_driver_details.sql) — that
--   function is untouched and still works exactly as before for anything
--   that still calls it (e.g. My Bookings' "Contact driver").
--
-- WHERE EACH FIELD COMES FROM:
--
--   - full_name, profile_picture, phone → public.profiles.
--   - trust_level, verification_status,
--     trips_completed                → public.driver_profiles (current
--     standing — the same fields the driver-facing dashboard shows).
--   - avg_rating, rating_count       → aggregated live from public.ratings
--     (rating_type = 'passenger_to_driver'), never hardcoded. A driver
--     with zero ratings gets avg_rating = NULL / rating_count = 0; the
--     frontend renders "New driver · No ratings yet" for that case
--     rather than a fake 0.0.
--   - vehicle_make/model/plate/color → public.trips itself (snapshotted
--     per trip at creation time — see driver/CreateTrip.jsx), which is
--     already public/queryable by anyone browsing search results.
--
-- AUTHORIZATION:
--
--   Callable by any authenticated user (this is pre-booking browsing
--   data, shown on the public search results page — there is nothing to
--   gate per-trip; the column list itself is the privacy boundary). Takes
--   an array of trip ids so the search page can fetch previews for an
--   entire results page in one round trip instead of one request per
--   card. Unknown/invalid trip ids are simply absent from the result set
--   — no error, no enumeration risk beyond "does this trip id exist",
--   which is already answerable via the public trip search itself.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_trip_driver_previews(p_trip_ids uuid[])
 RETURNS TABLE (
   trip_id uuid,
   driver_id uuid,
   full_name text,
   profile_picture text,
   phone text,
   trust_level integer,
   verification_status text,
   trips_completed integer,
   avg_rating numeric,
   rating_count integer,
   vehicle_make text,
   vehicle_model text,
   vehicle_plate text,
   vehicle_color text
 )
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    t.id AS trip_id,
    p.id AS driver_id,
    p.full_name,
    p.profile_picture,
    p.phone,
    dp.trust_level,
    dp.verification_status,
    dp.trips_completed,
    r.avg_rating,
    r.rating_count,
    t.vehicle_make,
    t.vehicle_model,
    t.vehicle_plate,
    t.vehicle_color
  FROM public.trips t
  JOIN public.profiles p ON p.id = t.driver_id
  LEFT JOIN public.driver_profiles dp ON dp.profile_id = t.driver_id
  LEFT JOIN LATERAL (
    SELECT
      round(avg(rt.rating)::numeric, 2) AS avg_rating,
      count(*)::integer AS rating_count
    FROM public.ratings rt
    WHERE rt.ratee_id = t.driver_id
      AND rt.rating_type = 'passenger_to_driver'
      AND rt.removed_at IS NULL
  ) r ON true
  WHERE t.id = ANY(p_trip_ids);
$function$;

GRANT EXECUTE ON FUNCTION public.get_trip_driver_previews(uuid[]) TO authenticated;
