-- ============================================================================
-- PamojaRide — Admin Reports & Performance (Admin → Analytics)
-- Run this whole script once in the Supabase SQL Editor. Safe to run
-- multiple times: every function is CREATE OR REPLACE (or DROP + CREATE
-- where the return shape changes across a re-run), no table is created,
-- altered, or dropped, and no RLS policy is added, removed, or changed.
-- ============================================================================
--
-- SCOPE: this migration is purely read-only reporting. It powers a NEW
-- "Admin → Analytics" section (deliberately not named "Reports" in the UI —
-- /admin/reports already means the complaints/appeals queue from
-- admin_reports_management.sql; reusing that name here would be
-- confusing). Every function here:
--   - is SECURITY DEFINER only so it can aggregate across every driver's/
--     passenger's rows for a platform-wide summary (RLS on trips/bookings/
--     profiles otherwise scopes each user to their own rows) — the SAME
--     established pattern as get_admin_reports()/get_admin_report_counts()
--     (admin_reports_management.sql) and every other admin RPC in this
--     project;
--   - re-checks public.is_admin(auth.uid()) itself and RAISEs for any
--     non-admin caller, so granting EXECUTE to `authenticated` does not
--     hand a passenger/driver any data — the function body refuses them
--     before touching a row;
--   - only SELECTs. Nothing here INSERTs, UPDATEs, or DELETEs anything.
--   - aggregates in SQL (COUNT/AVG/FILTER) rather than returning raw rows
--     for the client to sum, per the brief's "avoid repeatedly downloading
--     entire tables into the browser" instruction. The two functions that
--     do return one row per entity (get_admin_driver_performance,
--     get_admin_trip_performance_report, get_admin_booking_report) are
--     that way because the report itself is a listing — the summary
--     numbers on the Overview/Drivers/Trips/Bookings tabs never pull full
--     tables.
--
-- NO FAKE DATA: every metric below is a real aggregate over
-- public.trips / public.bookings / public.driver_profiles /
-- public.passenger_profiles / public.profiles / public.ratings — the same
-- tables (db.sql) every other part of the app already reads. Nothing new
-- is tracked; there is no new "analytics_events" or "metrics" table.
-- Ratings-based averages follow the exact same "NULL with 0 ratings, never
-- a fake 0.0" convention already established in
-- driver_booking_detail_route_rating.sql / trip_search_driver_preview.sql.
--
-- DATE RANGE CONVENTION: every function that takes p_date_from/p_date_to
-- treats NULL as open-ended (NULL p_date_from = "since the beginning",
-- NULL p_date_to = "through now"), so the UI's "All time" option is just
-- "pass nothing" rather than a magic sentinel date.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. get_admin_platform_overview()
--    All-time platform totals for the Overview tab's summary cards. Not
--    date-filtered — these are point-in-time counts of what exists right
--    now (mirrors admin/Dashboard.jsx's existing stat cards, extended to
--    the full set the brief asks for), so the client only ever fetches
--    counts, never rows.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_platform_overview()
RETURNS TABLE (
  total_users bigint,
  total_passengers bigint,
  total_drivers bigint,
  verified_drivers bigint,
  pending_driver_verifications bigint,
  suspended_accounts bigint,
  banned_accounts bigint,
  total_trips bigint,
  active_trips bigint,
  completed_trips bigint,
  cancelled_trips bigint,
  total_bookings bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.profiles),
    (SELECT count(*) FROM public.passenger_profiles),
    (SELECT count(*) FROM public.driver_profiles),
    (SELECT count(*) FROM public.driver_profiles WHERE verification_status = 'verified'),
    (SELECT count(*) FROM public.driver_profiles WHERE verification_status IN ('pending_verification', 'under_review')),
    (SELECT count(*) FROM public.driver_profiles WHERE account_status = 'suspended')
      + (SELECT count(*) FROM public.passenger_profiles WHERE account_status = 'suspended'),
    (SELECT count(*) FROM public.driver_profiles WHERE account_status = 'banned')
      + (SELECT count(*) FROM public.passenger_profiles WHERE account_status = 'banned'),
    (SELECT count(*) FROM public.trips),
    (SELECT count(*) FROM public.trips WHERE status IN ('scheduled', 'ongoing')),
    (SELECT count(*) FROM public.trips WHERE status = 'completed'),
    (SELECT count(*) FROM public.trips WHERE status IN ('cancelled', 'expired')),
    (SELECT count(*) FROM public.bookings);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_platform_overview() TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. get_admin_trip_performance(p_date_from, p_date_to)
