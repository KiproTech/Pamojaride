-- ============================================================================
-- PamojaRide — Admin Trip Oversight: detail RPCs (fixes 403s from direct
-- embedded REST queries against `bookings` / `trip_completion_confirmations`
-- / `reports` / `ratings`)
--
-- CORRECTION to admin_trip_oversight_search.sql's header comment: that file
-- claimed admin already had full direct-REST read access to every table
-- this feature touches, and that the Trip Details / Passenger Profile /
-- Booking Details views could be built with plain embedded PostgREST
-- queries. Live testing proved that wrong — `bookings`,
-- `trip_completion_confirmations`, `reports`, and `ratings` returned 403
-- (permission denied) on direct client-side selects for the admin role,
-- even though `profiles`/`driver_profiles`/`passenger_profiles`/`trips`
-- worked. In hindsight this matches the pattern already used everywhere
-- else in this codebase: every existing view that joins bookings/
-- confirmations/reports/ratings across users goes through a
-- SECURITY DEFINER RPC (get_trip_passenger_manifest, get_admin_reports,
-- get_passenger_booking_detail, get_driver_booking_detail,
-- respond_trip_completion, get_trip_passenger_completions) — never a raw
-- client embed. This migration brings the three new admin views in line
-- with that same, already-proven pattern.
--
-- Run this AFTER admin_trip_oversight_search.sql. Purely additive:
-- 6 new, admin-only, read-only functions. No table/column/policy touched.
-- Idempotent — safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Full trip record for the Trip Details drawer (trip + driver identity +
--    driver verification + driver rating aggregate + who completed it).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_trip_details(p_trip_id uuid)
RETURNS TABLE (
  trip_id uuid, origin text, destination text, pickup_point text, dropoff_point text,
  departure_time timestamptz, estimated_arrival_time timestamptz, created_at timestamptz, status text,
  price_per_seat numeric, total_seats integer, available_seats integer,
  vehicle_make text, vehicle_model text, vehicle_plate text, vehicle_color text,
  cancellation_reason text, cancelled_at timestamptz,
  completion_source text, completed_by uuid, completed_by_name text,
  completed_at timestamptz, completion_requested_at timestamptz, completion_deadline timestamptz,
  driver_id uuid, driver_name text, driver_email text, driver_phone text,
  driver_profile_picture text, driver_created_at timestamptz,
  driver_verification_status text, driver_rating_avg numeric, driver_rating_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view trip details';
  END IF;

  RETURN QUERY
  SELECT
    t.id, t.origin, t.destination, t.pickup_point, t.dropoff_point,
    t.departure_time, t.estimated_arrival_time, t.created_at, t.status,
    t.price_per_seat, t.total_seats, t.available_seats,
    t.vehicle_make, t.vehicle_model, t.vehicle_plate, t.vehicle_color,
    t.cancellation_reason, t.cancelled_at,
    t.completion_source, t.completed_by, cb.full_name,
    t.completed_at, t.completion_requested_at, t.completion_deadline,
    d.id, d.full_name, d.email, d.phone, d.profile_picture, d.created_at,
    dp.verification_status,
    (SELECT round(avg(r.rating), 2) FROM public.ratings r WHERE r.ratee_id = t.driver_id AND r.rating_type = 'passenger_to_driver'),
    (SELECT count(*)::integer FROM public.ratings r WHERE r.ratee_id = t.driver_id AND r.rating_type = 'passenger_to_driver')
  FROM public.trips t
  LEFT JOIN public.profiles d ON d.id = t.driver_id
  LEFT JOIN public.driver_profiles dp ON dp.profile_id = t.driver_id
  LEFT JOIN public.profiles cb ON cb.id = t.completed_by
  WHERE t.id = p_trip_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_trip_details(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Complete passenger roster for a trip — EVERY booking regardless of
--    status, with passenger identity, per-passenger completion state, and a
--    per-booking report count. Deliberately broader than
--    get_trip_passenger_manifest() (which only returns confirmed bookings
--    without phone/email, for its own original narrower purpose) — that
--    function is untouched.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_trip_passenger_roster(p_trip_id uuid)
RETURNS TABLE (
  booking_id uuid, booking_reference text, booking_status text, refund_status text,
  seats_booked integer, price_per_seat_snapshot numeric, total_price numeric,
  pickup_point text, dropoff_point text, booking_created_at timestamptz,
  cancelled_at timestamptz, cancellation_reason text, cancelled_by uuid, cancelled_by_name text,
  passenger_id uuid, passenger_name text, passenger_email text, passenger_phone text, passenger_picture text,
  confirmation_id uuid, completion_response text, decline_reason text, decline_comment text,
  requested_at timestamptz, responded_at timestamptz,
  reports_count integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this trip''s passengers';
  END IF;

  RETURN QUERY
  SELECT
    b.id, b.booking_reference, b.status, b.refund_status,
    b.seats_booked, b.price_per_seat_snapshot, b.total_price,
    b.pickup_point, b.dropoff_point, b.created_at,
    b.cancelled_at, b.cancellation_reason, b.cancelled_by, cb.full_name,
    p.id, p.full_name, p.email, p.phone, p.profile_picture,
    c.id, c.response, c.decline_reason, c.decline_comment, c.requested_at, c.responded_at,
    (SELECT count(*)::integer FROM public.reports r WHERE r.booking_id = b.id)
  FROM public.bookings b
  JOIN public.profiles p ON p.id = b.passenger_id
  LEFT JOIN public.profiles cb ON cb.id = b.cancelled_by
  LEFT JOIN public.trip_completion_confirmations c ON c.booking_id = b.id
  WHERE b.trip_id = p_trip_id
  ORDER BY b.created_at ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_trip_passenger_roster(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Passenger's own profile (basic info) for the Passenger Profile view.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_passenger_profile(p_passenger_id uuid)
RETURNS TABLE (
  passenger_id uuid, full_name text, email text, phone text, profile_picture text,
  phone_verified boolean, created_at timestamptz,
  emergency_contact_name text, emergency_contact_phone text,
  account_status text, flagged_for_review boolean, trust_level integer,
  dispute_count integer, suspension_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this passenger''s profile';
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.full_name, p.email, p.phone, p.profile_picture,
    p.phone_verified, p.created_at,
    p.emergency_contact_name, p.emergency_contact_phone,
    pp.account_status, pp.flagged_for_review, pp.trust_level,
    pp.dispute_count, pp.suspension_reason
  FROM public.profiles p
  LEFT JOIN public.passenger_profiles pp ON pp.profile_id = p.id
  WHERE p.id = p_passenger_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_passenger_profile(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Every booking a passenger has ever made, with trip/driver context and
--    their individual completion response — powers both the booking-
--    statistics tiles (aggregated client-side from these rows) and the
--    "Trip Activity" list. No new passenger-history table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_passenger_bookings(p_passenger_id uuid)
RETURNS TABLE (
  booking_id uuid, booking_reference text, booking_status text,
  seats_booked integer, booking_created_at timestamptz,
  trip_id uuid, origin text, destination text, departure_time timestamptz, trip_status text,
  driver_name text,
  completion_response text, decline_reason text, responded_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this passenger''s bookings';
  END IF;

  RETURN QUERY
  SELECT
    b.id, b.booking_reference, b.status,
    b.seats_booked, b.created_at,
    t.id, t.origin, t.destination, t.departure_time, t.status,
    d.full_name,
    c.response, c.decline_reason, c.responded_at
  FROM public.bookings b
  JOIN public.trips t ON t.id = b.trip_id
  LEFT JOIN public.profiles d ON d.id = t.driver_id
  LEFT JOIN public.trip_completion_confirmations c ON c.booking_id = b.id
  WHERE b.passenger_id = p_passenger_id
  ORDER BY b.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_passenger_bookings(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. Ratings given by and received by a passenger (uses the existing
--    `ratings` table/relationships only — no duplicate rating store).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_passenger_ratings(p_passenger_id uuid)
RETURNS TABLE (
  rating_id uuid, direction text, rating integer, comment text, created_at timestamptz,
  trip_id uuid, counterparty_id uuid, counterparty_name text, counterparty_picture text,
  flagged_for_review boolean, removed_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this passenger''s ratings';
  END IF;

  RETURN QUERY
  SELECT r.id, 'given'::text, r.rating, r.comment, r.created_at,
         r.trip_id, r.ratee_id, ratee.full_name, ratee.profile_picture,
         r.flagged_for_review, r.removed_at
  FROM public.ratings r
  JOIN public.profiles ratee ON ratee.id = r.ratee_id
  WHERE r.rater_id = p_passenger_id
  UNION ALL
  SELECT r.id, 'received'::text, r.rating, r.comment, r.created_at,
         r.trip_id, r.rater_id, rater.full_name, rater.profile_picture,
         r.flagged_for_review, r.removed_at
  FROM public.ratings r
  JOIN public.profiles rater ON rater.id = r.rater_id
  WHERE r.ratee_id = p_passenger_id
  ORDER BY created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_passenger_ratings(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Reports submitted by, and reports concerning, a passenger (uses the
--    existing `reports` table only — no duplicate report store).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_passenger_reports(p_passenger_id uuid)
RETURNS TABLE (
  report_id uuid, direction text, category text, status text, description text,
  created_at timestamptz, resolved_at timestamptz, resolution_notes text,
  trip_id uuid, booking_id uuid, counterparty_id uuid, counterparty_name text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this passenger''s reports';
  END IF;

  RETURN QUERY
  SELECT r.id, 'submitted'::text, r.category, r.status, r.description,
         r.created_at, r.resolved_at, r.resolution_notes,
         r.trip_id, r.booking_id, r.reported_user_id, reported.full_name
  FROM public.reports r
  LEFT JOIN public.profiles reported ON reported.id = r.reported_user_id
  WHERE r.reporter_id = p_passenger_id
  UNION ALL
  SELECT r.id, 'about'::text, r.category, r.status, r.description,
         r.created_at, r.resolved_at, r.resolution_notes,
         r.trip_id, r.booking_id, r.reporter_id, reporter.full_name
  FROM public.reports r
  LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
  WHERE r.reported_user_id = p_passenger_id
  ORDER BY created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_passenger_reports(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. One booking's complete record — driver AND passenger identity
--    together, which neither get_passenger_booking_detail() nor
--    get_driver_booking_detail() returns (each is scoped to its own
--    caller's identity only). Plus related reports.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_booking_detail(p_booking_id uuid)
RETURNS TABLE (
  booking_id uuid, booking_reference text, booking_status text, refund_status text,
  seats_booked integer, price_per_seat_snapshot numeric, total_price numeric,
  pickup_point text, dropoff_point text, booking_created_at timestamptz,
  cancelled_at timestamptz, cancellation_reason text, cancelled_by_name text,
  passenger_id uuid, passenger_name text, passenger_email text, passenger_phone text, passenger_picture text,
  trip_id uuid, origin text, destination text, departure_time timestamptz, trip_status text,
  price_per_seat numeric, vehicle_make text, vehicle_model text, vehicle_plate text, vehicle_color text,
  driver_id uuid, driver_name text, driver_email text, driver_phone text, driver_picture text,
  completion_response text, decline_reason text, decline_comment text,
  requested_at timestamptz, responded_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this booking';
  END IF;

  RETURN QUERY
  SELECT
    b.id, b.booking_reference, b.status, b.refund_status,
    b.seats_booked, b.price_per_seat_snapshot, b.total_price,
    b.pickup_point, b.dropoff_point, b.created_at,
    b.cancelled_at, b.cancellation_reason, cb.full_name,
    p.id, p.full_name, p.email, p.phone, p.profile_picture,
    t.id, t.origin, t.destination, t.departure_time, t.status,
    t.price_per_seat, t.vehicle_make, t.vehicle_model, t.vehicle_plate, t.vehicle_color,
    d.id, d.full_name, d.email, d.phone, d.profile_picture,
    c.response, c.decline_reason, c.decline_comment, c.requested_at, c.responded_at
  FROM public.bookings b
  JOIN public.profiles p ON p.id = b.passenger_id
  JOIN public.trips t ON t.id = b.trip_id
  LEFT JOIN public.profiles d ON d.id = t.driver_id
  LEFT JOIN public.profiles cb ON cb.id = b.cancelled_by
  LEFT JOIN public.trip_completion_confirmations c ON c.booking_id = b.id
  WHERE b.id = p_booking_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_booking_detail(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. Reports tied to one booking (for the Booking Details view).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_booking_reports(p_booking_id uuid)
RETURNS TABLE (
  report_id uuid, category text, status text, description text,
  created_at timestamptz, resolution_notes text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view reports for this booking';
  END IF;

  RETURN QUERY
  SELECT r.id, r.category, r.status, r.description, r.created_at, r.resolution_notes
  FROM public.reports r
  WHERE r.booking_id = p_booking_id
  ORDER BY r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_booking_reports(uuid) TO authenticated;
