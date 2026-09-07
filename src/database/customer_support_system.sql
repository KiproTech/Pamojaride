-- ============================================================================
-- PamojaRide — Customer Support / Contact Support system
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- my_reports_tracking.sql and admin_reports_management.sql (the most
-- recent report-system migrations — this script does not touch either of
-- those, it only ADDS a brand-new, separate `support_requests` table plus
-- its own RLS policies, RPCs, triggers and notification types). Safe to
-- run multiple times: every statement is CREATE TABLE IF NOT EXISTS /
-- CREATE OR REPLACE / DROP POLICY IF EXISTS + CREATE / DROP TRIGGER IF
-- EXISTS + CREATE, or a constraint restated in full. No existing table is
-- dropped, truncated, or altered in a breaking way. No existing report,
-- booking, trip, or notification row is touched.
-- ============================================================================
--
-- SCOPE: this migration exists purely to power a general "Customer
-- Support / Help & Support" experience (account questions, booking help,
-- payment questions, technical issues, general "how do I..." questions).
--
-- It is DELIBERATELY SEPARATE from `public.reports`:
--   - `public.reports` stays the ONLY place a passenger/driver reports
--     misconduct, safety incidents, or a trip/booking dispute involving
--     another person. Nothing in this migration reads from, writes to, or
--     duplicates that table, its RLS, or its notification triggers.
--   - `public.support_requests` (new, this migration) is for a user
--     asking PamojaRide's own team for help — it never names a
--     "reported_user_id" and never feeds the existing Reports & Appeals
--     admin queue.
--   - The frontend Support page still gives a clear path INTO the
--     existing Report an Issue flow for safety/misconduct topics, exactly
--     as the brief asks — that is a UI link, not a new database
--     relationship between the two systems.
--
-- WHAT THIS ADDS:
--
--   1. support_requests — the ONE new table. Minimal columns only: no
--      separate "ticket messages" thread table, no separate assignment
--      table, no separate history table (unlike report_status_history,
--      a full audit trail wasn't asked for here — created_at/updated_at
--      plus the current status/admin_response already satisfy "date
--      submitted, current status, last updated").
--
--   2. public.user_owns_booking(p_user_id, p_booking_id) — a small new
--      SECURITY DEFINER helper, same style/purpose as the existing
--      public.user_is_involved_in_trip(p_user_id, p_trip_id) (see
--      trip_complaints_admin_alerts_cancellation_history.sql): true when
--      p_user_id is the passenger on that booking OR the driver of the
--      trip that booking belongs to. Used by the INSERT policy below so a
--      user can only ever attach a support request to a booking that is
--      actually theirs — never by trusting a booking_id the client sends.
--
--   3. get_my_support_bookings() — read-only RPC returning just enough
--      (booking id, trip id, reference, route, date, "my_role") for the
--      Contact Support form's "Related booking/trip" dropdown, scoped to
--      auth.uid() exactly like get_my_reports() already is. A user can
--      never see or select another user's booking here.
--
--   4. get_my_support_requests(p_request_id uuid DEFAULT NULL) — the
--      signed-in user's own support requests (list, or one request when
--      p_request_id is supplied), with trip/booking context resolved
--      server-side. Same "optional id, same scoping" pattern as
--      get_my_reports().
--
--   5. get_admin_support_requests(...) / get_admin_support_counts() —
--      admin-only listing + detail + real counts, mirroring
--      get_admin_reports() / get_admin_report_counts()
--      (admin_reports_management.sql) as closely as possible so the two
--      admin queues feel consistent.
--
--   6. Two small notification triggers (AFTER INSERT, AFTER UPDATE),
--      reusing the same PERFORM public.notify(...) helper every other
--      notification-producing trigger in this project already calls —
--      NOT a second notification system. Two new `notifications.type`
--      values are added to the existing check constraint for this:
--      'support_request_submitted' and 'support_update'.
--
-- SECURITY:
--   - RLS is enabled on support_requests with exactly three policies:
--     INSERT (own request only, ownership of any attached trip/booking
--     verified server-side, cannot pre-set status/admin_response/
--     assignment/resolution fields), SELECT (own request, or admin), and
--     UPDATE (admin only). No DELETE policy for anyone — RLS defaults to
--     deny, so a support request can never be deleted through the app.
--   - No RLS is disabled anywhere. No unrestricted SELECT policy is
--     added anywhere. No existing RLS policy on any other table is
--     modified.
--   - Every RPC is SECURITY DEFINER purely to resolve
--     profiles/trips/bookings context safely (the same reason every
--     other RPC in this project needs it — profiles' RLS only allows
--     reading your own row) and every one of them re-checks
--     auth.uid() / public.is_admin(auth.uid()) itself rather than
--     trusting the caller.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. support_requests
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  category text NOT NULL,
  subject text NOT NULL,
  message text NOT NULL,
  trip_id uuid,
  booking_id uuid,
  status text NOT NULL DEFAULT 'open',
  admin_response text,
  assigned_to uuid,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT support_requests_pkey PRIMARY KEY (id),
  CONSTRAINT support_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id),
  CONSTRAINT support_requests_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id),
  CONSTRAINT support_requests_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id),
  CONSTRAINT support_requests_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id),
  CONSTRAINT support_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id),
  CONSTRAINT support_requests_subject_not_blank CHECK (length(trim(subject)) > 0),
  CONSTRAINT support_requests_message_not_blank CHECK (length(trim(message)) > 0),
  CONSTRAINT support_requests_category_check CHECK (category = ANY (ARRAY[
    'booking_issue'::text, 'trip_issue'::text, 'payment_issue'::text,
    'account_issue'::text, 'safety_concern'::text, 'technical_issue'::text,
    'other'::text
  ])),
  CONSTRAINT support_requests_status_check CHECK (status = ANY (ARRAY[
    'open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text
  ]))
);

