-- ============================================================================
-- PamojaRide — Admin Reports Management (Prompt 7)
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- my_reports_tracking.sql (the most recent report-system migration — this
-- one only extends the existing get_admin_reports() RPC and adds one new
-- read-only counts RPC on top of it). Safe to run multiple times: the
-- function this file replaces is dropped and recreated with the same name
-- (only its parameter list / return columns grow), and the new function is
-- CREATE OR REPLACE. No table is created, dropped, or truncated. No RLS
-- policy is added, removed, or changed. No existing report row is touched.
-- ============================================================================
--
-- SCOPE: this migration exists purely to power a more professional Admin
-- Reports page — search, filters, a richer detail view, and real summary
-- counts. It reuses the exact same `public.reports` table (and
-- `public.report_status_history` from my_reports_tracking.sql) that has
-- backed every part of this feature since trip_complaints_admin_alerts_
-- cancellation_history.sql. It does not add a second report system, does
-- not add a new status, and does not touch the notification triggers
-- already defined in report_dispute_system_fix.sql / report_status_
-- workflow_notifications.sql / my_reports_tracking.sql — those keep firing
-- exactly as before whenever admin/ReportDetails.jsx updates `reports.status`
-- (still a plain UPDATE, still gated by the existing "admin can update
-- complaints" RLS policy).
--
-- WHAT THIS ADDS:
--
--   1. get_admin_reports() — DROPped and recreated (Postgres won't let
--      CREATE OR REPLACE change a function's parameter list or column
--      list, same reason driver_booking_report_fields.sql had to do this
--      for get_driver_trip_bookings()). The new version:
--        - adds `report_reference`, `updated_at`, `reporter_role`,
--          `reported_role`, `pickup_point`, `dropoff_point`, `booking_id`,
--          `booking_reference`, `seats_booked` to the result — everything
--          the improved list/detail views need, still resolved
--          server-side (same reason this RPC exists at all: profiles' RLS
--          only allows reading your own row, so a client-side embed
--          silently returns null for every other admin query);
--        - adds optional filter parameters: p_category, p_reporter_role,
--          p_reported_role, p_search, p_date_from, p_date_to. Every one
--          defaults to NULL and is skipped when NULL/'all', so any
--          existing caller that only passes p_status keeps working
--          unchanged;
--        - adds an optional p_report_id parameter (same "optional id, same
--          scoping" pattern get_my_reports() and get_driver_trip_bookings()
--          already use) so the SAME RPC serves both the reports list and a
--          single report's detail view — no second, near-duplicate
--          function to maintain;
--        - search matches report reference, reporter/reported name, trip
--          route, or booking reference — exactly the fields the brief asks
--          for, still admin-only and still read-only.
--      Still admin-only (raises otherwise) and still changes no data.
--
--   2. get_admin_report_counts() — one new read-only, admin-only RPC
--      returning real counts per status straight from `public.reports`
--      (open / under_review / resolved / closed / total), so the summary
--      cards on the Admin Reports page are never hardcoded.
--
-- SECURITY — nothing here changes:
--   - No RLS policy on `reports`, `report_status_history`, or any other
--     table is touched. INSERT/SELECT/UPDATE on `reports` stay exactly as
--     defined in trip_complaints_admin_alerts_cancellation_history.sql,
--     report_dispute_system_fix.sql, and report_relationship_and_
--     duplicate_hardening.sql. Passenger/driver report access (their own
--     reports only, via get_my_reports()) is completely untouched.
--   - Both functions are SECURITY DEFINER purely so they can resolve
--     profiles/trips/bookings context safely (same established pattern as
--     every other admin RPC in this project) — both re-check
--     public.is_admin(auth.uid()) themselves and raise otherwise. Granting
--     EXECUTE to `authenticated` does not grant a non-admin caller any
--     data: the function body itself refuses them before touching a row.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. get_admin_reports(): richer columns, real filters, optional search,
--    and an optional p_report_id for reusing this one RPC as the detail
--    fetch too.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_admin_reports(text);

CREATE OR REPLACE FUNCTION public.get_admin_reports(
  p_status text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_reporter_role text DEFAULT NULL,   -- 'driver' | 'passenger' | 'appellant' | 'all'/NULL
  p_reported_role text DEFAULT NULL,   -- 'driver' | 'passenger' | 'all'/NULL
  p_search text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_report_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  report_reference text,
  status text,
  category text,
  description text,
  created_at timestamptz,
  updated_at timestamptz,
  resolution_notes text,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_name text,
  reporter_id uuid,
  reporter_name text,
  reporter_email text,
  reporter_role text,
  reported_user_id uuid,
  reported_name text,
  reported_email text,
  reported_role text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  pickup_point text,
  dropoff_point text,
  booking_id uuid,
  booking_reference text,
  seats_booked integer,
  is_account_appeal boolean,
  report_direction text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view reports';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    'RPT-' || upper(left(r.id::text, 8)) AS report_reference,
    r.status, r.category, r.description, r.created_at, r.updated_at,
    r.resolution_notes, r.resolved_at, r.resolved_by, rb.full_name AS resolved_by_name,
    r.reporter_id, rp.full_name AS reporter_name, rp.email AS reporter_email,
    CASE
      WHEN r.description LIKE '[Account appeal%' THEN 'appellant'
      WHEN t.driver_id IS NOT NULL AND t.driver_id = r.reporter_id THEN 'driver'
      WHEN r.trip_id IS NOT NULL THEN 'passenger'
      ELSE NULL
    END AS reporter_role,
    r.reported_user_id, tu.full_name AS reported_name, tu.email AS reported_email,
    CASE
      WHEN r.reported_user_id IS NULL THEN NULL
      WHEN t.driver_id IS NOT NULL AND t.driver_id = r.reported_user_id THEN 'driver'
      WHEN r.trip_id IS NOT NULL THEN 'passenger'
      ELSE NULL
    END AS reported_role,
    r.trip_id, t.origin, t.destination, t.departure_time, t.pickup_point, t.dropoff_point,
    r.booking_id, b.booking_reference, b.seats_booked,
    (r.description LIKE '[Account appeal%') AS is_account_appeal,
    CASE
      WHEN r.description LIKE '[Account appeal%' THEN 'account_appeal'
      WHEN t.driver_id IS NOT NULL AND t.driver_id = r.reporter_id THEN 'driver_to_passenger'
      WHEN t.driver_id IS NOT NULL AND t.driver_id = r.reported_user_id THEN 'passenger_to_driver'
      ELSE 'other'
    END AS report_direction
  FROM public.reports r
  LEFT JOIN public.profiles rp ON rp.id = r.reporter_id
  LEFT JOIN public.profiles tu ON tu.id = r.reported_user_id
  LEFT JOIN public.profiles rb ON rb.id = r.resolved_by
  LEFT JOIN public.trips t ON t.id = r.trip_id
  LEFT JOIN public.bookings b ON b.id = r.booking_id
  WHERE (p_report_id IS NULL OR r.id = p_report_id)
    AND (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
    AND (p_category IS NULL OR p_category = 'all' OR r.category = p_category)
    AND (
      p_reporter_role IS NULL OR p_reporter_role = 'all' OR
      (p_reporter_role = 'appellant' AND r.description LIKE '[Account appeal%') OR
      (p_reporter_role = 'driver' AND t.driver_id IS NOT NULL AND t.driver_id = r.reporter_id) OR
      (p_reporter_role = 'passenger' AND r.trip_id IS NOT NULL
        AND NOT (t.driver_id IS NOT NULL AND t.driver_id = r.reporter_id))
    )
    AND (
      p_reported_role IS NULL OR p_reported_role = 'all' OR
      (p_reported_role = 'driver' AND t.driver_id IS NOT NULL AND t.driver_id = r.reported_user_id) OR
      (p_reported_role = 'passenger' AND r.reported_user_id IS NOT NULL
        AND NOT (t.driver_id IS NOT NULL AND t.driver_id = r.reported_user_id))
    )
    AND (p_date_from IS NULL OR r.created_at::date >= p_date_from)
    AND (p_date_to IS NULL OR r.created_at::date <= p_date_to)
    AND (
      p_search IS NULL OR trim(p_search) = '' OR
      ('RPT-' || upper(left(r.id::text, 8))) ILIKE ('%' || trim(p_search) || '%') OR
      rp.full_name ILIKE ('%' || trim(p_search) || '%') OR
      tu.full_name ILIKE ('%' || trim(p_search) || '%') OR
      t.origin ILIKE ('%' || trim(p_search) || '%') OR
      t.destination ILIKE ('%' || trim(p_search) || '%') OR
      b.booking_reference ILIKE ('%' || trim(p_search) || '%')
    )
  ORDER BY r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_reports(text, text, text, text, text, date, date, uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. get_admin_report_counts(): real, live counts per status for the
--    summary cards. No count is ever hardcoded in the frontend.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_report_counts()
RETURNS TABLE (
  open_count bigint,
  under_review_count bigint,
  resolved_count bigint,
  closed_count bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view report counts';
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE status = 'open'),
    count(*) FILTER (WHERE status = 'under_review'),
    count(*) FILTER (WHERE status = 'resolved'),
    count(*) FILTER (WHERE status = 'closed'),
    count(*)
  FROM public.reports;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_report_counts() TO authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
