-- ============================================================================
-- PamojaRide — Trip Complaints, Admin Alerts, and Cancellation History
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- driver_passenger_booking_cancellation.sql (the most recent cancellation
-- migration) and notifications_fix.sql.
--
-- Safe to run multiple times. Adds columns with IF NOT EXISTS, drops/recreates
-- only the specific policies, functions and trigger this file owns, and never
-- drops or truncates a table. No existing row is deleted. No payment/refund
-- behaviour is touched.
-- ============================================================================
--
-- What this does:
--
--   1. TRIP COMPLAINTS — the existing `reports` table already captures every
--      field the brief asks for (trip, reporter, other user, category,
--      description, timestamp, status), and ReportModal.jsx / Reports.jsx
--      already exercise it end-to-end. What was missing:
--        a. `reports` had NO row-level-security policies at all defined in
--           any prior migration in this codebase, so this closes that gap
--           explicitly (own-report + admin visibility only).
--        b. The status vocabulary was open / under_review / resolved /
--           dismissed. This renames 'dismissed' -> 'closed' (data + the
--           constraint) to match the requested professional status set:
--           Open, Under Review, Resolved, Closed. Nothing else about the
--           existing workflow (ban/suspension appeals sharing this same
--           table) changes.
--        c. A driver had no complaint entry point at all (ReportModal was
--           only ever wired into passenger/MyBookings.jsx) — the app change
--           accompanying this migration adds the same modal, generalised,
--           to driver/Bookings.jsx.
--
--   2. ADMIN ALERTS — a new AFTER INSERT trigger on `reports` notifies every
--      admin profile through the EXISTING public.notify(...)/notifications
--      pipeline (no new notification system). It sends one notification per
--      admin per complaint, includes only what's needed to locate the
--      affected trip (route + departure time + category), leaves the full
--      free-text description out of the notification body, and is guarded
--      by an existence check so re-running this trigger logic (or any retry)
--      can never create a second notification for the same admin/report
--      pair.
--
--   3. CANCELLATION HISTORY — trip cancellations (`trips.cancellation_reason`
--      / `cancellation_reason_category` / `cancelled_by` / `cancelled_at`)
--      and per-booking driver cancellations (the same four columns on
--      `bookings`) already exist and are already never deleted — cancel_trip
--      and cancel_booking only ever UPDATE the row. What was missing was a
--      single admin-only read path that surfaces BOTH kinds of cancellation
--      together for review. This adds one read-only RPC,
--      get_cancellation_history(), and the accompanying app change adds one
--      small, collapsed-by-default panel to the existing admin/TripOversight
--      page — no new admin route, no sidebar change, no redesign.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1a. Rename the 'dismissed' status to 'closed' (data first, then the
--     constraint, so no row is ever left violating it).
-- ----------------------------------------------------------------------------

UPDATE public.reports SET status = 'closed' WHERE status = 'dismissed';

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_status_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_status_check
  CHECK (status = ANY (ARRAY['open'::text, 'under_review'::text, 'resolved'::text, 'closed'::text]));


