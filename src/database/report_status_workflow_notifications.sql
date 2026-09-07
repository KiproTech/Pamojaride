-- ============================================================================
-- PamojaRide — Report status workflow: reliable notifications
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- report_relationship_and_duplicate_hardening.sql (same `reports` table,
-- extends the same `notify_admins_of_new_report()` trigger function and
-- adds one new trigger). Safe to run multiple times: every statement is
-- CREATE OR REPLACE / DROP TRIGGER IF EXISTS + CREATE, a constraint
-- restated in full, or an index created IF NOT EXISTS. No table is
-- dropped or truncated. No existing report or notification row is
-- deleted or altered.
-- ============================================================================
--
-- SCOPE: this migration only touches the report status workflow and its
-- notifications. It does not add a second report system, does not rename
-- any existing status, and does not change any RLS policy on `reports` —
-- INSERT/SELECT/UPDATE stay exactly as defined in
-- trip_complaints_admin_alerts_cancellation_history.sql and
-- report_relationship_and_duplicate_hardening.sql.
--
-- ROOT CAUSE FOUND:
--
--   admin/Reports.jsx's updateStatus() already correctly moves a report
--   through open -> under_review -> resolved / closed with a plain
--   `.update()` on `reports` — but nothing in the database has ever
--   reacted to that UPDATE. There has never been a trigger on UPDATE for
--   this table (only the existing AFTER INSERT trigger,
--   trg_notify_admins_of_new_report, which notifies admins of a NEW
--   report and — since report_dispute_system_fix.sql — the reported
--   party). Result: when an admin actually confirms/resolves/closes a
--   report, neither the person who submitted it nor the person it was
--   about ever finds out. This is the gap the brief describes as
--   "both the relevant Passenger and Driver should receive notification".
--
--   A second, smaller gap: the person who SUBMITS a report never got any
--   confirmation that it was received (only admins and the reported party
--   did) — closed below in the same spirit as the existing trigger.
--
-- WHAT THIS ADDS:
--
--   1. Extends notify_admins_of_new_report() (same function name/trigger,
--      still one AFTER INSERT FOR EACH ROW trigger — cannot double-fire)
--      to also send the reporter themselves a "report received"
--      confirmation, reusing the existing 'complaint_submitted' type.
--
--   2. A new notify_report_status_change() function + trigger, firing
--      AFTER UPDATE ON reports, FOR EACH ROW, WHEN (OLD.status IS
--      DISTINCT FROM NEW.status). That WHEN clause is the primary
--      duplicate-prevention mechanism: opening a report, refreshing the
--      page, or an admin saving the SAME status again (e.g. double-click)
--      never fires this trigger a second time, because Postgres only
--      evaluates the trigger body when the status column's value actually
--      changed. Unlike the submission trigger, this function does NOT
--      also add a (user, type, report_id, status) existence-check guard
--      on top — the WHEN clause is already the correct and complete
--      duplicate guard here, and an extra status-keyed existence check
--      would incorrectly swallow a legitimate re-notification if a
--      report is ever reopened and moved through the same status twice.
--
--      On a real status change it notifies:
--        - the reporter — always, with the new status, the report
--          reference, trip context if any, and the admin's resolution
--          notes when present (this is precisely what that field is for:
--          giving the person who submitted the report a summary of the
--          outcome).
--        - the reported party (reported_user_id), when set and different
--          from the reporter — a neutral, reporter-anonymous notice of
--          the same status change, with trip context but WITHOUT the
--          admin's resolution notes (those may reference the reporter,
--          evidence, or internal reasoning; keeping them reporter-facing
--          only preserves the existing "don't tip off who reported you
--          or why" design already established for the submission-time
--          notification in report_dispute_system_fix.sql).
--        - account appeals (trip_id IS NULL, reported_user_id IS NULL)
--          only ever notify the appellant (the reporter) — there is no
--          second party.
--
--      Both notifications reuse the notifications type 'dispute_update',
--      which has been in the `notifications_type_check` constraint since
--      db.sql / account_status_enforcement.sql. NO CONSTRAINT CHANGE IS
--      NEEDED for this migration — see the "no SQL update needed for
--      types" note at the bottom of the accompanying summary.
--
-- SECURITY — nothing here changes:
--   - No RLS policy on `reports` or `notifications` is touched.
--   - Both functions are SECURITY DEFINER (same established pattern as
--     notify_admins_of_new_report, user_is_involved_in_trip, is_admin,
--     etc. elsewhere in this project) purely so they can read the
--     `profiles`/`trips` rows needed to compose a message and call
--     public.notify() — they do not grant the calling user any new
--     access, and users still cannot insert into `notifications`
--     directly or update a report's status themselves (still admin-only,
--     enforced by the existing "admin can update complaints" policy).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Extend notify_admins_of_new_report(): same trigger, same admin loop
--    and same reported-party notification as before (untouched, copied
--    verbatim from report_dispute_system_fix.sql), PLUS a new "report
--    received" confirmation to the reporter. Guarded the same way as the
--    other two loops in this function — an existence check keyed on
--    (user, type, report_id) — so it can never double-notify the reporter
--    even on a manual re-run.
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
  v_reporter_title text;
  v_reporter_body text;
  v_report_ref text;
