-- ============================================================================
-- PamojaRide — Trip lifecycle hardening: cancellation-after-start,
-- full-identity reviews, 30/10-minute departure reminders, and
-- completion-dispute admin visibility.
--
-- Run this whole script once in the Supabase SQL Editor, AFTER every other
-- file in src/database (specifically: driver_passenger_booking_cancellation.sql,
-- driver_reviews_display.sql, notifications_fix.sql,
-- trip_completion_individual_confirmations.sql, and
-- report_relationship_and_duplicate_hardening.sql). Purely additive /
-- CREATE OR REPLACE — no table is dropped, no row is deleted. Safe to
-- re-run.
-- ============================================================================
--
-- WHAT THIS FIXES AND WHY (root causes, not new parallel systems):
--
--   1. PASSENGER CANCELLATION AFTER TRIP START
--      cancel_booking() (driver_passenger_booking_cancellation.sql) only
--      ever blocked cancellation once the TRIP itself had been marked
--      'completed' — it never checked departure_time, so a passenger could
--      still cancel a 'confirmed' booking minutes, hours, or days after the
--      trip had actually started (as long as the driver hadn't yet pressed
--      "Mark completed"). This migration adds the departure_time check for
--      the passenger's own self-cancellation path specifically (the
--      driver/admin paths already have their own separate rules, untouched
--      here). MyBookings.jsx is updated alongside this (frontend) to hide
--      the Cancel button once departure_time has passed, but the real
--      enforcement is here, in the RPC, so it can't be bypassed by calling
--      supabase.rpc('cancel_booking', …) directly.
--
--   2. FULL NAME + PROFILE PICTURE ON REVIEWS
--      get_driver_reviews() (driver_reviews_display.sql) was deliberately
--      built to anonymize the reviewer ("Jane M.") and never returned a
--      picture. Requirement now explicitly asks for the reviewer's full
--      name and profile picture on every review, matching how the rest of
--      the app already displays identity (get_driver_trip_bookings,
--      get_trip_passenger_completions, etc. all return full_name +
--      profile_picture once two people share a trip). This migration
--      widens the column list to match — no RLS change needed, since this
--      was already a SECURITY DEFINER function hand-picking its own column
--      list, never a direct table grant.
--
--   3. TRIP-START REMINDERS (30 & 10 minutes before departure)
--      There was no mechanism anywhere in the project that ever produced a
--      'trip_reminder' notification, even though the type has existed in
--      notifications_type_check since db.sql. This migration adds
--      send_trip_departure_reminders(), scheduled every minute via
--      pg_cron — same proven pattern as auto_start_departed_trips()
--      (notifications_fix.sql) and auto_complete_pending_trips()
--      (trip_auto_completion.sql) — so it fires reliably server-side
--      whether or not anyone has the app open. Two new boolean columns on
--      trips (reminder_30_sent / reminder_10_sent) are the de-duplication
--      guard: each reminder is flipped to sent exactly once per trip, so a
--      wide cron window or an overlapping run can never double-notify.
--      Both the driver and every CONFIRMED passenger on the trip receive
--      it.
--
--   4/5. COMPLETION DISPUTE -> ADMIN REVIEW
--      respond_trip_completion() (trip_completion_individual_confirmations.sql)
--      already does everything the brief asks for the ACCEPT path, and
--      already keeps every passenger's confirmation fully independent (see
--      that file's own comments). The one gap on the DECLINE path: the
--      driver was notified, but nothing was ever surfaced to admins for
--      review, and there was no persisted "case" an admin could open,
--      investigate, and resolve — only a notification. This migration
--      closes that gap the same way every other dispute in this project
--      already works: it inserts one row into the EXISTING public.reports
--      table (category 'other', reporter = the declining passenger,
--      reported_user_id = the driver). That single insert is all that's
--      needed — report_dispute_system_fix.sql's own
--      trg_notify_admins_of_new_report trigger already fires on INSERT
--      and (a) notifies every admin, (b) notifies the driver with a
--      generic, reporter-anonymous message ("a report has been submitted
--      regarding this trip…", no decline reason/comment exposed), and (c)
--      confirms receipt to the passenger — with zero new notification
--      logic added here. The report itself (with the passenger's actual
--      decline_reason/decline_comment in its description) is preserved for
--      admin review exactly like any other complaint, visible in
--      Admin > Reports and the passenger's own My Reports page
--      (get_my_reports()), nothing new to build there either. A duplicate
--      report can never be created for the same decline, since
--      respond_trip_completion() already rejects answering the same
--      trip's completion request twice (v_confirmation.response <>
--      'pending' check).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Passenger cancellation blocked once the trip has started.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_booking(
  p_booking_id uuid,
  p_reason text DEFAULT NULL::text,
  p_reason_category text DEFAULT NULL::text
)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_caller_is_admin boolean;
  v_final_reason text;
  v_final_category text;
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_booking.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  v_caller_is_admin := public.is_admin(v_caller);

  -- A driver may only ever touch bookings on trips they own; a passenger
  -- may only ever touch their own booking; an admin may touch any booking.
  IF NOT (
    v_booking.passenger_id = v_caller
    OR v_trip.driver_id = v_caller
    OR v_caller_is_admin
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel this booking';
  END IF;

  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Booking is already % and cannot be cancelled', v_booking.status;
  END IF;

  -- A driver (or an admin acting on a driver's behalf) can no longer cancel
  -- a passenger's booking once the trip itself has been marked completed.
  IF v_caller <> v_booking.passenger_id AND v_trip.status = 'completed' THEN
    RAISE EXCEPTION 'This trip has already been completed and its bookings can no longer be cancelled';
  END IF;

  -- ── NEW: a PASSENGER can no longer cancel their own booking once the
  --    trip's departure time has been reached, regardless of whether the
  --    driver has flipped the trip's status yet. This is the actual rule
  --    requested — "the trip has started" is defined by departure_time,
  --    not by trip.status, since status transitions (scheduled -> ongoing)
  --    only happen once a minute via auto_start_departed_trips() and
  --    should never be what gates this. An admin force-cancelling on a
  --    passenger's behalf is intentionally NOT subject to this rule (an
  --    admin may still need to unwind a booking after departure for a
  --    genuine dispute) — only the passenger's own self-service path is
  --    restricted, exactly as requested.
  IF v_caller = v_booking.passenger_id AND v_trip.departure_time <= now() THEN
    RAISE EXCEPTION 'This trip has already started and the booking can no longer be cancelled';
  END IF;

  IF v_caller = v_booking.passenger_id THEN
    -- Passenger self-cancellation: unchanged legacy behaviour.
    v_final_reason := coalesce(nullif(trim(p_reason), ''), 'Cancelled by passenger');
    v_final_category := NULL;
  ELSIF v_trip.driver_id = v_caller THEN
    -- ── Driver cancelling one of their passengers ──────────────────────
    IF p_reason_category IS NULL OR NOT (p_reason_category = ANY (ARRAY[
      'passenger_requested', 'could_not_reach', 'info_incorrect',
      'safety_concern', 'capacity_issue', 'other'
    ])) THEN
      RAISE EXCEPTION 'A valid cancellation reason is required';
    END IF;

    IF p_reason_category = 'other' THEN
      IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'Please explain the reason for cancelling';
      END IF;
      v_final_reason := trim(p_reason);
    ELSE
      v_final_reason := CASE p_reason_category
        WHEN 'passenger_requested' THEN 'Passenger requested cancellation'
        WHEN 'could_not_reach' THEN 'Passenger could not be reached'
        WHEN 'info_incorrect' THEN 'Booking information is incorrect'
        WHEN 'safety_concern' THEN 'Safety or trip-related concern'
        WHEN 'capacity_issue' THEN 'Vehicle/trip capacity issue'
      END;
    END IF;
    v_final_category := p_reason_category;
  ELSE
    -- Admin force-cancelling on someone's behalf: free-text reason, mandatory.
    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
      RAISE EXCEPTION 'A cancellation reason is required';
    END IF;
    v_final_reason := trim(p_reason);
    v_final_category := 'admin_override';
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.bookings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_caller,
        cancellation_reason = v_final_reason,
        cancellation_reason_category = v_final_category,
        refund_status = CASE
          WHEN v_caller <> v_booking.passenger_id AND v_booking.total_price > 0 THEN 'pending'
          ELSE v_booking.refund_status
        END
    WHERE id = p_booking_id
    RETURNING * INTO v_booking;

  UPDATE public.trips SET available_seats = available_seats + v_booking.seats_booked WHERE id = v_trip.id;

  PERFORM public.notify(
    CASE WHEN v_caller = v_booking.passenger_id THEN v_trip.driver_id ELSE v_booking.passenger_id END,
    'booking_cancelled',
    CASE WHEN v_caller = v_booking.passenger_id THEN 'Booking cancelled' ELSE 'Your booking was cancelled' END,
    CASE WHEN v_caller = v_booking.passenger_id
      THEN format('Booking %s was cancelled', v_booking.booking_reference)
      ELSE format('Your booking %s for %s -> %s on %s was cancelled by the driver. Reason: %s',
             v_booking.booking_reference, v_trip.origin, v_trip.destination,
             to_char(v_trip.departure_time, 'DD Mon, HH24:MI'), v_final_reason)
    END,
    jsonb_build_object(
      'trip_id', v_trip.id, 'booking_id', v_booking.id,
      'cancellation_reason', v_final_reason,
      'cancellation_reason_category', v_final_category
    )
  );

  RETURN v_booking;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cancel_booking(uuid, text, text) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. get_driver_reviews(): now returns the reviewer's real full name and
--    profile picture instead of an anonymized display name. Dropped first
--    because the return shape changes (reviewer_display_name replaced by
--    reviewer_full_name + reviewer_profile_picture) — Postgres won't let
--    CREATE OR REPLACE change a function's column list.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_driver_reviews(uuid, integer, integer);

CREATE FUNCTION public.get_driver_reviews(
  p_driver_id uuid,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  id uuid,
  rating integer,
  comment text,
  created_at timestamptz,
  reviewer_id uuid,
  reviewer_full_name text,
  reviewer_profile_picture text,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    r.id,
    r.rating,
    r.comment,
    r.created_at,
    p.id,
    coalesce(nullif(btrim(p.full_name), ''), 'Passenger') AS reviewer_full_name,
    p.profile_picture AS reviewer_profile_picture,
    count(*) OVER() AS total_count
  FROM public.ratings r
  LEFT JOIN public.profiles p ON p.id = r.rater_id
  WHERE r.ratee_id = p_driver_id
    AND r.rating_type = 'passenger_to_driver'
    AND r.removed_at IS NULL
  ORDER BY r.created_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 10), 1), 50)
  OFFSET GREATEST(coalesce(p_offset, 0), 0);
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_reviews(uuid, integer, integer) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. Trip-start reminders — 30 minutes and 10 minutes before departure,
--    to the driver and every confirmed passenger, exactly once each.
-- ----------------------------------------------------------------------------

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS reminder_30_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_10_sent boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.send_trip_departure_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_passenger RECORD;
  v_processed integer := 0;
