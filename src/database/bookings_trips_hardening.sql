-- ============================================================================
-- PamojaRide — bookings/trips RLS hardening
-- Run this whole script once in the Supabase SQL Editor.
-- ============================================================================
-- Confirmed via codebase search: NOTHING in the frontend does a direct
-- .from('bookings').update(...) or .from('trips').update(...) — every
-- mutation already goes through book_seats / cancel_booking / mark_no_show /
-- cancel_trip / complete_trip. But the RLS UPDATE policies on both tables
-- have no column-level restriction, so a deliberately crafted direct API
-- call could currently bypass all of that business logic — e.g. a passenger
-- setting their own booking's total_price to 0, or a driver marking their
-- own trip 'completed' without it ever having departed.
--
-- This adds the same style of protective trigger already used on
-- profiles/driver_profiles/passenger_profiles: block direct changes to the
-- sensitive columns unless the caller is an admin, or the change is coming
-- from one of the RPCs below (flagged via a transaction-local setting, same
-- pattern as complete_trip's trips_completed carve-out).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- bookings: block direct changes to status/money/ownership columns.
-- pickup_point/dropoff_point are left open — harmless, no financial or
-- status impact, and the existing "own booking" RLS policy already implies
-- passengers may want to adjust these directly in the future.
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

DROP TRIGGER IF EXISTS trg_protect_bookings_privileged_columns ON public.bookings;
CREATE TRIGGER trg_protect_bookings_privileged_columns
BEFORE UPDATE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.protect_bookings_privileged_columns();

-- ----------------------------------------------------------------------------
-- trips: block direct changes to status/seat-count/ownership columns.
-- Everything else (origin/destination/times/price_per_seat/notes/vehicle
-- fields/pickup/dropoff) is left directly editable by the driver, matching
-- the existing RLS intent that a driver can update their own scheduled/
-- ongoing trip — this only locks down the fields that would let someone
-- bypass book_seats/cancel_trip/complete_trip's actual business rules.
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
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.total_seats IS DISTINCT FROM OLD.total_seats
  THEN
    RAISE EXCEPTION 'This field can only be changed by the system or an administrator';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_trips_privileged_columns ON public.trips;
CREATE TRIGGER trg_protect_trips_privileged_columns
BEFORE UPDATE ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.protect_trips_privileged_columns();

-- ----------------------------------------------------------------------------
-- Now flag the 5 RPCs so their own legitimate writes to those columns pass
-- the new triggers. The flag is set ONCE near the top of each function,
-- before its first privileged write — set_config(..., true) is local to the
-- current transaction, so it covers every subsequent write in the same
-- function call and resets itself automatically afterward.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.book_seats(p_trip_id uuid, p_seats integer, p_pickup_point text DEFAULT NULL::text, p_dropoff_point text DEFAULT NULL::text)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_passenger_id uuid := auth.uid();
BEGIN
  IF v_passenger_id IS NULL THEN
    RAISE EXCEPTION 'Must be authenticated to book a trip';
  END IF;
  IF p_seats IS NULL OR p_seats < 1 THEN
    RAISE EXCEPTION 'seats must be at least 1';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;
  IF v_trip.status <> 'scheduled' THEN
    RAISE EXCEPTION 'Trip is not open for booking (status: %)', v_trip.status;
  END IF;
  IF v_trip.departure_time <= now() THEN
    RAISE EXCEPTION 'Trip has already departed';
  END IF;
  IF v_trip.driver_id = v_passenger_id THEN
    RAISE EXCEPTION 'A driver cannot book their own trip';
  END IF;
  IF v_trip.available_seats < p_seats THEN
    RAISE EXCEPTION 'Only % seat(s) available', v_trip.available_seats;
  END IF;

  INSERT INTO public.bookings (
    booking_reference, trip_id, passenger_id, seats_booked,
    price_per_seat_snapshot, total_price, status, pickup_point, dropoff_point
  ) VALUES (
    'PR-' || to_char(now(), 'YYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
    p_trip_id, v_passenger_id, p_seats,
    v_trip.price_per_seat, v_trip.price_per_seat * p_seats, 'confirmed',
    p_pickup_point, p_dropoff_point
  ) RETURNING * INTO v_booking;

  PERFORM set_config('pamojaride.system_update', 'true', true);
  UPDATE public.trips SET available_seats = available_seats - p_seats WHERE id = p_trip_id;

  PERFORM public.notify(
    v_trip.driver_id, 'booking_created', 'New booking',
    format('%s seat(s) booked on your trip %s -> %s', p_seats, v_trip.origin, v_trip.destination),
    jsonb_build_object('trip_id', p_trip_id, 'booking_id', v_booking.id)
  );

  RETURN v_booking;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_booking(p_booking_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Booking is already % and cannot be cancelled', v_booking.status;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_booking.trip_id FOR UPDATE;

  IF NOT (
    v_booking.passenger_id = v_caller
    OR v_trip.driver_id = v_caller
    OR public.is_admin(v_caller)
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel this booking';
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.bookings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_caller, cancellation_reason = p_reason
    WHERE id = p_booking_id
    RETURNING * INTO v_booking;

  UPDATE public.trips SET available_seats = available_seats + v_booking.seats_booked WHERE id = v_trip.id;

  PERFORM public.notify(
    CASE WHEN v_caller = v_booking.passenger_id THEN v_trip.driver_id ELSE v_booking.passenger_id END,
    'booking_cancelled', 'Booking cancelled',
    format('Booking %s was cancelled', v_booking.booking_reference),
    jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.id)
  );

  RETURN v_booking;
END;
$function$;

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
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF NOT (v_trip.driver_id = v_caller OR public.is_admin(v_caller)) THEN
    RAISE EXCEPTION 'Not authorized to cancel this trip';
  END IF;
  IF v_trip.status NOT IN ('scheduled', 'ongoing') THEN
    RAISE EXCEPTION 'Trip is already % and cannot be cancelled', v_trip.status;
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.trips
    SET status = 'cancelled', cancelled_at = now(), cancellation_reason = p_reason
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  FOR v_booking IN
    SELECT * FROM public.bookings WHERE trip_id = p_trip_id AND status IN ('pending', 'confirmed')
  LOOP
    UPDATE public.bookings
      SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_caller,
          cancellation_reason = 'Trip cancelled by driver'
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

CREATE OR REPLACE FUNCTION public.complete_trip(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
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

  -- Set once, up front, so it covers ALL privileged writes below (trips,
  -- bookings, AND profiles.trips_completed) — set_config(..., true) only
  -- affects statements that run AFTER it in the same transaction.
  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.trips SET status = 'completed' WHERE id = p_trip_id RETURNING * INTO v_trip;

  UPDATE public.bookings SET status = 'completed' WHERE trip_id = p_trip_id AND status = 'confirmed';

  UPDATE public.profiles SET trips_completed = trips_completed + 1 WHERE id = v_trip.driver_id;

  RETURN v_trip;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_no_show(p_booking_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_booking.trip_id FOR UPDATE;

  IF NOT (v_trip.driver_id = v_caller OR public.is_admin(v_caller)) THEN
    RAISE EXCEPTION 'Not authorized to mark this booking as a no-show';
  END IF;

  IF v_booking.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only confirmed bookings can be marked as a no-show (status: %)', v_booking.status;
  END IF;

  IF v_trip.departure_time > now() THEN
    RAISE EXCEPTION 'Cannot mark a no-show before the trip''s departure time';
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  UPDATE public.bookings
    SET status = 'no_show'
    WHERE id = p_booking_id
    RETURNING * INTO v_booking;

  PERFORM public.notify(
    v_booking.passenger_id, 'booking_no_show', 'Marked as no-show',
    format('You were marked as a no-show for booking %s (%s -> %s).',
      v_booking.booking_reference, v_trip.origin, v_trip.destination),
    jsonb_build_object('trip_id', v_trip.id, 'booking_id', v_booking.id)
  );

  RETURN v_booking;
END;
$function$;
