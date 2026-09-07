-- ============================================================================
-- PamojaRide — Driver Cancels an Individual Passenger's Booking
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- driver_trip_cancellation_reasons.sql AND driver_booking_report_fields.sql
-- (it only touches `bookings`, `cancel_booking()`, and
-- `get_driver_trip_bookings()` — trips / cancel_trip() / the trips
-- privileged-columns trigger are all untouched by this file, and every
-- column driver_booking_report_fields.sql added, e.g. pickup_point /
-- dropoff_point, is preserved).
--
-- Safe to run multiple times. Adds a column with IF NOT EXISTS, adds a
-- constraint only if missing, and only replaces functions — no table is
-- dropped or recreated, and no existing row is touched or deleted.
-- ============================================================================
--
-- What this does:
--   1. Adds `bookings.cancellation_reason_category` — the fixed reason key
--      picked from the dropdown ('passenger_requested', 'could_not_reach',
--      'info_incorrect', 'safety_concern', 'capacity_issue', 'other'), or
--      'admin_override' when an admin force-cancels a booking on someone's
--      behalf. NULL for a booking that was never cancelled, or one that was
--      cancelled by the passenger themself (that flow is unchanged and
--      keeps using free text only, exactly like it already did) or cascaded
--      from a whole-trip cancellation (cancel_trip already stores its own
--      reason on the booking; this column is specific to a per-booking
--      driver cancellation).
--      `bookings.cancellation_reason` already existed — it keeps storing
--      the human-readable text (the dropdown label, or the driver's typed
--      explanation when the category is 'other').
--
--   2. Extends the existing bookings privileged-columns trigger so the new
--      column can only ever be changed by the system (via cancel_booking)
--      or an admin — never directly by a driver/passenger update, exactly
--      like cancellation_reason, cancelled_at, cancelled_by, and
--      refund_status already are. A driver cannot set this column by any
--      means other than going through cancel_booking(), which validates the
--      reason before it ever reaches the row.
--
--   3. Replaces cancel_booking(p_booking_id, p_reason, p_reason_category) —
--      backwards compatible with the existing caller
--      (passenger/MyBookings.jsx, which only ever passes p_booking_id and a
--      fixed p_reason string and never touches p_reason_category):
--        - Passenger cancelling their OWN booking: unchanged behaviour —
--          free-text reason, defaults to "Cancelled by passenger" if none
--          is supplied. p_reason_category is ignored/left NULL.
--        - DRIVER cancelling one of their passengers' bookings (the new
--          path this migration adds): p_reason_category is now REQUIRED
--          and must be one of the six fixed keys above — anything else
--          (including NULL) is rejected before any row is touched. If the
--          category is 'other', p_reason must also be non-empty explanation
--          text. For every other category, the reason text stored is the
--          fixed human-readable label for that category (looked up
--          server-side, not trusted from the client), so a driver cannot
--          pass arbitrary text through a non-'other' category. A driver can
--          only cancel a booking on a trip they own (trips.driver_id =
--          auth.uid()) — cancelling a booking on someone else's trip, or a
--          non-existent booking, is rejected. A trip that has already been
--          completed can no longer have its bookings cancelled this way.
--        - Admin force-cancelling on someone's behalf: unchanged behaviour,
--          just now also backend-enforced — p_reason must be non-empty
--          free text.
--      The old 2-argument overload (p_booking_id, p_reason) is dropped
--      first so a driver cannot bypass the new mandatory-reason checks by
--      calling that signature directly — every caller now goes through the
--      one 3-argument function below.
--
--   4. Seat / count handling and audit trail are unchanged from the
--      existing cancel_booking(): the booking row is never deleted (only
--      its status/cancellation columns change, so its history stays
--      intact for future admin review), and the cancelled seat(s) are
--      always added back onto trips.available_seats.
--
--   5. Passenger notification: still sent through the existing
--      public.notify(...) function with the existing 'booking_cancelled'
--      notification type (already valid — see notifications_fix.sql) — no
--      new notification system or type is added. When the driver initiated
--      the cancellation, the notification body now names the trip and
--      includes the resolved cancellation reason.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New column on bookings.
-- ----------------------------------------------------------------------------

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS cancellation_reason_category text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancellation_reason_category_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_cancellation_reason_category_check
      CHECK (cancellation_reason_category IS NULL OR cancellation_reason_category = ANY (ARRAY[
        'passenger_requested'::text, 'could_not_reach'::text, 'info_incorrect'::text,
        'safety_concern'::text, 'capacity_issue'::text, 'other'::text,
        'admin_override'::text
      ]));
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Extend the bookings privileged-columns trigger to also guard the new
--    column. Same admin / pamojaride.system_update carve-outs as before —
--    the trigger itself (trg_protect_bookings_privileged_columns) already
--    points at this function name, so it does not need to be recreated.
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
     OR NEW.cancellation_reason_category IS DISTINCT FROM OLD.cancellation_reason_category
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
-- function name — no need to touch the trigger itself.