BEGIN
  -- 30-minute reminder: trips departing in the next (29,30] minute window
  -- that haven't already been sent one. Only 'scheduled' trips qualify —
  -- a trip that's cancelled, already ongoing (shouldn't happen this early,
  -- but defensive), or otherwise not on track no longer needs a reminder.
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'scheduled'
      AND reminder_30_sent = false
      AND departure_time <= now() + interval '30 minutes'
      AND departure_time >  now() + interval '29 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);
    UPDATE public.trips SET reminder_30_sent = true WHERE id = v_trip.id;

    PERFORM public.notify(
      v_trip.driver_id, 'trip_reminder', 'Trip starting in 30 minutes',
      format('Your trip from %s to %s starts in 30 minutes.', v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id, 'minutes_before', 30)
    );

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = v_trip.id AND status = 'confirmed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_reminder', 'Trip starting in 30 minutes',
        format('Your trip from %s to %s starts in 30 minutes.', v_trip.origin, v_trip.destination),
        jsonb_build_object('trip_id', v_trip.id, 'minutes_before', 30)
      );
    END LOOP;

    v_processed := v_processed + 1;
  END LOOP;

  -- 10-minute reminder: same shape, tighter window, separate guard column
  -- so a trip always gets exactly one of each reminder, never zero and
  -- never a repeat if the cron job overlaps itself.
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'scheduled'
      AND reminder_10_sent = false
      AND departure_time <= now() + interval '10 minutes'
      AND departure_time >  now() + interval '9 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);
    UPDATE public.trips SET reminder_10_sent = true WHERE id = v_trip.id;

    PERFORM public.notify(
      v_trip.driver_id, 'trip_reminder', 'Trip starting in 10 minutes',
      format('Your trip is starting in 10 minutes. Please prepare to depart from %s.', v_trip.origin),
      jsonb_build_object('trip_id', v_trip.id, 'minutes_before', 10)
    );

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = v_trip.id AND status = 'confirmed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_reminder', 'Trip starting in 10 minutes',
        'Your trip is starting in 10 minutes. Please prepare to depart.',
        jsonb_build_object('trip_id', v_trip.id, 'minutes_before', 10)
      );
    END LOOP;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN v_processed;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.send_trip_departure_reminders() TO authenticated;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pamojaride-trip-departure-reminders';

