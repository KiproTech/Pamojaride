-- ============================================================================
-- PamojaRide — Notifications system fix
-- Run this once in the Supabase SQL Editor, AFTER trip_auto_completion.sql.
-- ============================================================================
--
-- ROOT CAUSE of "new row for relation notifications violates check
-- constraint notifications_type_check":
--
--   public.mark_no_show(p_booking_id) — the driver's "mark passenger as
--   no-show" RPC (currently defined in bookings_trips_hardening.sql, which
--   is the version actually live, since it was applied after the older
--   mark_no_show.sql) — calls:
--
--       PERFORM public.notify(v_booking.passenger_id, 'booking_no_show', ...);
--
--   'booking_no_show' was NEVER added to notifications_type_check in any
--   migration — not in the original db.sql, not in
--   account_status_enforcement.sql (which added 'account_banned'), not in
--   trip_auto_completion.sql (which added 'trip_completion_pending'). So
--   every single call to mark_no_show() has always thrown this exact
--   constraint violation, and because the notify() call happens inside the
--   same transaction as the booking status UPDATE, the whole RPC rolls
--   back — marking a no-show has never actually worked in this app.
--
--   This migration fixes it by adding 'booking_no_show' to the constraint.
--   No frontend or function code needs to change — mark_no_show() already
--   does the right thing, it was only ever blocked by the missing type.
--
-- SECOND ISSUE found while auditing every notification-producing code path
-- per the requested checklist ("Driver starts a trip → relevant passengers
-- are notified"): there has never been any mechanism in this project that
-- transitions a trip from 'scheduled' to 'ongoing' at all — the driver
-- dashboard only *displays* a departed-but-still-'scheduled' trip as
-- "active", the status column itself never actually changes, so there was
-- nothing to hang a "trip started" notification off of. This migration
-- adds a small, additive, cron-driven auto_start_departed_trips()
-- function — same pattern as auto_complete_pending_trips() from
-- trip_auto_completion.sql — that flips a trip to 'ongoing' the moment its
-- departure time passes and notifies its confirmed passengers. This
-- requires zero frontend changes: driver/Dashboard.jsx and
-- driver/ManageTrips.jsx already treat "'ongoing' OR (scheduled AND past
-- departure)" as the same "active" bucket, and TRIP_STATUS_BADGE already
-- has an entry for 'ongoing'.
--
-- Everything else audited (trip cancellation, trip completion, completion
-- confirmation, 50% threshold, 20-minute auto-completion) already used
-- notification types that trip_auto_completion.sql had already made valid,
-- and were confirmed working when you tested the pg_cron job earlier.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Fix the constraint: add 'booking_no_show' (the actual bug) and
--    'trip_started' (needed for the new auto-start notification below).
--    Full canonical list restated each time, same pattern as every prior
--    migration that touched this constraint — nothing removed.
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
    'rating_received'::text, 'dispute_update'::text, 'admin_announcement'::text
  ]));

-- ----------------------------------------------------------------------------
-- 2. auto_start_departed_trips(): flips 'scheduled' trips whose departure
--    time has passed to 'ongoing' and notifies their confirmed passengers.
--    FOR UPDATE SKIP LOCKED — same reasoning as auto_complete_pending_trips:
--    safe against overlapping cron runs, and a trip is only ever picked up
--    once because the WHERE clause excludes it as soon as its status is no
--    longer 'scheduled'.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_start_departed_trips()
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
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'scheduled'
      AND departure_time <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);

    UPDATE public.trips SET status = 'ongoing' WHERE id = v_trip.id;

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = v_trip.id AND status = 'confirmed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_started', 'Your trip has started',
        format('Your trip %s -> %s is now in progress.', v_trip.origin, v_trip.destination),
        jsonb_build_object('trip_id', v_trip.id)
      );
    END LOOP;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN v_processed;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.auto_start_departed_trips() TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Schedule it the same way as auto_complete_pending_trips — every
--    minute, server-side, independent of any browser being open.
-- ----------------------------------------------------------------------------

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pamojaride-auto-start-trips';

SELECT cron.schedule(
  'pamojaride-auto-start-trips',
  '* * * * *',
  $$ SELECT public.auto_start_departed_trips(); $$
);

-- To verify both jobs are registered and active:
--   SELECT jobid, jobname, schedule, active FROM cron.job
--   WHERE jobname IN ('pamojaride-auto-start-trips', 'pamojaride-auto-complete-trips');
