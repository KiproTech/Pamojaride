-- ============================================================================
-- PamojaRide — Passenger Notifications for Trip Cancellations
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- driver_trip_cancellation_reasons.sql (it replaces cancel_trip() defined
-- there — everything else in that file, and in driver_trip_cancellation.sql
-- / bookings_trips_hardening.sql / driver_passenger_booking_cancellation.sql
-- / trip_auto_completion.sql / notifications_fix.sql, is untouched).
--
-- Safe to run multiple times. Only replaces a function — no table is
-- dropped or recreated, no column is added or removed, and no existing row
-- is touched or deleted. Uses the SAME `public.notify(...)` function and
-- the SAME `trip_cancelled` notification type that already exist and are
-- already valid against `notifications_type_check` — no new notification
-- system, table, or type is introduced.
-- ============================================================================
--
-- WHAT WAS MISSING (per the "Passenger Notifications for Trip Cancellation"
-- requirements) and is fixed here:
--
--   1. The notification body already named the route, date/time, and
--      resolved reason (added in driver_trip_cancellation_reasons.sql), but
--      it never told the passenger what to do next. This migration adds a
--      clear, professional call-to-action sentence to the end of the body:
--      "Please check available trips for another option." The date/time
--      format ('DD Mon, HH24:MI') is left exactly as-is, matching every
--      other notification in the app, so nothing about how dates are
--      displayed changes anywhere else.
--
--   2. Defence-in-depth against duplicate notifications: cancel_trip()
--      already can't run twice for the same trip in practice — the trip
--      row is locked with `FOR UPDATE` and the very first statement in the
--      function re-checks `status IN ('scheduled','ongoing')`, so a second
--      call (double-click, retried request, etc.) is rejected with
--      "Trip is already cancelled" before it ever reaches the
--      notification loop. This migration adds an explicit, belt-and-braces
--      guard around the `notify()` call itself — it looks up whether a
--      'trip_cancelled' notification already exists for this exact
--      booking before inserting a new one — so that even a future code
--      change that calls this loop body a second time for the same
--      booking cannot create a second notification.
--
--   3. Forward-compatible notification payload: `data` now also carries
--      `origin`, `destination`, `departure_time`, and the booking's
--      `refund_status` alongside the existing `trip_id` /
--      `booking_id` / `cancellation_reason` / `cancellation_reason_category`
--      keys. This is purely additive (existing keys are unchanged) so any
--      code already reading this jsonb keeps working, and a future
--      refund/payment feature has a ready-made place to read "was this
--      booking flagged for a refund" from the same notification record
--      without needing a schema change or a second notification.
--
--   Everything else — who can cancel what, the "can't cancel a started
--   trip" rule, the mandatory fixed-category reason for a driver (with
--   free text required for 'other'), the admin free-text override path,
--   marking affected bookings cancelled and flagging them for refund
--   review — is copied unchanged from driver_trip_cancellation_reasons.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_trip(
  p_trip_id uuid,
  p_reason text DEFAULT NULL::text,
  p_reason_category text DEFAULT NULL::text
)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_booking RECORD;
  v_caller uuid := auth.uid();
  v_caller_is_admin boolean;
  v_final_reason text;
  v_final_category text;
  v_refund_status text;
  v_already_notified boolean;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;

  v_caller_is_admin := public.is_admin(v_caller);

  IF NOT (v_trip.driver_id = v_caller OR v_caller_is_admin) THEN
    RAISE EXCEPTION 'Not authorized to cancel this trip';
  END IF;

  IF v_trip.status NOT IN ('scheduled', 'ongoing') THEN
    RAISE EXCEPTION 'Trip is already % and cannot be cancelled', v_trip.status;
  END IF;

  -- Correct flow: Scheduled -> can cancel. Started -> cannot cancel.
  -- "Started" means the trip is already 'ongoing', OR it's still marked
  -- 'scheduled' but its departure time has passed. This only restricts the
  -- DRIVER — an admin may still force-cancel a started trip when needed
  -- (e.g. a safety issue reported mid-trip), matching existing behaviour.
  IF NOT v_caller_is_admin AND (v_trip.status = 'ongoing' OR v_trip.departure_time <= now()) THEN
    RAISE EXCEPTION 'This trip has already started and can no longer be cancelled';
  END IF;

  -- ── Reason validation (backend — cannot be bypassed by calling the RPC
  --    directly, and the trips privileged-columns trigger blocks writing
  --    these columns any other way) ─────────────────────────────────────
  IF v_caller_is_admin AND v_trip.driver_id IS DISTINCT FROM v_caller THEN
    -- Admin force-cancelling someone else's trip: free-text reason, mandatory.
    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
      RAISE EXCEPTION 'A cancellation reason is required';
    END IF;
    v_final_reason := trim(p_reason);
    v_final_category := 'admin_override';
  ELSE
    -- Driver cancelling their own trip (or an admin cancelling their own
    -- trip, which follows the same driver-facing rules): a category from
    -- the fixed list is mandatory.
    IF p_reason_category IS NULL OR NOT (p_reason_category = ANY (ARRAY[
      'vehicle_problem', 'personal_emergency', 'change_of_plans',
      'weather_conditions', 'unable_to_continue', 'other'
    ])) THEN
      RAISE EXCEPTION 'A valid cancellation reason is required';
    END IF;

    IF p_reason_category = 'other' THEN
      IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'Please explain the reason for cancelling';
      END IF;
      v_final_reason := trim(p_reason);
    ELSE
      -- Label is resolved here, server-side — never trusted from the
      -- client — so a non-'other' category can't be used to smuggle in
      -- arbitrary text.
      v_final_reason := CASE p_reason_category
        WHEN 'vehicle_problem' THEN 'Vehicle problem/breakdown'
        WHEN 'personal_emergency' THEN 'Personal emergency'
        WHEN 'change_of_plans' THEN 'Change of plans'
        WHEN 'weather_conditions' THEN 'Road/weather conditions'
        WHEN 'unable_to_continue' THEN 'Unable to continue the trip'
      END;
    END IF;
    v_final_category := p_reason_category;
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.trips
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_caller,
        cancellation_reason = v_final_reason,
        cancellation_reason_category = v_final_category
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  FOR v_booking IN
    SELECT * FROM public.bookings WHERE trip_id = p_trip_id AND status IN ('pending', 'confirmed')
  LOOP
    v_refund_status := CASE WHEN v_booking.total_price > 0 THEN 'pending' ELSE 'not_applicable' END;

    -- Mark the booking cancelled and flag it for a future refund review.
    -- No payment is actually processed here — this only records that one
    -- is owed, ready for whichever payment workflow gets built next.
    UPDATE public.bookings
      SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_caller,
          cancellation_reason = v_final_reason,
          refund_status = v_refund_status
      WHERE id = v_booking.id;

    -- Belt-and-braces duplicate guard: a 'trip_cancelled' notification for
    -- this exact booking should only ever exist once. In normal operation
    -- this can never fire twice for the same booking (the trip-status
    -- check above already stops cancel_trip from running a second time),
    -- but this keeps it true even if that ever changes.
    SELECT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = v_booking.passenger_id
        AND type = 'trip_cancelled'
        AND data ->> 'booking_id' = v_booking.id::text
    ) INTO v_already_notified;

    IF NOT v_already_notified THEN
      PERFORM public.notify(
        v_booking.passenger_id, 'trip_cancelled', 'Trip cancelled',
        format(
          'Your trip from %s to %s scheduled for %s has been cancelled by the driver. Reason: %s. Please check available trips for another option.',
          v_trip.origin, v_trip.destination,
          to_char(v_trip.departure_time, 'DD Mon, HH24:MI'),
          v_final_reason
        ),
        jsonb_build_object(
          'trip_id', v_trip.id,
          'booking_id', v_booking.id,
          'origin', v_trip.origin,
          'destination', v_trip.destination,
          'departure_time', v_trip.departure_time,
          'cancellation_reason', v_final_reason,
          'cancellation_reason_category', v_final_category,
          'refund_status', v_refund_status
        )
      );
    END IF;
  END LOOP;

  RETURN v_trip;
END;
$function$;