SELECT cron.schedule(
  'pamojaride-trip-departure-reminders',
  '* * * * *',
  $$ SELECT public.send_trip_departure_reminders(); $$
);


-- ----------------------------------------------------------------------------
-- 4/5. respond_trip_completion(): on DECLINE, also open an admin-reviewable
--    report (existing public.reports table + its existing admin-notify
--    trigger) — everything else in this function (independent per-passenger
--    state, accept path, driver notifications) is unchanged, copied
--    verbatim from trip_completion_individual_confirmations.sql.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.respond_trip_completion(
  p_trip_id uuid,
  p_response text,
  p_decline_reason text DEFAULT NULL,
  p_decline_comment text DEFAULT NULL
) RETURNS public.trip_completion_confirmations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_trip public.trips%ROWTYPE;
  v_confirmation public.trip_completion_confirmations%ROWTYPE;
  v_passenger_name text;
  v_remaining_pending integer;
  v_reason_label text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Must be authenticated to respond to a trip completion request';
  END IF;
  IF p_response NOT IN ('accepted', 'declined') THEN
    RAISE EXCEPTION 'Invalid response';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF v_trip.status <> 'completion_pending' THEN
    RAISE EXCEPTION 'This trip is not awaiting completion confirmation (status: %)', v_trip.status;
  END IF;

  SELECT * INTO v_confirmation
  FROM public.trip_completion_confirmations
  WHERE trip_id = p_trip_id AND passenger_id = v_caller
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'You do not have a pending completion confirmation for this trip';
  END IF;
  IF v_confirmation.response <> 'pending' THEN
    RAISE EXCEPTION 'You have already responded to this trip''s completion request';
  END IF;

  IF p_response = 'declined' THEN
    IF p_decline_reason IS NULL OR btrim(p_decline_reason) = '' THEN
      RAISE EXCEPTION 'A reason is required to decline a trip completion confirmation';
    END IF;
    IF p_decline_reason = 'other' AND (p_decline_comment IS NULL OR btrim(p_decline_comment) = '') THEN
      RAISE EXCEPTION 'Please add a short comment when selecting "Other"';
    END IF;
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.trip_completion_confirmations
    SET response = p_response,
        responded_at = now(),
        confirmed_at = now(),
        decline_reason = CASE WHEN p_response = 'declined' THEN p_decline_reason ELSE NULL END,
        decline_comment = CASE WHEN p_response = 'declined' THEN nullif(btrim(p_decline_comment), '') ELSE NULL END
    WHERE id = v_confirmation.id
    RETURNING * INTO v_confirmation;

  IF p_response = 'accepted' THEN
    UPDATE public.bookings SET status = 'completed' WHERE id = v_confirmation.booking_id AND status = 'confirmed';
  ELSE
    UPDATE public.bookings SET status = 'no_show' WHERE id = v_confirmation.booking_id AND status = 'confirmed';
  END IF;

  SELECT full_name INTO v_passenger_name FROM public.profiles WHERE id = v_caller;

  IF p_response = 'accepted' THEN
    PERFORM public.notify(
      v_trip.driver_id, 'trip_completion_confirmed_by_passenger', 'Passenger confirmed trip completion',
      format('%s has confirmed that they completed the trip %s -> %s.',
        coalesce(v_passenger_name, 'A passenger'), v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_confirmation.booking_id, 'passenger_id', v_caller)
    );
  ELSE
    PERFORM public.notify(
      v_trip.driver_id, 'trip_completion_declined_by_passenger', 'Passenger declined trip completion',
      format('%s declined to confirm completion of the trip %s -> %s. Reason: %s.',
        coalesce(v_passenger_name, 'A passenger'), v_trip.origin, v_trip.destination, p_decline_reason),
      jsonb_build_object(
        'trip_id', v_trip.id, 'booking_id', v_confirmation.booking_id, 'passenger_id', v_caller,
        'decline_reason', p_decline_reason, 'decline_comment', p_decline_comment
      )
    );

    -- ── NEW: open an admin-reviewable report for this dispute. Uses the
    --    existing public.reports table and its existing
    --    trg_notify_admins_of_new_report trigger (report_dispute_system_fix.sql
    --    / report_status_workflow_notifications.sql) to notify admins + the
    --    driver (generic, reporter-anonymous wording, no decline reason/
    --    comment exposed to the driver) + confirm receipt to the
    --    passenger — no new notification code needed. Category 'no_show'
    --    fits this best of the existing fixed categories (a disputed
    --    "did this trip actually happen for me" claim); the passenger's
    --    actual reason/comment goes in the description for the admin to
    --    read. Can only ever be created once per decline, since a
    --    passenger can only decline a given trip's completion request one
    --    time (the "already responded" check above).
    v_reason_label := CASE p_decline_reason
      WHEN 'did_not_board' THEN 'I did not board this trip'
      WHEN 'trip_cancelled' THEN 'The trip was cancelled'
      WHEN 'did_not_complete' THEN 'I did not complete the journey'
      WHEN 'marked_incorrectly' THEN 'Driver marked the trip incorrectly'
      ELSE 'Other'
    END;

    INSERT INTO public.reports (
      reporter_id, reported_user_id, trip_id, booking_id, category, description, status
    ) VALUES (
      v_caller, v_trip.driver_id, v_trip.id, v_confirmation.booking_id, 'no_show',
      format(
        'Passenger disputed trip completion. Reason: %s.%s',
        v_reason_label,
        CASE WHEN p_decline_comment IS NOT NULL AND btrim(p_decline_comment) <> ''
          THEN ' Details: ' || btrim(p_decline_comment) ELSE '' END
      ),
      'open'
    );
  END IF;

  SELECT count(*) INTO v_remaining_pending
  FROM public.trip_completion_confirmations
  WHERE trip_id = p_trip_id AND response = 'pending';

  IF v_remaining_pending = 0 THEN
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id AND status = 'completion_pending';
    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;
  END IF;

  RETURN v_confirmation;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.respond_trip_completion(uuid, text, text, text) TO authenticated;

-- ============================================================================
-- End of migration.
--
-- To verify the new cron job registered alongside the existing ones:
--   SELECT jobid, jobname, schedule, active FROM cron.job
--   WHERE jobname IN (
--     'pamojaride-auto-start-trips',
--     'pamojaride-auto-complete-trips',
--     'pamojaride-trip-departure-reminders'
--   );
-- ============================================================================
