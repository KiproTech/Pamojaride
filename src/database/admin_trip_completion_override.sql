-- ============================================================================
-- PamojaRide — Admin Trip Completion Override
--
-- Run this whole script once in the Supabase SQL Editor, AFTER every other
-- file in src/database — specifically after
-- trip_completion_individual_confirmations.sql,
-- trip_lifecycle_hardening_and_reminders.sql, and
-- trip_completion_20min_autocomplete.sql. Purely additive — no table is
-- dropped, no row is deleted, no existing function's behaviour changes
-- except the two small additions noted in section 3 (recording
-- completion_source/completed_by on the paths that already exist).
-- Idempotent — safe to re-run.
-- ============================================================================
--
-- WHAT THIS ADDS AND WHY:
--
--   A brand new function, admin_complete_trip(), completely separate from
--   complete_trip() (driver-initiated) and respond_trip_completion()
--   (passenger accept/decline) — it is never called by either of those,
--   and neither of them is changed in any way that affects their own
--   behaviour. This keeps the three completion sources genuinely
--   independent, per the brief's own diagram:
--
--     driver  -> complete_trip() -> pending passenger confirmations -> respond_trip_completion() / auto_complete_pending_trips()
--     admin   -> admin_complete_trip() -> trip completed immediately, no confirmations created or left open
--
--   admin_complete_trip() reuses every table the brief asks it to reuse —
--   trips, bookings, trip_completion_confirmations, notifications,
--   audit_logs — nothing new is created except:
--     - two columns on trips: completion_source ('driver' | 'admin' |
--       'auto_timeout') and completed_by (the user id associated with
--       that source — the admin for 'admin', null otherwise), so any
--       trip's completion can always be traced to how it actually
--       happened. Section 3 below back-fills these two columns into the
--       three EXISTING completion paths too, so the distinction is
--       consistent everywhere, not just for the new admin path.
--     - one new value on trip_completion_confirmations.response:
--       'admin_override' — used only to close out a passenger's row when
--       an admin finalizes the trip out from under a still-pending (or
--       never-started) confirmation, so it's visibly distinct from an
--       actual accept/decline/timeout and can never be mistaken for a
--       dispute (the brief is explicit: "do NOT automatically create a
--       dispute").
--     - one new notification type: 'trip_completed_by_admin'.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Trace columns + widened CHECK constraints (all additive).
-- ----------------------------------------------------------------------------

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS completion_source text,
  ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES public.profiles(id);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_completion_source_check;
ALTER TABLE public.trips ADD CONSTRAINT trips_completion_source_check
  CHECK (completion_source IS NULL OR completion_source = ANY (ARRAY['driver'::text, 'admin'::text, 'auto_timeout'::text]));

ALTER TABLE public.trip_completion_confirmations
  DROP CONSTRAINT IF EXISTS trip_completion_confirmations_response_check;
ALTER TABLE public.trip_completion_confirmations
  ADD CONSTRAINT trip_completion_confirmations_response_check
  CHECK (response = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'auto_completed'::text, 'admin_override'::text]));

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'booking_created'::text, 'booking_confirmed'::text, 'booking_cancelled'::text,
    'booking_no_show'::text,
    'trip_started'::text, 'trip_cancelled'::text, 'trip_reminder'::text,
    'trip_completion_pending'::text, 'trip_completed'::text,
    'trip_completion_confirmed_by_passenger'::text,
    'trip_completion_declined_by_passenger'::text,
    'trip_completion_auto_completed'::text,
    'trip_completed_by_admin'::text,
    'kyc_submitted'::text, 'kyc_approved'::text, 'kyc_rejected'::text,
    'verification_required'::text, 'account_suspended'::text, 'account_reactivated'::text,
    'account_banned'::text,
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text,
    'complaint_submitted'::text,
    'support_request_submitted'::text, 'support_update'::text
  ]));


