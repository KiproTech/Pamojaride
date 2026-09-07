-- ============================================================================
-- PamojaRide — Driver Trip Cancellation Reasons
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- driver_trip_cancellation.sql (it replaces cancel_trip() and the trips
-- privileged-columns trigger defined there — everything else in that file,
-- and in bookings_trips_hardening.sql / trip_auto_completion.sql, is
-- untouched).
--
-- Safe to run multiple times. Adds columns with IF NOT EXISTS and only
-- replaces functions — no table is dropped or recreated, and no existing
-- row is touched or deleted.
-- ============================================================================
--
-- What this does:
--   1. Adds two columns to `trips`:
--        - cancelled_by            — who cancelled it (driver or admin),
--                                    mirroring the column bookings already has.
--        - cancellation_reason_category — the fixed reason key the driver
--                                    picked ('vehicle_problem',
--                                    'personal_emergency', 'change_of_plans',
--                                    'weather_conditions', 'unable_to_continue',
--                                    'other'), or 'admin_override' when an
--                                    admin force-cancels the trip. NULL for
--                                    trips that were never cancelled.
--      `trips.cancellation_reason` already existed — it keeps storing the
--      human-readable text (the dropdown label, or the driver's typed
--      explanation when the category is 'other', or the admin's free text).
--
--   2. Extends the existing trips privileged-columns trigger so the two new
--      columns can only ever be changed by the system (via cancel_trip) or
--      an admin — never directly by a driver/passenger update, exactly like
--      cancellation_reason, cancelled_at, and status already are. This is
--      the actual backend enforcement: a driver cannot set these columns by
--      any means other than going through cancel_trip(), which validates
--      the reason before it ever reaches the row.
--
--   3. Replaces cancel_trip(p_trip_id, p_reason, p_reason_category) —
--      backwards compatible with every existing caller:
--        - Admin force-cancelling someone else's trip: unchanged behaviour,
--          just now also backend-enforced (was previously only enforced by
--          the admin UI disabling its button) — p_reason must be non-empty
--          free text. p_reason_category is not required for this path.
--        - Driver cancelling their own trip: p_reason_category is now
--          REQUIRED and must be one of the six fixed keys above — anything
--          else (including NULL) is rejected before any row is touched.
--          If the category is 'other', p_reason must also be non-empty
--          explanation text. For every other category, the reason text
--          stored is the fixed human-readable label for that category
--          (looked up server-side, not trusted from the client), so a
--          driver cannot pass arbitrary text through a non-'other' category.
--      The "driver can't cancel a started trip" rule from
--      driver_trip_cancellation.sql is unchanged.
--
--   4. Passenger notification bodies for affected bookings now include the
--      resolved reason text, still sent through the existing
--      public.notify(...) function with the existing 'trip_cancelled'
--      notification type — no new notification system or type is added.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New columns on trips.
-- ----------------------------------------------------------------------------

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS cancelled_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trips_cancelled_by_fkey'
  ) THEN
    ALTER TABLE public.trips
      ADD CONSTRAINT trips_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.profiles(id);
  END IF;
END $$;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS cancellation_reason_category text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trips_cancellation_reason_category_check'
  ) THEN
    ALTER TABLE public.trips
      ADD CONSTRAINT trips_cancellation_reason_category_check
      CHECK (cancellation_reason_category IS NULL OR cancellation_reason_category = ANY (ARRAY[
        'vehicle_problem'::text, 'personal_emergency'::text, 'change_of_plans'::text,
        'weather_conditions'::text, 'unable_to_continue'::text, 'other'::text,
        'admin_override'::text
      ]));
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Extend the trips privileged-columns trigger to also guard the two new
--    columns. Same admin / pamojaride.system_update carve-outs as before —
--    trigger itself (trg_protect_trips_privileged_columns) already points
--    at this function name, so it does not need to be recreated.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_trips_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('pamojaride.system_update', true), '') = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.available_seats IS DISTINCT FROM OLD.available_seats
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
     OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
     OR NEW.cancellation_reason_category IS DISTINCT FROM OLD.cancellation_reason_category
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.total_seats IS DISTINCT FROM OLD.total_seats
     OR NEW.completion_requested_at IS DISTINCT FROM OLD.completion_requested_at
     OR NEW.completion_deadline IS DISTINCT FROM OLD.completion_deadline
     OR NEW.completion_total_passengers IS DISTINCT FROM OLD.completion_total_passengers
     OR NEW.completion_required_confirmations IS DISTINCT FROM OLD.completion_required_confirmations
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.auto_completed IS DISTINCT FROM OLD.auto_completed
  THEN
    RAISE EXCEPTION 'This field can only be changed by the system or an administrator';
  END IF;

  RETURN NEW;
END;
$function$;
-- Trigger trg_protect_trips_privileged_columns already points at this
-- function name — no need to touch the trigger itself.

-- ----------------------------------------------------------------------------
-- 3. cancel_trip(): mandatory, backend-validated reason for driver
--    cancellations; unchanged (but now also backend-enforced) free-text
--    requirement for admin force-cancellations.
-- ----------------------------------------------------------------------------

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
  --    directly, and the trigger above blocks writing these columns any
  --    other way) ──────────────────────────────────────────────────────
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
    -- Mark the booking cancelled and flag it for a future refund review.
    -- No payment is actually processed here — this only records that one
    -- is owed, ready for whichever payment workflow gets built next.
    UPDATE public.bookings
      SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_caller,
          cancellation_reason = v_final_reason,
          refund_status = CASE WHEN v_booking.total_price > 0 THEN 'pending' ELSE 'not_applicable' END
      WHERE id = v_booking.id;

    PERFORM public.notify(
      v_booking.passenger_id, 'trip_cancelled', 'Trip cancelled',
      format('Your trip %s -> %s on %s was cancelled by the driver. Reason: %s',
        v_trip.origin, v_trip.destination, to_char(v_trip.departure_time, 'DD Mon, HH24:MI'), v_final_reason),
      jsonb_build_object(
        'trip_id', v_trip.id, 'booking_id', v_booking.id,
        'cancellation_reason', v_final_reason,
        'cancellation_reason_category', v_final_category
      )
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;