--    Trip Performance tab: real counts scoped to trips.created_at within
--    the period. "trips_active" is the current count of active trips among
--    those created in the period (a snapshot within a historical window is
--    the only honest reading of "active" for a past period). booking_rate
--    = % of the period's trips that received at least one booking;
--    avg_bookings_per_trip is the plain mean (only meaningful, per the
--    brief, when trips_created > 0 — the client should treat a NULL here
--    as "not enough data", not render "0").
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_trip_performance(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  trips_created bigint,
  trips_completed bigint,
  trips_cancelled bigint,
  trips_active bigint,
  completion_rate numeric,
  booking_rate numeric,
  avg_bookings_per_trip numeric,
  total_bookings bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  RETURN QUERY
  WITH period_trips AS (
    SELECT t.id, t.status
    FROM public.trips t
    WHERE (p_date_from IS NULL OR t.created_at >= p_date_from)
      AND (p_date_to IS NULL OR t.created_at <= p_date_to)
  ),
  trip_bookings AS (
    SELECT b.trip_id, count(*) AS booking_count
    FROM public.bookings b
    WHERE b.trip_id IN (SELECT id FROM period_trips)
    GROUP BY b.trip_id
  )
  SELECT
    count(*)::bigint AS trips_created,
    count(*) FILTER (WHERE pt.status = 'completed')::bigint AS trips_completed,
    count(*) FILTER (WHERE pt.status IN ('cancelled', 'expired'))::bigint AS trips_cancelled,
    count(*) FILTER (WHERE pt.status IN ('scheduled', 'ongoing'))::bigint AS trips_active,
    CASE WHEN count(*) > 0
      THEN round(100.0 * count(*) FILTER (WHERE pt.status = 'completed') / count(*), 1)
      ELSE NULL END AS completion_rate,
    CASE WHEN count(*) > 0
      THEN round(100.0 * count(*) FILTER (WHERE COALESCE(tb.booking_count, 0) > 0) / count(*), 1)
      ELSE NULL END AS booking_rate,
    CASE WHEN count(*) > 0
      THEN round(COALESCE(sum(COALESCE(tb.booking_count, 0)), 0)::numeric / count(*), 2)
      ELSE NULL END AS avg_bookings_per_trip,
    COALESCE(sum(COALESCE(tb.booking_count, 0)), 0)::bigint AS total_bookings
  FROM period_trips pt
  LEFT JOIN trip_bookings tb ON tb.trip_id = pt.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_trip_performance(timestamptz, timestamptz) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. get_admin_booking_performance(p_date_from, p_date_to)
--    Booking/Passenger Performance tab: scoped to bookings.created_at
--    within the period. repeat_booking_rate = % of passengers who booked
--    in the period that booked more than once in the SAME period — a
--    period-scoped, defensible reading of "repeat activity" rather than an
--    all-time claim.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_booking_performance(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  total_bookings bigint,
  completed_bookings bigint,
  cancelled_bookings bigint,
  active_bookings bigint,
  no_show_bookings bigint,
  completion_rate numeric,
  repeat_booking_rate numeric,
  unique_passengers bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  RETURN QUERY
  WITH period_bookings AS (
    SELECT b.id, b.status, b.passenger_id
    FROM public.bookings b
    WHERE (p_date_from IS NULL OR b.created_at >= p_date_from)
      AND (p_date_to IS NULL OR b.created_at <= p_date_to)
  ),
  passenger_counts AS (
    SELECT passenger_id, count(*) AS booking_count
    FROM period_bookings
    GROUP BY passenger_id
  )
  SELECT
    (SELECT count(*) FROM period_bookings)::bigint,
    (SELECT count(*) FROM period_bookings WHERE status = 'completed')::bigint,
    (SELECT count(*) FROM period_bookings WHERE status = 'cancelled')::bigint,
    (SELECT count(*) FROM period_bookings WHERE status IN ('pending', 'confirmed'))::bigint,
    (SELECT count(*) FROM period_bookings WHERE status = 'no_show')::bigint,
    CASE WHEN (SELECT count(*) FROM period_bookings) > 0
      THEN round(100.0 * (SELECT count(*) FROM period_bookings WHERE status = 'completed') / (SELECT count(*) FROM period_bookings), 1)
      ELSE NULL END,
    CASE WHEN (SELECT count(*) FROM passenger_counts) > 0
      THEN round(100.0 * (SELECT count(*) FROM passenger_counts WHERE booking_count > 1) / (SELECT count(*) FROM passenger_counts), 1)
      ELSE NULL END,
    (SELECT count(*) FROM passenger_counts)::bigint;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_booking_performance(timestamptz, timestamptz) TO authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_admin_driver_performance(p_date_from, p_date_to)
--    Driver Performance tab + "Driver Performance Report" export. One row
--    per driver who has at least one trip created in the period (drivers
--    with zero activity in the selected window are simply not listed for
--    that window, rather than padding the table with all-zero rows — they
--    still show up when the range is widened / set to All time). Trip and
--    booking counts are scoped to the SAME period via the trip's
--    created_at; rating is intentionally NOT period-scoped (a rating is
--    tied to the trip it was given for, not to when it was queried) and
--    follows the established NULL-not-0.0 convention.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_driver_performance(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  driver_id uuid,
  driver_name text,
  verification_status text,
  account_status text,
  trips_created bigint,
  trips_completed bigint,
  trips_cancelled bigint,
  bookings_received bigint,
  bookings_completed bigint,
  avg_rating numeric,
  rating_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  RETURN QUERY
  WITH period_trips AS (
    SELECT t.id, t.driver_id, t.status
    FROM public.trips t
    WHERE (p_date_from IS NULL OR t.created_at >= p_date_from)
      AND (p_date_to IS NULL OR t.created_at <= p_date_to)
  ),
  period_bookings AS (
    SELECT b.trip_id, b.status, pt.driver_id
    FROM public.bookings b
    JOIN period_trips pt ON pt.id = b.trip_id
  ),
  driver_ratings AS (
    SELECT r.ratee_id, round(avg(r.rating)::numeric, 2) AS avg_rating, count(*)::bigint AS rating_count
    FROM public.ratings r
    WHERE r.rating_type = 'passenger_to_driver' AND r.removed_at IS NULL
    GROUP BY r.ratee_id
  )
  SELECT
    dp.profile_id,
    p.full_name,
    dp.verification_status,
    dp.account_status,
    count(pt.id)::bigint AS trips_created,
    count(pt.id) FILTER (WHERE pt.status = 'completed')::bigint AS trips_completed,
    count(pt.id) FILTER (WHERE pt.status IN ('cancelled', 'expired'))::bigint AS trips_cancelled,
    (SELECT count(*) FROM period_bookings pb WHERE pb.driver_id = dp.profile_id)::bigint AS bookings_received,
    (SELECT count(*) FROM period_bookings pb WHERE pb.driver_id = dp.profile_id AND pb.status = 'completed')::bigint AS bookings_completed,
    dr.avg_rating,
    COALESCE(dr.rating_count, 0) AS rating_count
  FROM public.driver_profiles dp
  JOIN public.profiles p ON p.id = dp.profile_id
  JOIN period_trips pt ON pt.driver_id = dp.profile_id
  LEFT JOIN driver_ratings dr ON dr.ratee_id = dp.profile_id
  GROUP BY dp.profile_id, p.full_name, dp.verification_status, dp.account_status, dr.avg_rating, dr.rating_count
  ORDER BY trips_completed DESC, trips_created DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_driver_performance(timestamptz, timestamptz) TO authenticated;


-- ----------------------------------------------------------------------------
-- 5. get_admin_trip_performance_report(p_date_from, p_date_to)
--    "Trip Performance Report" export listing — one row per trip created
--    in the period, with driver/route/status/bookings/completion context.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_trip_performance_report(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  trip_id uuid,
  driver_name text,
  origin text,
  destination text,
  departure_time timestamptz,
  status text,
  total_seats integer,
  available_seats integer,
  bookings_count bigint,
  completed_bookings_count bigint,
  cancelled_bookings_count bigint,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    p.full_name,
    t.origin,
    t.destination,
    t.departure_time,
    t.status,
    t.total_seats,
    t.available_seats,
    count(b.id)::bigint,
    count(b.id) FILTER (WHERE b.status = 'completed')::bigint,
    count(b.id) FILTER (WHERE b.status = 'cancelled')::bigint,
    t.cancelled_at,
    t.cancellation_reason,
    t.created_at
  FROM public.trips t
  JOIN public.profiles p ON p.id = t.driver_id
  LEFT JOIN public.bookings b ON b.trip_id = t.id
  WHERE (p_date_from IS NULL OR t.created_at >= p_date_from)
    AND (p_date_to IS NULL OR t.created_at <= p_date_to)
  GROUP BY t.id, p.full_name
  ORDER BY t.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_trip_performance_report(timestamptz, timestamptz) TO authenticated;


-- ----------------------------------------------------------------------------
-- 6. get_admin_booking_report(p_date_from, p_date_to)
--    "Booking Report" export listing. Deliberately excludes phone/email/
--    national_id/emergency-contact fields — an admin doing a bulk export
--    of every booking in a quarter does not need every passenger's/
--    driver's contact details in that file; those stay one click away on
--    the existing per-user detail pages for the (rare) case they're
--    actually needed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_booking_report(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  booking_id uuid,
  booking_reference text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  driver_name text,
  passenger_name text,
  status text,
  seats_booked integer,
  total_price numeric,
  refund_status text,
  created_at timestamptz,
  cancelled_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  RETURN QUERY
  SELECT
    b.id,
    b.booking_reference,
    t.id,
    t.origin,
    t.destination,
    t.departure_time,
    dp.full_name,
    pp.full_name,
    b.status,
    b.seats_booked,
    b.total_price,
    b.refund_status,
    b.created_at,
    b.cancelled_at
  FROM public.bookings b
  JOIN public.trips t ON t.id = b.trip_id
  JOIN public.profiles dp ON dp.id = t.driver_id
  JOIN public.profiles pp ON pp.id = b.passenger_id
  WHERE (p_date_from IS NULL OR b.created_at >= p_date_from)
    AND (p_date_to IS NULL OR b.created_at <= p_date_to)
  ORDER BY b.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_booking_report(timestamptz, timestamptz) TO authenticated;


-- ----------------------------------------------------------------------------
-- 7. get_admin_daily_activity(p_date_from, p_date_to)
--    Day-bucketed counts for the Performance tab's simple trend charts.
--    Buckets by created_at date in the platform's server timezone (UTC).
--    Capped to a 366-day span server-side so a mistaken multi-year custom
--    range can't return an unbounded number of buckets to the client.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_daily_activity(
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  activity_date date,
  trips_created bigint,
  bookings_created bigint,
  trips_completed bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_from timestamptz := COALESCE(p_date_from, now() - interval '29 days');
  v_to timestamptz := COALESCE(p_date_to, now());
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only an administrator may view platform analytics';
  END IF;

  IF v_to - v_from > interval '366 days' THEN
    v_from := v_to - interval '366 days';
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(date_trunc('day', v_from), date_trunc('day', v_to), interval '1 day')::date AS d
  ),
  trips_by_day AS (
    SELECT date_trunc('day', t.created_at)::date AS d, count(*) AS created_count
    FROM public.trips t
    WHERE t.created_at >= date_trunc('day', v_from) AND t.created_at < date_trunc('day', v_to) + interval '1 day'
    GROUP BY 1
  ),
  bookings_by_day AS (
    SELECT date_trunc('day', b.created_at)::date AS d, count(*) AS created_count
    FROM public.bookings b
    WHERE b.created_at >= date_trunc('day', v_from) AND b.created_at < date_trunc('day', v_to) + interval '1 day'
    GROUP BY 1
  ),
  completions_by_day AS (
    -- trips.completed_at (added by trip_auto_completion.sql) is the actual
    -- completion timestamp; falls back to updated_at for any pre-migration
    -- row where it's null, so older completed trips still show up somewhere
    -- rather than silently vanishing from the trend.
    SELECT date_trunc('day', COALESCE(t.completed_at, t.updated_at))::date AS d, count(*) AS completed_count
    FROM public.trips t
    WHERE t.status = 'completed'
      AND COALESCE(t.completed_at, t.updated_at) >= date_trunc('day', v_from)
      AND COALESCE(t.completed_at, t.updated_at) < date_trunc('day', v_to) + interval '1 day'
    GROUP BY 1
  )
  SELECT
    days.d,
    COALESCE(tbd.created_count, 0)::bigint,
    COALESCE(bbd.created_count, 0)::bigint,
    COALESCE(cbd.completed_count, 0)::bigint
  FROM days
  LEFT JOIN trips_by_day tbd ON tbd.d = days.d
  LEFT JOIN bookings_by_day bbd ON bbd.d = days.d
  LEFT JOIN completions_by_day cbd ON cbd.d = days.d
  ORDER BY days.d;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_daily_activity(timestamptz, timestamptz) TO authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
