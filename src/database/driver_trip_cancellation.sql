-- ============================================================================
-- PamojaRide — Driver Trip Cancellation hardening
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- bookings_trips_hardening.sql (it replaces cancel_trip() and the bookings
-- privileged-columns trigger defined there — everything else in that file
-- is untouched).
-- ============================================================================
--
-- What this does:
--   1. Adds `bookings.refund_status`, a placeholder column so a booking that
--      gets cancelled because its trip was cancelled can be flagged for a
--      future refund workflow. No money actually moves yet — this only
--      records that a refund review is owed.
--   2. Extends the existing bookings privileged-columns trigger so
--      refund_status can only ever be changed by the system (via the RPCs
--      below) or an admin — never directly by a passenger or driver.
--   3. Replaces cancel_trip() so a DRIVER can only cancel a trip that hasn't
--      started yet (status = 'scheduled' AND departure_time in the future).
--      Once a trip is 'ongoing', or its scheduled departure time has passed,
--      the driver can no longer cancel it — the check is enforced here in
--      the database, not just hidden in the UI, so it can't be bypassed by
--      calling the RPC directly.
--      An ADMIN is left able to force-cancel a scheduled OR ongoing trip,
--      exactly as before (see admin/TripOversight.jsx) — this migration
--      only narrows what a DRIVER may do.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Refund placeholder column on bookings.
--    'not_applicable' — default; nothing to refund (booking never paid, or
--                        was cancelled for a reason that isn't a driver-side
--                        trip cancellation).
--    'pending'         — set automatically when a trip is cancelled and this
--                        booking had money attached; awaiting a future
--                        refund workflow.
--    'processed'        — reserved for when real payment integration lands.
--    'failed'           — reserved for when real payment integration lands.
-- ----------------------------------------------------------------------------

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (refund_status = ANY (ARRAY['not_applicable'::text, 'pending'::text, 'processed'::text, 'failed'::text]));

-- ----------------------------------------------------------------------------
-- 2. Extend the existing bookings privileged-columns trigger to also guard
--    refund_status. Same shape as bookings_trips_hardening.sql — admins and
--    the flagged system update path are still allowed through.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_bookings_privileged_columns()
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
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
     OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
     OR NEW.refund_status IS DISTINCT FROM OLD.refund_status
     OR NEW.total_price IS DISTINCT FROM OLD.total_price
     OR NEW.price_per_seat_snapshot IS DISTINCT FROM OLD.price_per_seat_snapshot
     OR NEW.seats_booked IS DISTINCT FROM OLD.seats_booked
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.passenger_id IS DISTINCT FROM OLD.passenger_id
     OR NEW.booking_reference IS DISTINCT FROM OLD.booking_reference
  THEN
    RAISE EXCEPTION 'This field can only be changed by the system or an administrator';
  END IF;

  RETURN NEW;
END;
$function$;
-- Trigger trg_protect_bookings_privileged_columns already points at this
-- function name (created in bookings_trips_hardening.sql) — no need to
-- touch the trigger itself.

-- ----------------------------------------------------------------------------
-- 3. cancel_trip(): add the "driver can't cancel a started trip" rule, and
--    flag affected bookings for a future refund review.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_trip(p_trip_id uuid, p_reason text DEFAULT NULL::text)
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

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.trips
    SET status = 'cancelled', cancelled_at = now(), cancellation_reason = p_reason
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
          cancellation_reason = coalesce(p_reason, 'Trip cancelled by driver'),
          refund_status = CASE WHEN v_booking.total_price > 0 THEN 'pending' ELSE 'not_applicable' END
      WHERE id = v_booking.id;

    PERFORM public.notify(
      v_booking.passenger_id, 'trip_cancelled', 'Trip cancelled',
      format('Your trip %s -> %s on %s was cancelled by the driver.',
        v_trip.origin, v_trip.destination, to_char(v_trip.departure_time, 'DD Mon, HH24:MI')),
      jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.id)
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;