-- ----------------------------------------------------------------------------
-- 1b. Helper: is this user a participant (driver or passenger) on this
--     trip? SECURITY DEFINER so the RLS policy below gives a correct answer
--     regardless of whatever SELECT policies exist (or don't) on
--     trips/bookings for the calling role — mirrors the style already used
--     throughout this project (is_admin, complete_trip, cancel_trip, etc).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_is_involved_in_trip(p_user_id uuid, p_trip_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    EXISTS (SELECT 1 FROM public.trips WHERE id = p_trip_id AND driver_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.bookings WHERE trip_id = p_trip_id AND passenger_id = p_user_id);
$function$;

GRANT EXECUTE ON FUNCTION public.user_is_involved_in_trip(uuid, uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 1c. RLS on `reports` — this table had no policies at all before this
--     migration.
--       - INSERT: a user can only ever file a complaint as themselves, only
--         about a trip they're actually a driver or passenger on (or with
--         trip_id left NULL entirely — the account-appeal path used by
--         status/Banned.jsx, which is unrelated to any specific trip), can
--         never report themselves, and cannot pre-seed the moderation
--         fields (status/resolved_by/resolved_at/assigned_to) — those can
--         only move forward later, by an admin, through the UPDATE policy.
--       - SELECT: only the reporter themselves, or an admin. The person
--         being reported about is deliberately NOT granted visibility here
--         (avoids tipping off the other party / retaliation, and matches
--         "do not allow users to view complaints belonging to other users
--         unless they are authorized administrators").
--       - UPDATE: admin only (this is how Reports.jsx moves a complaint
--         through under_review / resolved / closed and records notes).
--       - DELETE: intentionally NO policy at all, for anyone, including
--         admins — RLS defaults to deny, so a complaint can never be
--         deleted through the app, keeping it available for future review
--         permanently.
-- ----------------------------------------------------------------------------

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

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
  AND (trip_id IS NULL OR public.user_is_involved_in_trip(auth.uid(), trip_id))
);

DROP POLICY IF EXISTS "users can view own complaints" ON public.reports;
CREATE POLICY "users can view own complaints"
ON public.reports FOR SELECT
USING (reporter_id = auth.uid() OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "admin can update complaints" ON public.reports;
CREATE POLICY "admin can update complaints"
ON public.reports FOR UPDATE
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- Helpful indexes for the access patterns above / Reports.jsx's filters.
CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON public.reports (reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports (status);
CREATE INDEX IF NOT EXISTS idx_reports_trip_id ON public.reports (trip_id);


-- ----------------------------------------------------------------------------
-- 2a. Add 'complaint_submitted' to the notifications type vocabulary — same
--     "restate the full canonical list" pattern every prior migration that
--     touched this constraint has used. Nothing removed.
-- ----------------------------------------------------------------------------

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'booking_created'::text, 'booking_confirmed'::text, 'booking_cancelled'::text,
    'booking_no_show'::text,
    'trip_started'::text, 'trip_cancelled'::text, 'trip_reminder'::text,
    'trip_completion_pending'::text, 'trip_completed'::text,
    'kyc_submitted'::text, 'kyc_approved'::text, 'kyc_rejected'::text,
    'verification_required'::text, 'account_suspended'::text, 'account_reactivated'::text,
    'account_banned'::text,
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text,
    'complaint_submitted'::text
  ]));


-- ----------------------------------------------------------------------------
-- 2b. notify_admins_of_new_report(): fires once per newly-inserted
--     complaint (AFTER INSERT, FOR EACH ROW — a single lifecycle event per
--     submission, so it can never fire twice for the same complaint just by
--     virtue of how it's triggered), and loops every admin profile. The
--     existence check before each insert is a second, independent guard:
--     even if this function were ever called again for the same report
--     (e.g. a future manual re-run), no admin ever receives a second
--     notification for the same report id.
--
--     Deliberately excluded from the notification body: the complaint's
--     free-text description, and the reported party's contact details.
--     Only the trip route/time (to identify the affected trip) and the
--     category are included — an admin opens Reports & Appeals for the
--     rest, which is already gated to admins only by the RLS policy above.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_admins_of_new_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin RECORD;
  v_trip RECORD;
  v_is_appeal boolean;
  v_reporter_role text;
  v_title text;
  v_body text;
BEGIN
  v_is_appeal := NEW.description LIKE '[Account appeal%';

  IF NEW.trip_id IS NOT NULL THEN
    SELECT origin, destination, departure_time, driver_id
      INTO v_trip
      FROM public.trips WHERE id = NEW.trip_id;
  END IF;

  v_reporter_role := CASE
    WHEN v_trip.driver_id IS NOT NULL AND v_trip.driver_id = NEW.reporter_id THEN 'Driver'
    WHEN NEW.trip_id IS NOT NULL THEN 'Passenger'
    ELSE NULL
  END;

  IF v_is_appeal THEN
    v_title := 'New account appeal submitted';
    v_body := 'A user has appealed a suspension/ban decision. Review it in Reports & Appeals.';
  ELSIF v_trip.origin IS NOT NULL THEN
    v_title := 'New complaint submitted';
    v_body := format(
      '%s complaint (%s) on trip %s -> %s, departing %s. Review it in Reports & Appeals.',
      coalesce(v_reporter_role, 'A user'), NEW.category, v_trip.origin, v_trip.destination,
      to_char(v_trip.departure_time, 'DD Mon, HH24:MI')
    );
  ELSE
    v_title := 'New complaint submitted';
    v_body := format('A new %s complaint was submitted. Review it in Reports & Appeals.', NEW.category);
  END IF;

  FOR v_admin IN SELECT id FROM public.profiles WHERE is_admin = true LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = v_admin.id
        AND type = 'complaint_submitted'
        AND (data->>'report_id')::uuid = NEW.id
    ) THEN
      PERFORM public.notify(
        v_admin.id, 'complaint_submitted', v_title, v_body,
        jsonb_build_object(
          'report_id', NEW.id,
          'trip_id', NEW.trip_id,
          'category', NEW.category
        )
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_admins_of_new_report ON public.reports;
CREATE TRIGGER trg_notify_admins_of_new_report
AFTER INSERT ON public.reports
FOR EACH ROW EXECUTE FUNCTION public.notify_admins_of_new_report();


-- ----------------------------------------------------------------------------
-- 3. get_cancellation_history(): one read-only, admin-only RPC surfacing
--    BOTH whole-trip cancellations and individual driver-initiated booking
--    cancellations, newest first. Nothing is deleted or altered by this
--    function — SELECT only. Raises if the caller isn't an admin, same
--    style as the rest of this codebase's authorization failures.
--
--    Booking rows are restricted to cancellations NOT initiated by the
--    passenger themselves (cancelled_by <> passenger_id) — i.e. exactly
--    "driver cancelling a passenger booking" (or an admin override) per
--    the brief. A passenger's own self-cancellation already has its own
--    reason recorded on the booking too and is visible to the passenger
--    themselves in My Bookings; it isn't a moderation concern for this
--    admin-review panel.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_cancellation_history()
RETURNS TABLE (
  source text,
  id uuid,
  trip_id uuid,
  booking_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancelled_by_name text,
  cancellation_reason text,
  cancellation_reason_category text,
  passenger_id uuid,
  passenger_name text,
  driver_id uuid,
  driver_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view cancellation history';
  END IF;

  RETURN QUERY
  SELECT
    'trip'::text AS source,
    t.id AS id,
    t.id AS trip_id,
    NULL::uuid AS booking_id,
    t.origin, t.destination, t.departure_time,
    t.cancelled_at, t.cancelled_by, cb.full_name AS cancelled_by_name,
    t.cancellation_reason, t.cancellation_reason_category,
    NULL::uuid AS passenger_id, NULL::text AS passenger_name,
    t.driver_id, dp.full_name AS driver_name
  FROM public.trips t
  LEFT JOIN public.profiles cb ON cb.id = t.cancelled_by
  LEFT JOIN public.profiles dp ON dp.id = t.driver_id
  WHERE t.status = 'cancelled'

  UNION ALL

  SELECT
    'booking'::text AS source,
    b.id AS id,
    b.trip_id AS trip_id,
    b.id AS booking_id,
    t.origin, t.destination, t.departure_time,
    b.cancelled_at, b.cancelled_by, cb.full_name AS cancelled_by_name,
    b.cancellation_reason, b.cancellation_reason_category,
    b.passenger_id, pp.full_name AS passenger_name,
    t.driver_id, dp.full_name AS driver_name
  FROM public.bookings b
  JOIN public.trips t ON t.id = b.trip_id
  LEFT JOIN public.profiles cb ON cb.id = b.cancelled_by
  LEFT JOIN public.profiles pp ON pp.id = b.passenger_id
  LEFT JOIN public.profiles dp ON dp.id = t.driver_id
  WHERE b.status = 'cancelled'
    AND b.cancelled_by IS NOT NULL
    AND b.cancelled_by <> b.passenger_id

  ORDER BY cancelled_at DESC NULLS LAST;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_cancellation_history() TO authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
