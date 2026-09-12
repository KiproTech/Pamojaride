-- ============================================================================
-- PamojaRide — Admin Trip Oversight: unified search/filter/pagination RPC
--
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- admin_trip_completion_override.sql and admin_passenger_manifest.sql.
-- Purely additive — ONE new, admin-only, read-only RPC. No table is
-- created or altered, no existing function is touched, no RLS policy is
-- changed. Idempotent — safe to re-run.
-- ============================================================================
--
-- NOTE — CORRECTED: an earlier version of this comment claimed admin had
-- full direct-REST SELECT access to `bookings`, `trip_completion_confirmations`,
-- `reports`, and `ratings`, and that the rest of this feature (Trip Details,
-- Passenger Profile, Booking Details) could be built with plain embedded
-- client queries against those tables. Live testing showed that's wrong —
-- those four tables returned 403 on direct embedded selects for the admin
-- role (only `profiles`/`driver_profiles`/`passenger_profiles`/`trips` are
-- directly readable by admin). See admin_trip_oversight_detail_rpcs.sql,
-- which adds the SECURITY DEFINER RPCs those views actually use — the same
-- pattern already proven elsewhere in this codebase (get_admin_reports(),
-- get_trip_passenger_manifest(), get_passenger_booking_detail()). This file
-- still only needs the one function below, for the reason described here:
--
--   The main Trip Oversight LIST needs to search across trip route/id,
--   driver name, AND passenger name/phone/booking reference simultaneously,
--   filter by status *and* by derived completion/report state, and paginate
--   — all in a single round trip. That's exactly the kind of read this
--   project already builds a dedicated RPC for.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_admin_trip_oversight(
  p_status text DEFAULT NULL,   -- NULL/'all', a real trips.status value, or a derived
                                 -- filter: 'pending_completion' | 'declined_completion' |
                                 -- 'has_reports' | 'needs_attention'
  p_search text DEFAULT NULL,   -- matches trip id, route, vehicle plate, driver name,
                                 -- OR any passenger's name/phone/booking reference/booking id
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  created_at timestamptz,
  status text,
  price_per_seat numeric,
  total_seats integer,
  available_seats integer,
  vehicle_make text,
  vehicle_model text,
  vehicle_plate text,
  vehicle_color text,
  driver_id uuid,
  driver_name text,
  driver_phone text,
  driver_profile_picture text,
  driver_verification_status text,
  cancellation_reason text,
  cancelled_at timestamptz,
  completion_source text,
  completed_by uuid,
  completed_by_name text,
  completed_at timestamptz,
  completion_deadline timestamptz,
  seats_booked integer,
  passenger_count integer,
  accepted_count integer,
  declined_count integer,
  pending_count integer,
  reports_count integer,
  needs_attention boolean,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 20), 1), 100);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view trip oversight data';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      t.*,
      d.full_name  AS drv_name,
      d.phone      AS drv_phone,
      d.profile_picture AS drv_picture,
      dp.verification_status AS drv_verification_status,
      cb.full_name AS completed_by_name,
      (SELECT coalesce(sum(b.seats_booked), 0)::integer
         FROM public.bookings b
         WHERE b.trip_id = t.id AND b.status IN ('confirmed', 'completed')) AS seats_booked,
      (SELECT count(*)::integer
         FROM public.bookings b
         WHERE b.trip_id = t.id AND b.status IN ('confirmed', 'completed')) AS passenger_count,
      (SELECT count(*)::integer FROM public.trip_completion_confirmations c
         WHERE c.trip_id = t.id AND c.response = 'accepted') AS accepted_count,
      (SELECT count(*)::integer FROM public.trip_completion_confirmations c
         WHERE c.trip_id = t.id AND c.response = 'declined') AS declined_count,
      (SELECT count(*)::integer FROM public.trip_completion_confirmations c
         WHERE c.trip_id = t.id AND c.response = 'pending') AS pending_count,
      (SELECT count(*)::integer FROM public.reports r WHERE r.trip_id = t.id) AS reports_count
    FROM public.trips t
    LEFT JOIN public.profiles d        ON d.id = t.driver_id
    LEFT JOIN public.driver_profiles dp ON dp.profile_id = t.driver_id
    LEFT JOIN public.profiles cb       ON cb.id = t.completed_by
    WHERE
      v_search IS NULL
      OR t.origin ILIKE '%' || v_search || '%'
      OR t.destination ILIKE '%' || v_search || '%'
      OR t.vehicle_plate ILIKE '%' || v_search || '%'
      OR t.id::text ILIKE '%' || v_search || '%'
      OR d.full_name ILIKE '%' || v_search || '%'
      OR EXISTS (
           SELECT 1 FROM public.bookings b2
           JOIN public.profiles pp ON pp.id = b2.passenger_id
           WHERE b2.trip_id = t.id
             AND (
               pp.full_name ILIKE '%' || v_search || '%'
               OR pp.phone ILIKE '%' || v_search || '%'
               OR b2.booking_reference ILIKE '%' || v_search || '%'
               OR b2.id::text ILIKE '%' || v_search || '%'
             )
         )
  ),
  filtered AS (
    SELECT * FROM base f
    WHERE
      p_status IS NULL
      OR p_status = 'all'
      OR (
           p_status NOT IN ('pending_completion', 'declined_completion', 'has_reports', 'needs_attention')
           AND f.status = p_status
         )
      OR (p_status = 'pending_completion' AND f.status = 'completion_pending' AND f.pending_count > 0)
      OR (p_status = 'declined_completion' AND f.declined_count > 0)
      OR (p_status = 'has_reports' AND f.reports_count > 0)
      OR (
           p_status = 'needs_attention'
           AND (
             f.declined_count > 0
             OR f.reports_count > 0
             OR (f.status = 'completion_pending' AND f.completion_deadline IS NOT NULL AND f.completion_deadline <= now())
           )
         )
  )
  SELECT
    f.id, f.origin, f.destination, f.departure_time, f.created_at, f.status,
    f.price_per_seat, f.total_seats, f.available_seats,
    f.vehicle_make, f.vehicle_model, f.vehicle_plate, f.vehicle_color,
    f.driver_id, f.drv_name, f.drv_phone, f.drv_picture, f.drv_verification_status,
    f.cancellation_reason, f.cancelled_at,
    f.completion_source, f.completed_by, f.completed_by_name, f.completed_at, f.completion_deadline,
    f.seats_booked, f.passenger_count, f.accepted_count, f.declined_count, f.pending_count, f.reports_count,
    (
      f.declined_count > 0
      OR f.reports_count > 0
      OR (f.status = 'completion_pending' AND f.completion_deadline IS NOT NULL AND f.completion_deadline <= now())
    ) AS needs_attention,
    count(*) OVER()::bigint AS total_count
  FROM filtered f
  ORDER BY f.departure_time DESC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_trip_oversight(text, text, integer, integer) TO authenticated;

-- ============================================================================
-- End of migration. Every other view in the improved Trip Oversight feature
-- (Trip Details, Driver section, full Passenger Roster with completion
-- status, complete Passenger Profile with booking stats/trip activity/
-- ratings/reports, Booking Details, and the trip timeline) is powered by
-- direct, RLS-scoped PostgREST queries against the existing tables and
-- relationships above — no further SQL changes were needed or made.
-- ============================================================================