-- ----------------------------------------------------------------------------
-- 2. admin_complete_trip(): the whole feature. Immediate, no passenger
--    confirmation window, no dispute, fully server-side authorized.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_complete_trip(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_trip public.trips%ROWTYPE;
  v_old_status text;
  v_booking RECORD;
  v_touched_passengers integer := 0;
BEGIN
  -- ── Authorization: admin only ───────────────────────────────────────────
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to complete this trip';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  -- ── Validation: trip must be in progress, not already finalized ─────────
  -- 'completion_pending' is explicitly included so an admin can resolve a
  -- trip that's stuck waiting on a driver-requested passenger
  -- confirmation (the brief's own "important edge case").
  IF v_trip.status NOT IN ('ongoing', 'scheduled', 'completion_pending') THEN
    RAISE EXCEPTION 'Trip is already % and cannot be completed', v_trip.status;
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  -- ── Close out any driver-flow confirmation left pending, WITHOUT
  --    treating it as a dispute or decline — 'admin_override' is its own
  --    distinct outcome. A passenger who had already accepted or declined
  --    keeps that answer untouched (their own history is preserved, per
  --    the brief's own "do not overwrite or lose previous status/history"
  --    rule from the driver-completion flow).
  UPDATE public.trip_completion_confirmations
    SET response = 'admin_override', responded_at = now(), confirmed_at = now()
    WHERE trip_id = p_trip_id AND response = 'pending';

  -- ── Complete every still-active booking, and make sure every one of
  --    them has a completion-confirmation record (creating one with
  --    'admin_override' if the trip never went through the driver flow at
  --    all — e.g. an 'ongoing' trip the admin is completing directly) so
  --    get_trip_passenger_completions() always has a full, honest picture
  --    of how each passenger's participation was resolved.
  FOR v_booking IN
    SELECT b.id AS booking_id, b.passenger_id
    FROM public.bookings b
    WHERE b.trip_id = p_trip_id AND b.status = 'confirmed'
    FOR UPDATE
  LOOP
    UPDATE public.bookings SET status = 'completed' WHERE id = v_booking.booking_id;

    INSERT INTO public.trip_completion_confirmations
      (trip_id, passenger_id, booking_id, requested_at, response, responded_at, confirmed_at)
    VALUES (p_trip_id, v_booking.passenger_id, v_booking.booking_id, now(), 'admin_override', now(), now())
    ON CONFLICT ON CONSTRAINT trip_completion_confirmations_unique DO UPDATE
      SET response = 'admin_override', responded_at = now(), confirmed_at = now()
      WHERE public.trip_completion_confirmations.response = 'pending';

    PERFORM public.notify(
      v_booking.passenger_id, 'trip_completed_by_admin', 'Trip Marked as Complete',
      format('Your trip from %s to %s has been marked as complete by the PamojaRide administration.', v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.booking_id)
    );

    v_touched_passengers := v_touched_passengers + 1;
  END LOOP;

  v_old_status := v_trip.status;

  UPDATE public.trips
    SET status = 'completed',
        completed_at = now(),
        completion_source = 'admin',
        completed_by = v_caller,
        auto_completed = false
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

  PERFORM public.notify(
    v_trip.driver_id, 'trip_completed_by_admin', 'Trip Completed by Administration',
    format('Your trip from %s to %s has been marked as complete by the PamojaRide administration.', v_trip.origin, v_trip.destination),
    jsonb_build_object('trip_id', v_trip.id)
  );

  INSERT INTO public.audit_logs (admin_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    v_caller, v_trip.driver_id, 'admin_completed_trip', 'trips', v_trip.id,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', 'completed', 'completion_source', 'admin', 'passengers_completed', v_touched_passengers)
  );

  RETURN v_trip;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_complete_trip(uuid) TO authenticated;


-- ----------------------------------------------------------------------------
-- 3. Record completion_source/completed_by on the three EXISTING
--    completion paths too, so the distinction the brief asks for
--    ("driver / admin / auto_timeout") is consistent everywhere, not just
--    on the new admin path. Each function's actual logic is otherwise
--    byte-for-byte identical to trip_completion_20min_autocomplete.sql /
--    trip_completion_individual_confirmations.sql.
-- ----------------------------------------------------------------------------

-- 3a. complete_trip()'s own zero-passengers immediate-complete branch.
CREATE OR REPLACE FUNCTION public.complete_trip(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_total_passengers integer;
  v_booking RECORD;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF NOT (v_trip.driver_id = v_caller OR public.is_admin(v_caller)) THEN
    RAISE EXCEPTION 'Not authorized to complete this trip';
  END IF;
  IF v_trip.status NOT IN ('scheduled', 'ongoing') THEN
    RAISE EXCEPTION 'Trip is already % and cannot be completed', v_trip.status;
  END IF;
  IF v_trip.departure_time > now() THEN
    RAISE EXCEPTION 'Trip cannot be marked completed before its departure time';
  END IF;

  SELECT count(*) INTO v_total_passengers
  FROM public.bookings
  WHERE trip_id = p_trip_id AND status = 'confirmed';

  PERFORM set_config('pamojaride.system_update', 'true', true);

  IF v_total_passengers = 0 THEN
    UPDATE public.trips
      SET status = 'completed', completed_at = now(),
          completion_source = 'driver', completed_by = v_caller
      WHERE id = p_trip_id
      RETURNING * INTO v_trip;

    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;
    RETURN v_trip;
  END IF;

  UPDATE public.trips
    SET status = 'completion_pending',
        completion_requested_at = now(),
        completion_deadline = now() + interval '20 minutes',
        completion_total_passengers = v_total_passengers,
        completion_required_confirmations = NULL
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  FOR v_booking IN
    SELECT b.id AS booking_id, b.passenger_id
    FROM public.bookings b
    WHERE b.trip_id = p_trip_id AND b.status = 'confirmed'
  LOOP
    INSERT INTO public.trip_completion_confirmations
      (trip_id, passenger_id, booking_id, requested_at, response, confirmed_at)
    VALUES (p_trip_id, v_booking.passenger_id, v_booking.booking_id, now(), 'pending', now())
    ON CONFLICT ON CONSTRAINT trip_completion_confirmations_unique DO UPDATE
      SET booking_id = EXCLUDED.booking_id,
          requested_at = now(),
          response = 'pending',
          decline_reason = NULL,
          decline_comment = NULL,
          responded_at = NULL,
          confirmed_at = now();

    PERFORM public.notify(
      v_booking.passenger_id, 'trip_completion_pending', 'Confirm your trip is complete',
      format(
        'The driver has marked this trip as complete. Please confirm whether the trip from %s to %s was completed successfully. If you do not respond within 20 minutes, the trip will automatically be marked as complete.',
        v_trip.origin, v_trip.destination
      ),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.booking_id)
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_trip(uuid) TO authenticated;


-- 3b. respond_trip_completion()'s zero-remaining-pending finalization.
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
    RAISE EXCEPTION 'This request is no longer awaiting your response';
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
      SET status = 'completed', completed_at = now(),
          completion_source = 'driver', completed_by = v_trip.driver_id
      WHERE id = p_trip_id AND status = 'completion_pending';
    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;
  END IF;

  RETURN v_confirmation;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.respond_trip_completion(uuid, text, text, text) TO authenticated;


-- 3c. auto_complete_pending_trips()'s trip-level finalization.
CREATE OR REPLACE FUNCTION public.auto_complete_pending_trips()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_confirmation RECORD;
  v_finalized integer := 0;
BEGIN
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'completion_pending'
      AND completion_deadline IS NOT NULL
      AND completion_deadline <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);

    FOR v_confirmation IN
      SELECT * FROM public.trip_completion_confirmations
      WHERE trip_id = v_trip.id AND response = 'pending'
      FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.trip_completion_confirmations
        SET response = 'auto_completed', responded_at = now(), confirmed_at = now()
        WHERE id = v_confirmation.id;

      UPDATE public.bookings
        SET status = 'completed'
        WHERE id = v_confirmation.booking_id AND status = 'confirmed';

      PERFORM public.notify(
        v_confirmation.passenger_id, 'trip_completion_auto_completed', 'Trip automatically marked complete',
        format(
          'You did not respond within 20 minutes, so your trip from %s to %s has been automatically marked as completed.',
          v_trip.origin, v_trip.destination
        ),
        jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_confirmation.booking_id, 'auto_completed', true)
      );
    END LOOP;

    UPDATE public.trips
      SET status = 'completed', completed_at = now(), auto_completed = true,
          completion_source = 'auto_timeout', completed_by = NULL
      WHERE id = v_trip.id;

    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

    v_finalized := v_finalized + 1;
  END LOOP;

  RETURN v_finalized;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.auto_complete_pending_trips() TO authenticated;

-- ============================================================================
-- End of migration. get_trip_completion_status(), get_trip_passenger_completions(),
-- cancel_booking(), cancel_trip(), reminders, ratings, and every RLS policy
-- are untouched. TripPassengerCompletionsModal.jsx (frontend) is updated
-- alongside this file to label the new 'admin_override' response
-- correctly, matching the 'auto_completed' label already added.
-- ============================================================================