-- ----------------------------------------------------------------------------
-- 3. cancel_booking(): mandatory, backend-validated dropdown reason for a
--    driver cancelling one of their passengers' bookings; unchanged
--    (free-text, defaulted) behaviour for a passenger cancelling their own
--    booking; unchanged (but now also backend-enforced) free-text
--    requirement for an admin force-cancellation.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.cancel_booking(uuid, text);

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
  -- This is what stops "driver B cancels driver A's passenger" and
  -- "cancel someone else's booking" outright, regardless of what the
  -- client sends.
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
  -- a passenger's booking once the trip itself has been marked completed —
  -- the passenger's own self-cancellation path is unaffected by this rule.
  IF v_caller <> v_booking.passenger_id AND v_trip.status = 'completed' THEN
    RAISE EXCEPTION 'This trip has already been completed and its bookings can no longer be cancelled';
  END IF;

  IF v_caller = v_booking.passenger_id THEN
    -- Passenger self-cancellation: unchanged legacy behaviour.
    v_final_reason := coalesce(nullif(trim(p_reason), ''), 'Cancelled by passenger');
    v_final_category := NULL;
  ELSIF v_trip.driver_id = v_caller THEN
    -- ── Driver cancelling one of their passengers (backend — cannot be
    --    bypassed by calling the RPC directly, and the trigger above
    --    blocks writing these columns any other way) ────────────────────
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
      -- Label is resolved here, server-side — never trusted from the
      -- client — so a non-'other' category can't be used to smuggle in
      -- arbitrary text.
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

  -- Booking is never deleted — only its status/cancellation columns
  -- change, so the record (and its history) stays intact for future
  -- admin review/auditing.
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

  -- Make the cancelled seat(s) available again and keep
  -- available/booked seat counts correct.
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
-- 4. Let the driver's bookings view also return the reason category and who
--    cancelled the booking, so the UI/history can distinguish "Other" (free
--    text) cancellations from a fixed-label one if ever needed. Every column
--    added by driver_booking_report_fields.sql (pickup_point, dropoff_point)
--    is kept exactly as-is, and the ordering (by trip departure, then by
--    booking) is unchanged — this is purely additive on top of that file.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.get_driver_trip_bookings(uuid);

CREATE FUNCTION public.get_driver_trip_bookings(p_trip_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  booking_reference text,
  trip_id uuid,
  passenger_id uuid,
  passenger_name text,
  passenger_phone text,
  seats_booked integer,
  total_price numeric,
  status text,
  refund_status text,
  cancellation_reason text,
  cancellation_reason_category text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  created_at timestamptz,
  origin text,
  destination text,
  pickup_point text,
  dropoff_point text,
  departure_time timestamptz,
  trip_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    b.id,
    b.booking_reference,
    b.trip_id,
    b.passenger_id,
    p.full_name,
    p.phone,
    b.seats_booked,
    b.total_price,
    b.status,
    b.refund_status,
    b.cancellation_reason,
    b.cancellation_reason_category,
    b.cancelled_at,
    b.cancelled_by,
    b.created_at,
    t.origin,
    t.destination,
    t.pickup_point,
    t.dropoff_point,
    t.departure_time,
    t.status
  FROM public.bookings b
  JOIN public.trips t   ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE t.driver_id = auth.uid()
    AND (p_trip_id IS NULL OR b.trip_id = p_trip_id)
  ORDER BY t.departure_time DESC, b.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_trip_bookings(uuid) TO authenticated;