BEGIN
  v_is_appeal := NEW.description LIKE '[Account appeal%';
  v_report_ref := 'RPT-' || upper(left(NEW.id::text, 8));

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

  -- ── Admins (unchanged) ───────────────────────────────────────────────
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

  -- ── Reported party (unchanged) — generic, reporter-anonymous, no free text ──
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

  -- ── Reporter (NEW) — a simple "we received it" confirmation ────────────
  IF v_is_appeal THEN
    v_reporter_title := 'Your appeal was submitted';
    v_reporter_body := format('Reference %s. Our support team will review your appeal and get back to you.', v_report_ref);
  ELSIF v_trip.origin IS NOT NULL THEN
    v_reporter_title := 'Your report was submitted';
    v_reporter_body := format(
      'Reference %s, regarding your trip %s -> %s. Our support team will review it shortly.',
      v_report_ref, v_trip.origin, v_trip.destination
    );
  ELSE
    v_reporter_title := 'Your report was submitted';
    v_reporter_body := format('Reference %s. Our support team will review it shortly.', v_report_ref);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.notifications
    WHERE user_id = NEW.reporter_id
      AND type = 'complaint_submitted'
      AND (data->>'report_id')::uuid = NEW.id
      AND (data->>'role')::text = 'reporter'
  ) THEN
    PERFORM public.notify(
      NEW.reporter_id, 'complaint_submitted', v_reporter_title, v_reporter_body,
      jsonb_build_object('report_id', NEW.id, 'trip_id', NEW.trip_id, 'role', 'reporter')
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- Trigger trg_notify_admins_of_new_report already points at this function
-- name (created in trip_complaints_admin_alerts_cancellation_history.sql) —
-- no need to touch the trigger itself.


-- ----------------------------------------------------------------------------
-- 2. notify_report_status_change(): fires only when `status` actually
--    changes. Notifies the reporter (always) and the reported party
--    (when set and involved), covering Admin: Confirm / Under Review /
--    Resolved / Closed transitions in one place, reusing the 'dispute_update'
--    type already valid in notifications_type_check.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_report_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_report_ref text;
  v_status_label text;
  v_trip_context text := '';
  v_reporter_title text;
  v_reporter_body text;
  v_reported_title text;
  v_reported_body text;
  v_is_appeal boolean;
BEGIN
  v_is_appeal := NEW.description LIKE '[Account appeal%';
  v_report_ref := 'RPT-' || upper(left(NEW.id::text, 8));

  v_status_label := CASE NEW.status
    WHEN 'open' THEN 'reopened'
    WHEN 'under_review' THEN 'under review'
    WHEN 'resolved' THEN 'resolved'
    WHEN 'closed' THEN 'closed'
    ELSE NEW.status
  END;

  IF NEW.trip_id IS NOT NULL THEN
    SELECT origin, destination, departure_time INTO v_trip
      FROM public.trips WHERE id = NEW.trip_id;
    IF v_trip.origin IS NOT NULL THEN
      v_trip_context := format(' (trip %s -> %s, departing %s)',
        v_trip.origin, v_trip.destination, to_char(v_trip.departure_time, 'DD Mon, HH24:MI'));
    END IF;
  END IF;

  -- ── Reporter: always notified, gets the admin's resolution summary
  --    when one is present — this field exists precisely to give the
  --    person who filed the report a clear outcome. ─────────────────────
  v_reporter_title := CASE
    WHEN v_is_appeal THEN format('Your appeal is now %s', v_status_label)
    ELSE format('Your report is now %s', v_status_label)
  END;

  v_reporter_body := format('Reference %s%s.', v_report_ref, v_trip_context);
  IF NEW.resolution_notes IS NOT NULL AND length(trim(NEW.resolution_notes)) > 0 THEN
    v_reporter_body := v_reporter_body || format(' Update from our support team: %s', trim(NEW.resolution_notes));
  END IF;

  -- No extra existence-check guard here (unlike the submission trigger
  -- above): the WHEN clause on trg_notify_report_status_change already
  -- guarantees this function body only ever runs when OLD.status IS
  -- DISTINCT FROM NEW.status for THIS UPDATE statement, so it cannot
  -- fire twice for the same transition. Adding a (user, type, report_id,
  -- status) existence check on top would actually be wrong here: a
  -- report can legitimately revisit the same status more than once
  -- (e.g. resolved -> reopened for under_review -> resolved again), and
  -- each of those is a real, distinct event that should notify again.
  PERFORM public.notify(
    NEW.reporter_id, 'dispute_update', v_reporter_title, v_reporter_body,
    jsonb_build_object('report_id', NEW.id, 'trip_id', NEW.trip_id, 'status', NEW.status, 'role', 'reporter')
  );

  -- ── Reported party: notified when involved, kept neutral and
  --    reporter-anonymous — no resolution notes, no reporter identity. ──
  IF NEW.reported_user_id IS NOT NULL AND NEW.reported_user_id <> NEW.reporter_id THEN
    v_reported_title := format('A report involving you is now %s', v_status_label);
    v_reported_body := CASE NEW.status
      WHEN 'resolved' THEN format('Reference %s%s. Our support team has completed its review.', v_report_ref, v_trip_context)
      WHEN 'closed' THEN format('Reference %s%s. Our support team has closed this report.', v_report_ref, v_trip_context)
      ELSE format('Reference %s%s. Our support team is reviewing this report.', v_report_ref, v_trip_context)
    END;

    PERFORM public.notify(
      NEW.reported_user_id, 'dispute_update', v_reported_title, v_reported_body,
      jsonb_build_object('report_id', NEW.id, 'trip_id', NEW.trip_id, 'status', NEW.status, 'role', 'reported')
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_report_status_change ON public.reports;
CREATE TRIGGER trg_notify_report_status_change
AFTER UPDATE ON public.reports
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.notify_report_status_change();

-- ============================================================================
-- No `notifications_type_check` change is required by this migration.
-- 'complaint_submitted' and 'dispute_update' were already valid values
-- (added by trip_complaints_admin_alerts_cancellation_history.sql and
-- db.sql / account_status_enforcement.sql respectively) — both are reused
-- as-is, so the existing valid-type list is left completely untouched.
-- ============================================================================
-- End of migration.
-- ============================================================================
