-- ============================================================================
-- PamojaRide — critical fixes found via RLS/trigger audit
-- Run this whole script once in the Supabase SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- FIX 1 (CRITICAL): profiles has no privileged-column protection, unlike
-- driver_profiles/passenger_profiles. Right now ANY authenticated user can
-- run: supabase.from('profiles').update({ is_admin: true }).eq('id', own_id)
-- and grant themselves admin. This adds the same style of trigger already
-- protecting driver_profiles/passenger_profiles.
--
-- complete_trip() legitimately increments profiles.trips_completed as a
-- non-admin driver, so we allow that one specific case through via a
-- transaction-local flag, the same way protect_driver_profile_privileged_
-- columns() carves out the driver's own KYC submission.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'Only an administrator may change is_admin';
  END IF;

  IF NEW.trips_completed IS DISTINCT FROM OLD.trips_completed
     AND coalesce(current_setting('pamojaride.system_update', true), '') <> 'true'
  THEN
    RAISE EXCEPTION 'trips_completed can only be changed by the system';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileged_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileged_columns
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_columns();

-- Let complete_trip's own profiles.trips_completed increment through the
-- new trigger by flagging it as a system update for the rest of this
-- transaction only (set_config's 3rd arg = true means "local to transaction").
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

  UPDATE public.trips SET status = 'completed' WHERE id = p_trip_id RETURNING * INTO v_trip;

  UPDATE public.bookings SET status = 'completed' WHERE trip_id = p_trip_id AND status = 'confirmed';

  PERFORM set_config('pamojaride.system_update', 'true', true);
  UPDATE public.profiles SET trips_completed = trips_completed + 1 WHERE id = v_trip.driver_id;

  RETURN v_trip;
END;
$function$;

-- ----------------------------------------------------------------------------
-- FIX 2 (HIGH): driver_profiles is fully readable by literally anyone
-- (including anonymous visitors), exposing national_id, licence_number, KYC
-- rejection reasons, etc. Nothing in the codebase actually needs this —
-- trip cards already snapshot vehicle info onto `trips` at creation time,
-- and driver contact details are properly gated behind get_trip_contact().
--
-- Replacing it with an admin-only policy. NOTE: this is also the ONLY
-- reason admin/Dashboard.jsx, DriverReview.jsx, and UserManagement.jsx can
-- currently see driver rows at all — they have no explicit admin policy of
-- their own, they were silently relying on this leak. This fix keeps them
-- working correctly while closing the PII exposure.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "anyone can read minimal driver info" ON public.driver_profiles;

DROP POLICY IF EXISTS "admin can read all driver profiles" ON public.driver_profiles;
CREATE POLICY "admin can read all driver profiles"
ON public.driver_profiles FOR SELECT
USING (public.is_admin(auth.uid()));

-- ----------------------------------------------------------------------------
-- FIX 3 (FUNCTIONAL BUG): passenger_profiles has NO admin-read policy at
-- all (unlike driver_profiles, which at least had the leaky one). This
-- means UserManagement.jsx has been silently showing ZERO passengers to
-- admins this whole time, since RLS blocks admins from reading passenger
-- rows that aren't their own.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "admin can read all passenger profiles" ON public.passenger_profiles;
CREATE POLICY "admin can read all passenger profiles"
ON public.passenger_profiles FOR SELECT
USING (public.is_admin(auth.uid()));
