-- ============================================================================
-- PamojaRide — My Reports / Report History & Tracking (Passenger + Driver)
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- report_status_workflow_notifications.sql (same `reports` table; this
-- migration only ADDS a new history table and two new read-only RPCs — it
-- does not touch any existing table, column, trigger, function, or RLS
-- policy on `reports` or `notifications`). Safe to run multiple times:
-- every statement is CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE /
-- DROP POLICY IF EXISTS + CREATE / DROP TRIGGER IF EXISTS + CREATE. No
-- table is dropped or truncated. No existing report row is deleted or
-- altered.
-- ============================================================================
--
-- SCOPE: this migration exists purely so a Passenger or Driver can track
-- reports THEY submitted. It does not create a second reports system —
-- everything here reads from / is driven by the existing `public.reports`
-- table, which remains the single source of truth. It does not change who
-- can submit a report, how admins review reports, or any existing
-- notification.
--
-- WHAT THIS ADDS:
--
--   1. report_status_history — the ONLY new table. `reports` itself only
--      ever stores the CURRENT status; there was no record anywhere of
--      the transitions a report went through (open -> under_review ->
--      resolved, etc), so a real timeline couldn't be shown without
--      inventing data. This table stores exactly the real transitions,
--      going forward, the moment they happen — nothing is backfilled or
--      guessed for reports that already existed before this migration
--      (those simply show "Submitted" + their current status in the UI,
--      which is the truthful thing to show given what the database
--      actually recorded).
--
--   2. trg_log_report_status_change — a new AFTER UPDATE trigger on
--      `reports`, firing only WHEN (OLD.status IS DISTINCT FROM
--      NEW.status), that writes one row per real transition into
--      report_status_history. This is a SEPARATE trigger from the
--      existing trg_notify_report_status_change (added by
--      report_status_workflow_notifications.sql) — both are allowed to
--      fire on the same UPDATE (Postgres supports multiple triggers per
--      event; they simply run in trigger-name order), and neither
--      function touches what the other does, so nothing about the
--      existing notification behaviour changes.
--
--   3. get_my_reports(p_report_id uuid DEFAULT NULL) — one read-only,
--      SECURITY DEFINER RPC (same established style as
--      get_admin_reports() / get_driver_trip_bookings() /
--      get_booked_trip_driver_details() elsewhere in this project) that:
--        - always scopes to `reporter_id = auth.uid()` — a user can only
--          ever get their OWN reports back, never anyone else's, no
--          matter what id is passed in;
--        - resolves trip/booking context and the OTHER party's name
--          server-side (the same reason get_admin_reports() exists: a
--          client-side embed on `profiles` silently returns null because
--          profiles' RLS only allows reading your own row);
--        - only exposes the counterpart's full_name — never their email,
--          phone, or any other profile column. This is strictly LESS
--          than what a driver/passenger already sees about each other
--          elsewhere in this app for the very same trip (full name AND
--          phone, via get_driver_trip_bookings() and
--          get_booked_trip_driver_details());
--        - never exposes admin-only internals: no assigned_to, no
--          resolved_by id/name. `resolution_notes` IS included — that
--          field exists specifically to give the reporter a summary of
--          the outcome, and the existing notify_report_status_change()
--          trigger already sends that same text to the reporter directly;
--        - is used for BOTH the report list (p_report_id NULL) and a
--          single report's detail view (p_report_id set) — the same
--          "optional id, same scoping" pattern get_driver_trip_bookings()
--          already uses for p_trip_id. Requesting a report_id that isn't
--          yours simply returns zero rows — this is what makes "guessing
--          another user's report id in the URL" safe: there is nothing to
--          leak, RLS-independent, at the RPC layer itself.
--
--   4. get_my_report_status_history(p_report_id uuid) — one read-only,
--      SECURITY DEFINER RPC returning the real transitions recorded by
--      report_status_history for one report, authorized against
--      `reports.reporter_id = auth.uid() OR public.is_admin(auth.uid())`
--      (admins can reuse it too, though admin/Reports.jsx doesn't need to
--      today — this task doesn't touch that page).
--
-- SECURITY — nothing pre-existing changes:
--   - RLS on `reports` is untouched: INSERT/SELECT/UPDATE stay exactly as
--     defined in trip_complaints_admin_alerts_cancellation_history.sql,
--     report_dispute_system_fix.sql and
--     report_relationship_and_duplicate_hardening.sql. Reporters could
--     already SELECT their own reports directly — these RPCs exist to
--     resolve names/trip context safely, not to grant new table access.
--   - report_status_history gets RLS enabled with a single SELECT policy
--     (own report's history, or admin) and NO insert/update/delete
--     policy for anyone — the only way a row is ever created is the
--     trigger above, which (like every other trigger function in this
--     project, e.g. notify_admins_of_new_report) runs as the function's
--     definer and is not blocked by RLS on this new table.
--   - Both RPCs re-check authorization themselves (auth.uid() /
--     is_admin()) rather than trusting the caller, exactly like every
--     other SECURITY DEFINER function already in this codebase.
--   - No RLS is disabled anywhere. No unrestricted SELECT policy is
--     added anywhere.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. report_status_history — minimal, append-only log of REAL status
--    transitions. No column here is guessed or backfilled.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.report_status_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  old_status text,
  new_status text NOT NULL,
  note text,
  changed_by uuid,
  changed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT report_status_history_pkey PRIMARY KEY (id),
  CONSTRAINT report_status_history_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE CASCADE,
  CONSTRAINT report_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_report_status_history_report_id ON public.report_status_history (report_id);

ALTER TABLE public.report_status_history ENABLE ROW LEVEL SECURITY;

-- SELECT only: the report's own reporter, or an admin. No INSERT/UPDATE/
-- DELETE policy exists for anyone — RLS defaults to deny, so the only way
-- a row is ever created is the trigger below (SECURITY DEFINER, not
-- subject to this table's RLS, same established pattern as public.notify()
-- writing into `notifications`).
DROP POLICY IF EXISTS "reporter or admin can view report history" ON public.report_status_history;
CREATE POLICY "reporter or admin can view report history"
ON public.report_status_history FOR SELECT
USING (
  public.is_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.reports r
    WHERE r.id = report_status_history.report_id
      AND r.reporter_id = auth.uid()
  )
);


-- ----------------------------------------------------------------------------
-- 2. Trigger: log every REAL status transition. Fires only when the
--    status actually changes (same WHEN-clause guarantee already used by
--    trg_notify_report_status_change), so opening a report, refreshing
--    the page, or an admin re-saving the same status never adds a
--    duplicate row.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_report_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.report_status_history (report_id, old_status, new_status, note, changed_by, changed_at)
  VALUES (NEW.id, OLD.status, NEW.status, NEW.resolution_notes, auth.uid(), now());
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_report_status_change ON public.reports;
CREATE TRIGGER trg_log_report_status_change
AFTER UPDATE ON public.reports
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.log_report_status_change();


-- ----------------------------------------------------------------------------
-- 3. get_my_reports(): the reporter's own reports (list, or one report
--    when p_report_id is supplied), with trip/booking context and the
--    counterpart's name resolved server-side. Always scoped to
--    reporter_id = auth.uid() regardless of what id is passed in.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_reports(p_report_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  report_reference text,
  category text,
  description text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  resolution_notes text,
  is_account_appeal boolean,
  my_role text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  pickup_point text,
  dropoff_point text,
  booking_id uuid,
  booking_reference text,
  seats_booked integer,
  reported_user_id uuid,
  reported_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    'RPT-' || upper(left(r.id::text, 8)) AS report_reference,
    r.category,
    r.description,
    r.status,
    r.created_at,
    r.updated_at,
    r.resolved_at,
    r.resolution_notes,
    (r.description LIKE '[Account appeal%') AS is_account_appeal,
    CASE
      WHEN r.description LIKE '[Account appeal%' THEN 'appeal'
      WHEN t.driver_id IS NOT NULL AND t.driver_id = r.reporter_id THEN 'driver'
      WHEN r.trip_id IS NOT NULL THEN 'passenger'
      ELSE 'other'
    END AS my_role,
    r.trip_id,
    t.origin,
    t.destination,
    t.departure_time,
    t.pickup_point,
    t.dropoff_point,
    r.booking_id,
    b.booking_reference,
    b.seats_booked,
    r.reported_user_id,
    rp.full_name AS reported_name
  FROM public.reports r
  LEFT JOIN public.trips t     ON t.id = r.trip_id
  LEFT JOIN public.bookings b  ON b.id = r.booking_id
  LEFT JOIN public.profiles rp ON rp.id = r.reported_user_id
  WHERE r.reporter_id = auth.uid()
    AND (p_report_id IS NULL OR r.id = p_report_id)
  ORDER BY r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_reports(uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_my_report_status_history(): the real, recorded transitions for
--    one report — reporter (of that specific report) or admin only.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_report_status_history(p_report_id uuid)
RETURNS TABLE (
  old_status text,
  new_status text,
  note text,
  changed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reports r
    WHERE r.id = p_report_id
      AND (r.reporter_id = auth.uid() OR public.is_admin(auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Not authorized to view this report';
  END IF;

  RETURN QUERY
  SELECT h.old_status, h.new_status, h.note, h.changed_at
  FROM public.report_status_history h
  WHERE h.report_id = p_report_id
  ORDER BY h.changed_at ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_report_status_history(uuid) TO authenticated;

-- ============================================================================
-- End of migration.
-- ============================================================================
