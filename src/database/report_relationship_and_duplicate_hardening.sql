-- ============================================================================
-- PamojaRide — Reports: 403 root-cause fix + relationship hardening +
-- duplicate-submission handling.
--
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- trip_complaints_admin_alerts_cancellation_history.sql and
-- report_dispute_system_fix.sql (same `reports` table, same INSERT policy
-- name — this only DROPs/CREATEs that one policy and adds one new function
-- + one new index). Safe to run multiple times. No table is dropped, no
-- row is deleted, no existing report's data is changed.
-- ============================================================================
--
-- ROOT CAUSE OF THE 403 ("new row violates row-level security policy for
-- table reports"):
--
--   components/shared/ReportModal.jsx built its insert payload WITHOUT
--   `reporter_id`:
--
--     supabase.from('reports').insert({
--       reported_user_id, trip_id, booking_id, category, description
--     })
--
--   `reports.reporter_id` is NOT NULL with no column default (see db.sql),
--   and the existing INSERT policy's WITH CHECK requires
--   `reporter_id = auth.uid()`. With reporter_id omitted from the payload
--   the new row's reporter_id is NULL, which can never equal auth.uid() —
--   so the WITH CHECK clause fails and PostgREST returns exactly the 403 /
--   "new row violates row-level security policy" reported. Every other
--   part of the existing design (RLS enabled, INSERT/SELECT/UPDATE
--   policies, the admin-notify trigger, the reported-party-notify trigger,
--   get_admin_reports()) was already correct and is left untouched by this
--   migration — see trip_complaints_admin_alerts_cancellation_history.sql
--   and report_dispute_system_fix.sql.
--
--   THE FIX for this half is in the frontend (this migration doesn't need
--   to touch it): ReportModal.jsx now takes a required `reporterId` prop —
--   passed down from passenger/MyBookings.jsx and driver/Bookings.jsx,
--   both of which already have the signed-in user's id via useAuth() — and
--   includes it as `reporter_id` in the insert payload. Same pattern
--   RatingModal.jsx already uses for `rater_id`.
--
-- SECOND GAP FOUND WHILE VERIFYING "legitimate relationship" ENFORCEMENT:
--
--   The existing INSERT policy only checked that the REPORTER is involved
--   in the trip (public.user_is_involved_in_trip) — it never checked that
--   `reported_user_id` or `booking_id` actually correspond to that same
--   trip/relationship. In practice this meant: a passenger with ANY
--   booking on trip X could set `reported_user_id` to an unrelated
--   profile id (not that trip's driver) and the insert would still pass,
--   because reported_user_id was only checked for "not myself", never for
--   "is this actually the other party in this relationship". This
--   migration closes that gap with report_relationship_is_valid(), which
--   enforces the brief's required relationship in both directions:
--     - Passenger -> Driver: reporter must have a booking on the trip, and
--       reported_user_id (if set) must be exactly that trip's driver_id;
--       booking_id (if set) must belong to that trip AND that passenger.
--     - Driver -> Passenger: reporter must be that trip's driver, and
--       reported_user_id (if set) must be a passenger with a booking on
--       that trip; booking_id (if set) must belong to that trip.
--     - Account appeals (trip_id NULL, reported_user_id NULL) are
--       untouched — still allowed, exactly as before.
--
-- THIRD ITEM FROM THE BRIEF — duplicate submissions:
--
--   Adds a partial unique index so the SAME reporter can't have two
--   simultaneously-OPEN reports on the SAME booking. Once the first is
--   moved out of 'open' (under_review/resolved/closed) by an admin, a new
--   report on that booking is allowed again — so a genuinely new incident
--   is never blocked, only exact-duplicate spam of an already-pending
--   report. Reports with booking_id NULL (account appeals, or a report
--   filed against a trip with no specific booking) are unaffected.
--   ReportModal.jsx now catches this constraint's error code (23505) and
--   shows a friendly "already submitted, under review" message instead of
--   a raw database error.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. report_relationship_is_valid(): the real relationship check, used by
--    the INSERT policy below. SECURITY DEFINER (same style as
--    user_is_involved_in_trip / is_admin / etc elsewhere in this project)
--    so it gives a correct answer regardless of the caller's own SELECT
--    access to trips/bookings.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_relationship_is_valid(
  p_reporter_id uuid,
  p_reported_user_id uuid,
  p_trip_id uuid,
  p_booking_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
BEGIN
  -- Account appeals / general reports not tied to a trip (status/Banned.jsx)
  -- — unrelated to the driver/passenger relationship rules, unchanged.
  IF p_trip_id IS NULL THEN
    RETURN p_reported_user_id IS NULL;
  END IF;

  SELECT id, driver_id INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF v_trip.id IS NULL THEN
    RETURN false; -- trip doesn't exist
  END IF;

  -- Reporter is the trip's driver -> reporting a passenger on this trip.
  IF v_trip.driver_id = p_reporter_id THEN
    IF p_reported_user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings
      WHERE trip_id = p_trip_id AND passenger_id = p_reported_user_id
    ) THEN
      RETURN false;
    END IF;
    IF p_booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings WHERE id = p_booking_id AND trip_id = p_trip_id
    ) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  -- Reporter is a passenger with a booking on this trip -> reporting the driver.
  IF EXISTS (SELECT 1 FROM public.bookings WHERE trip_id = p_trip_id AND passenger_id = p_reporter_id) THEN
    IF p_reported_user_id IS NOT NULL AND p_reported_user_id <> v_trip.driver_id THEN
      RETURN false;
    END IF;
    IF p_booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings
      WHERE id = p_booking_id AND trip_id = p_trip_id AND passenger_id = p_reporter_id
    ) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  -- Reporter has no relationship (as driver or passenger) to this trip at all.
  RETURN false;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.report_relationship_is_valid(uuid, uuid, uuid, uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. Re-scope the INSERT policy to use the relationship check above
--    instead of the looser "reporter is involved in the trip, reported
--    party unchecked" test. Everything else about the policy (own-reports
--    only, can't pre-seed moderation fields, can't report yourself) is
--    unchanged from trip_complaints_admin_alerts_cancellation_history.sql.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "users can create own complaints" ON public.reports;
CREATE POLICY "users can create own complaints"
ON public.reports FOR INSERT
WITH CHECK (
  reporter_id = auth.uid()
  AND coalesce(status, 'open') = 'open'
  AND resolved_by IS NULL
  AND resolved_at IS NULL
  AND assigned_to IS NULL
  AND (reported_user_id IS NULL OR reported_user_id <> auth.uid())
  AND public.report_relationship_is_valid(auth.uid(), reported_user_id, trip_id, booking_id)
);


-- ----------------------------------------------------------------------------
-- 3. Duplicate-submission handling: at most one OPEN report per
--    (reporter, booking). Reports with booking_id IS NULL are not
--    constrained by this index (account appeals, trip-only reports).
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_open_reporter_booking
ON public.reports (reporter_id, booking_id)
WHERE status = 'open' AND booking_id IS NOT NULL;

-- ============================================================================
-- End of migration.
-- ============================================================================
