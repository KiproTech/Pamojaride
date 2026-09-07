-- ============================================================================
-- PamojaRide — Report / Complaint / Dispute System: Fixes
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- trip_complaints_admin_alerts_cancellation_history.sql (this migration
-- only extends what that one created — same `reports` table, same trigger
-- function name, same notification pipeline). Safe to run multiple times:
-- every statement is IF NOT EXISTS / CREATE OR REPLACE / a constraint
-- restated in full. No table is dropped. No existing report row is
-- deleted or has its reporter/category/description changed.
-- ============================================================================
--
-- ROOT CAUSES FOUND (two separate bugs, not one):
--
--   BUG 1 — the reported user was never notified.
--   trip_complaints_admin_alerts_cancellation_history.sql's
--   notify_admins_of_new_report() trigger does exactly what its name says:
--   it loops over admins ONLY. Nothing anywhere in this codebase ever
--   notified the driver/passenger the report was actually about, even
--   though ReportModal.jsx has always correctly captured and stored
--   `reported_user_id`. This migration extends that same trigger function
--   (same name, same trigger, still fires once per report — not a second
--   trigger, so this can't double-notify admins) to also notify the
--   reported party exactly once, with a generic, reporter-anonymous
--   message.
--
--   BUG 2 — admin/Reports.jsx couldn't reliably show WHO reported WHOM.
--   It queries `reports` with an embedded join:
--     .select('*, reporter:reporter_id(full_name, email),
--                  reported:reported_user_id(full_name, email)')
--   An embed is resolved under the RLS of the embedded table (`profiles`),
--   evaluated as the CALLING user — not the report owner, and Postgres
--   views/embeds don't grant elevated access on their own. Every profiles
--   policy actually defined anywhere in this project's migrations (see
--   critical_security_fixes.sql) is scoped to "your own row" — there is no
--   admin-wide SELECT policy on `profiles` in this codebase at all. So an
--   admin querying this embed gets `reporter: null` / `reported: null` for
--   any report that isn't literally their own profile — exactly the same
--   failure mode already diagnosed and fixed twice elsewhere in this
--   project (driver_profiles in critical_security_fixes.sql,
--   passenger-profile embeds in driver_booking_passenger_visibility.sql).
--   The fix here follows the same established pattern: one new
--   SECURITY DEFINER, admin-only RPC that resolves reporter/reported
--   names server-side and returns them directly — no client-side embed,
--   nothing left depending on profiles' RLS shape.
--
-- WHAT ELSE THIS DOES:
--
--   - Adds distinct, professional report categories so a passenger
--     reporting a driver and a driver reporting a passenger each see an
--     appropriate list (e.g. "Driver did not arrive" vs "Passenger did
--     not show up"), per the brief. This RESTATES the category check
--     constraint the same way every prior migration touching a check
--     constraint in this project has (full list, nothing removed) — every
--     existing report row keeps its original category untouched and still
--     valid.
--   - get_admin_reports() also returns a computed `report_direction`
--     ('passenger_to_driver' | 'driver_to_passenger' | 'account_appeal' |
--     'other') so Passenger→Driver and Driver→Passenger reports are
--     unambiguous in the admin UI, per the brief's requirement.
--
-- SECURITY — nothing here changes:
--   - The INSERT/SELECT/UPDATE policies on `reports` from
--     trip_complaints_admin_alerts_cancellation_history.sql are untouched.
--     A passenger still can't report a driver unrelated to a trip they're
--     actually on (user_is_involved_in_trip enforces this), users still
--     can't see each other's reports, and DELETE is still allowed to no
--     one.
--   - get_admin_reports() is admin-only (raises otherwise) and read-only —
--     it changes no data.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Expand the category vocabulary. Adds professional, role-appropriate
--    categories on top of the existing list — nothing removed, so every
--    report ever inserted (including account appeals, which always use
--    'other') keeps passing this constraint unchanged.
-- ----------------------------------------------------------------------------

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_category_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_category_check
  CHECK (category = ANY (ARRAY[
    -- Original categories — kept for every existing row.
    'safety'::text, 'harassment'::text, 'no_show'::text, 'payment_dispute'::text,
    'fake_profile'::text, 'vehicle_mismatch'::text, 'reckless_driving'::text,
    -- New, role-specific categories added by this migration.
    'driver_no_show'::text, 'passenger_no_show'::text, 'trip_dispute'::text,
    'communication_problem'::text, 'inappropriate_behaviour'::text, 'booking_issue'::text,
    'other'::text
  ]));


-- ----------------------------------------------------------------------------
-- 2. Extend the existing new-report trigger function to ALSO notify the
--    reported party (this is a CREATE OR REPLACE of the exact same
--    function trip_complaints_admin_alerts_cancellation_history.sql
--    created — the trigger itself already points at this function name
--    and fires once per INSERT, so this cannot create a second admin
--    notification or fire twice for the same report).
--
--    The reported-party notification deliberately:
--      - never names the reporter (avoids retaliation / exposing the
--        complainant, per the brief),
--      - never includes the free-text description,
--      - only fires when reported_user_id is actually set (account
--        appeals never set it, so they're naturally unaffected),
--      - is guarded by the same "does a notification already exist for
--        this (user, report) pair" check already used for admins, so a
--        retry/re-run can never double-notify the reported party either.
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
  v_reported_title text;
  v_reported_body text;
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

  -- ── Admins (unchanged from the original migration) ──────────────────────
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

  -- ── Reported party (NEW) — generic, reporter-anonymous, no free text ───
  IF NEW.reported_user_id IS NOT NULL THEN
    IF v_trip.origin IS NOT NULL THEN
      v_reported_title := 'A report was filed involving one of your trips';
      v_reported_body := format(
        'A report has been submitted regarding the trip %s -> %s, departing %s. Our support team will review it and may follow up with you.',
        v_trip.origin, v_trip.destination, to_char(v_trip.departure_time, 'DD Mon, HH24:MI')
      );
    ELSE
      v_reported_title := 'A report was filed involving you';
      v_reported_body := 'A report has been submitted involving you. Our support team will review it and may follow up with you.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = NEW.reported_user_id
        AND type = 'complaint_submitted'
        AND (data->>'report_id')::uuid = NEW.id
    ) THEN
      PERFORM public.notify(
        NEW.reported_user_id, 'complaint_submitted', v_reported_title, v_reported_body,
        jsonb_build_object('report_id', NEW.id, 'trip_id', NEW.trip_id)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Trigger trg_notify_admins_of_new_report already points at this function
-- name (created in trip_complaints_admin_alerts_cancellation_history.sql) —
-- no need to touch the trigger itself.


-- ----------------------------------------------------------------------------
-- 3. get_admin_reports(): one read-only, admin-only RPC that resolves
--    reporter/reported names+emails and trip context server-side, so the
--    admin UI no longer depends on a client-side embed silently returning
--    null. Also computes report_direction so Passenger→Driver and
--    Driver→Passenger reports are unambiguous at a glance.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_reports(p_status text DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  status text,
  category text,
  description text,
  created_at timestamptz,
  resolution_notes text,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_name text,
  reporter_id uuid,
  reporter_name text,
  reporter_email text,
  reported_user_id uuid,
  reported_name text,
  reported_email text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
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
    r.id, r.status, r.category, r.description, r.created_at,
    r.resolution_notes, r.resolved_at, r.resolved_by, rb.full_name AS resolved_by_name,
    r.reporter_id, rp.full_name AS reporter_name, rp.email AS reporter_email,
    r.reported_user_id, tu.full_name AS reported_name, tu.email AS reported_email,
    r.trip_id, t.origin, t.destination, t.departure_time,
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
  WHERE (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
  ORDER BY r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_reports(text) TO authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
