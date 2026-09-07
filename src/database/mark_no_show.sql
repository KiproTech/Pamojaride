-- Run this in the Supabase SQL Editor.
-- Adds a proper RPC for marking a passenger as a no-show, mirroring the
-- auth/locking/notification pattern already used by cancel_booking /
-- cancel_trip / complete_trip, instead of the raw client-side table
-- update currently used in driver/Bookings.jsx.

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

  -- Only the trip's driver (or an admin) can mark a no-show.
  IF NOT (v_trip.driver_id = v_caller OR public.is_admin(v_caller)) THEN
    RAISE EXCEPTION 'Not authorized to mark this booking as a no-show';
  END IF;

  IF v_booking.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only confirmed bookings can be marked as a no-show (status: %)', v_booking.status;
  END IF;

  -- A no-show can only be logged once the trip has actually departed --
  -- otherwise a driver could pre-emptively flag someone before they even
  -- had a chance to show up.
  IF v_trip.departure_time > now() THEN
    RAISE EXCEPTION 'Cannot mark a no-show before the trip''s departure time';
  END IF;

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