CREATE INDEX IF NOT EXISTS idx_support_requests_user_id ON public.support_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_support_requests_status ON public.support_requests (status);
CREATE INDEX IF NOT EXISTS idx_support_requests_created_at ON public.support_requests (created_at DESC);

-- Keep `updated_at` honest on every UPDATE. Unlike `reports` (which has no
-- such trigger and relies on callers to set it manually), this table gets
-- one from day one so "Last updated" in the UI is always trustworthy.
CREATE OR REPLACE FUNCTION public.touch_support_request_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_touch_support_request_updated_at ON public.support_requests;
CREATE TRIGGER trg_touch_support_request_updated_at
BEFORE UPDATE ON public.support_requests
FOR EACH ROW EXECUTE FUNCTION public.touch_support_request_updated_at();


-- ----------------------------------------------------------------------------
-- 2. public.user_owns_booking(): true when p_user_id is the passenger on
--    that booking, or the driver of the trip it belongs to. Mirrors
--    public.user_is_involved_in_trip() exactly.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_owns_booking(p_user_id uuid, p_booking_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    LEFT JOIN public.trips t ON t.id = b.trip_id
    WHERE b.id = p_booking_id
      AND (b.passenger_id = p_user_id OR t.driver_id = p_user_id)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.user_owns_booking(uuid, uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. RLS — own request to create/view, admin to view/manage all, nobody
--    can delete.
-- ----------------------------------------------------------------------------

ALTER TABLE public.support_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users can create own support requests" ON public.support_requests;
CREATE POLICY "users can create own support requests"
ON public.support_requests FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND coalesce(status, 'open') = 'open'
  AND admin_response IS NULL
  AND assigned_to IS NULL
  AND resolved_by IS NULL
  AND resolved_at IS NULL
  AND (trip_id IS NULL OR public.user_is_involved_in_trip(auth.uid(), trip_id))
  AND (booking_id IS NULL OR public.user_owns_booking(auth.uid(), booking_id))
);

DROP POLICY IF EXISTS "users can view own support requests" ON public.support_requests;
CREATE POLICY "users can view own support requests"
ON public.support_requests FOR SELECT
USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "admin can update support requests" ON public.support_requests;
CREATE POLICY "admin can update support requests"
ON public.support_requests FOR UPDATE
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- Intentionally no DELETE policy for anyone, including admins — RLS
-- defaults to deny, so a support request can never be deleted through the
-- app, same "kept for the record" design as `reports`.


-- ----------------------------------------------------------------------------
-- 4. get_my_support_bookings(): populates the Contact Support form's
--    "Related booking/trip" dropdown. Only ever returns bookings the
--    signed-in user is actually party to — as the passenger who booked,
--    or as the driver of that trip.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_support_bookings()
RETURNS TABLE (
  booking_id uuid,
  trip_id uuid,
  booking_reference text,
  origin text,
  destination text,
  departure_time timestamptz,
  my_role text
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
  SELECT b.id, b.trip_id, b.booking_reference, t.origin, t.destination, t.departure_time,
         'passenger'::text
  FROM public.bookings b
  JOIN public.trips t ON t.id = b.trip_id
  WHERE b.passenger_id = auth.uid()
  UNION ALL
  SELECT b.id, b.trip_id, b.booking_reference, t.origin, t.destination, t.departure_time,
         'driver'::text
  FROM public.bookings b
  JOIN public.trips t ON t.id = b.trip_id
  WHERE t.driver_id = auth.uid()
  ORDER BY departure_time DESC NULLS LAST;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_support_bookings() TO authenticated;


-- ----------------------------------------------------------------------------
-- 5. get_my_support_requests(): the reporter's own support requests, with
--    trip/booking context resolved server-side. Always scoped to
--    user_id = auth.uid() regardless of what id is passed in.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_support_requests(p_request_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  request_reference text,
  category text,
  subject text,
  message text,
  status text,
  admin_response text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  booking_id uuid,
  booking_reference text
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
    s.id,
    'SUP-' || upper(left(s.id::text, 8)) AS request_reference,
    s.category,
    s.subject,
    s.message,
    s.status,
    s.admin_response,
    s.created_at,
    s.updated_at,
    s.resolved_at,
    s.trip_id,
    t.origin,
    t.destination,
    t.departure_time,
    s.booking_id,
    b.booking_reference
  FROM public.support_requests s
  LEFT JOIN public.trips t    ON t.id = s.trip_id
  LEFT JOIN public.bookings b ON b.id = s.booking_id
  WHERE s.user_id = auth.uid()
    AND (p_request_id IS NULL OR s.id = p_request_id)
  ORDER BY s.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_support_requests(uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 6. Admin: get_admin_support_requests() / get_admin_support_counts() —
--    mirrors get_admin_reports() / get_admin_report_counts() as closely
--    as possible. Admin-only: raises for a non-admin caller.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_support_requests(
  p_status text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  request_reference text,
  category text,
  subject text,
  message text,
  status text,
  admin_response text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  user_id uuid,
  user_name text,
  user_email text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  booking_id uuid,
  booking_reference text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    'SUP-' || upper(left(s.id::text, 8)) AS request_reference,
    s.category,
    s.subject,
    s.message,
    s.status,
    s.admin_response,
    s.created_at,
    s.updated_at,
    s.resolved_at,
    s.user_id,
    p.full_name,
    p.email,
    s.trip_id,
    t.origin,
    t.destination,
    t.departure_time,
    s.booking_id,
    b.booking_reference
  FROM public.support_requests s
  LEFT JOIN public.profiles p ON p.id = s.user_id
  LEFT JOIN public.trips t    ON t.id = s.trip_id
  LEFT JOIN public.bookings b ON b.id = s.booking_id
  WHERE (p_request_id IS NULL OR s.id = p_request_id)
    AND (p_request_id IS NOT NULL OR p_status IS NULL OR p_status = 'all' OR s.status = p_status)
    AND (p_request_id IS NOT NULL OR p_category IS NULL OR p_category = 'all' OR s.category = p_category)
    AND (p_request_id IS NOT NULL OR p_date_from IS NULL OR s.created_at >= p_date_from)
    AND (p_request_id IS NOT NULL OR p_date_to IS NULL OR s.created_at < (p_date_to + 1))
    AND (
      p_request_id IS NOT NULL OR p_search IS NULL OR trim(p_search) = ''
      OR s.subject ILIKE '%' || p_search || '%'
      OR p.full_name ILIKE '%' || p_search || '%'
      OR ('SUP-' || upper(left(s.id::text, 8))) ILIKE '%' || upper(p_search) || '%'
      OR t.origin ILIKE '%' || p_search || '%'
      OR t.destination ILIKE '%' || p_search || '%'
      OR b.booking_reference ILIKE '%' || p_search || '%'
    )
  ORDER BY s.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_support_requests(text, text, text, date, date, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_support_counts()
RETURNS TABLE (
  open_count bigint,
  in_progress_count bigint,
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
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE status = 'open'),
    count(*) FILTER (WHERE status = 'in_progress'),
    count(*) FILTER (WHERE status = 'resolved'),
    count(*) FILTER (WHERE status = 'closed'),
    count(*)
  FROM public.support_requests;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_support_counts() TO authenticated;


-- ----------------------------------------------------------------------------
-- 7. Notifications — reuse the EXISTING public.notify(user_id, type,
--    title, body, data) helper already used by every other
--    notification-producing trigger in this project. Two new type values
--    only; the full canonical list is restated, same pattern every prior
--    migration touching this constraint has used. Nothing removed.
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
    'complaint_submitted'::text,
    'support_request_submitted'::text, 'support_update'::text
  ]));

-- 7a. AFTER INSERT: confirm receipt to the submitter, and let admins know
--     a new request is waiting — same "admins + submitter" shape as
--     notify_admins_of_new_report(), guarded with an existence check so a
--     manual re-run of this migration (or any future re-fire) can never
--     double-notify anyone for the same request.
CREATE OR REPLACE FUNCTION public.notify_new_support_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin RECORD;
  v_ref text;
BEGIN
  v_ref := 'SUP-' || upper(left(NEW.id::text, 8));

  -- Submitter confirmation.
  IF NOT EXISTS (
    SELECT 1 FROM public.notifications
    WHERE user_id = NEW.user_id
      AND type = 'support_request_submitted'
      AND (data->>'request_id')::uuid = NEW.id
  ) THEN
    PERFORM public.notify(
      NEW.user_id, 'support_request_submitted', 'Your support request was submitted',
      format('Reference %s. Our support team will get back to you soon.', v_ref),
      jsonb_build_object('request_id', NEW.id)
    );
  END IF;

  -- Admins.
  FOR v_admin IN SELECT id FROM public.profiles WHERE is_admin = true LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = v_admin.id
        AND type = 'support_request_submitted'
        AND (data->>'request_id')::uuid = NEW.id
    ) THEN
      PERFORM public.notify(
        v_admin.id, 'support_request_submitted', 'New support request submitted',
        format('%s (%s): %s', v_ref, NEW.category, NEW.subject),
        jsonb_build_object('request_id', NEW.id, 'category', NEW.category)
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_new_support_request ON public.support_requests;
CREATE TRIGGER trg_notify_new_support_request
AFTER INSERT ON public.support_requests
FOR EACH ROW EXECUTE FUNCTION public.notify_new_support_request();

-- 7b. AFTER UPDATE, only when something the user would actually care
--     about changed (status, or a new/edited admin response) — never on
--     an admin merely re-saving the same values. This is the "meaningful
--     Admin update" trigger the brief asks for.
CREATE OR REPLACE FUNCTION public.notify_support_request_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ref text;
  v_title text;
  v_body text;
  v_status_label text;
BEGIN
  v_ref := 'SUP-' || upper(left(NEW.id::text, 8));

  v_status_label := CASE NEW.status
    WHEN 'open' THEN 'reopened'
    WHEN 'in_progress' THEN 'in progress'
    WHEN 'resolved' THEN 'resolved'
    WHEN 'closed' THEN 'closed'
    ELSE NEW.status
  END;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    v_title := format('Your support request is now %s', v_status_label);
  ELSE
    v_title := 'Your support request has an update';
  END IF;

  v_body := format('Reference %s.', v_ref);
  IF NEW.admin_response IS NOT NULL AND length(trim(NEW.admin_response)) > 0 THEN
    v_body := v_body || format(' Response from our support team: %s', trim(NEW.admin_response));
  END IF;

  PERFORM public.notify(
    NEW.user_id, 'support_update', v_title, v_body,
    jsonb_build_object('request_id', NEW.id, 'status', NEW.status)
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_support_request_update ON public.support_requests;
CREATE TRIGGER trg_notify_support_request_update
AFTER UPDATE ON public.support_requests
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.admin_response IS DISTINCT FROM NEW.admin_response
)
EXECUTE FUNCTION public.notify_support_request_update();

-- ============================================================================
-- End of migration.
-- ============================================================================
