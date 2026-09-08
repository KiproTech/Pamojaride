-- ============================================================================
-- PamojaRide — Profile & Account Settings: phone_verified integrity fix
-- Run this once in the Supabase SQL Editor.
-- ============================================================================
--
-- CONTEXT
--
-- Audited the whole Profile & Account Settings surface: PersonalInfoCard.jsx
-- (name/phone/photo), ChangePasswordCard.jsx (auth.updateUser, never touches
-- `profiles` directly), profilePhoto.js + profile_photo_storage.sql (upload
-- validation + storage RLS), and the protect_profile_privileged_columns
-- trigger (critical_security_fixes.sql) that already blocks a non-admin from
-- changing `is_admin` or `trips_completed`. All of that is solid and needed
-- no changes.
--
-- ALSO confirmed (via the comment in src/pages/driver/Bookings.jsx
-- documenting a previous "Unknown passenger" bug fix) that RLS on
-- `public.profiles` is already enabled live with an own-row-only SELECT
-- policy — cross-user profile reads go through dedicated RPCs
-- (get_driver_trip_bookings, etc.), never a direct embed. That policy isn't
-- in any tracked file, but the evidence that it's live and correct is
-- strong enough not to touch it here.
--
-- ONE real gap found: `profiles.phone_verified` is a real column, already
-- rendered nowhere false-positively today (nothing in the frontend reads it
-- yet), but it is NOT covered by the privileged-columns trigger. Two
-- consequences once it does get used (SMS/M-Pesa flows are an obvious near-
-- term use for a ride-sharing app):
--   1. A user changing their phone number in PersonalInfoCard keeps
--      whatever `phone_verified` value the OLD, now-replaced number had —
--      i.e. a new, never-verified number silently inherits "verified".
--   2. Nothing stops a user calling updateProfile({ phone_verified: true })
--      directly and marking their own number verified without ever having
--      verified it.
--
-- This migration closes both, using the exact same
-- `pamojaride.system_update` escape hatch trips_completed already relies on
-- for its own system-only writes, so a future OTP-verification feature can
-- still legitimately flip it to true from a SECURITY DEFINER function.
--
-- Idempotent (CREATE OR REPLACE on an existing function/trigger, no
-- signature change, so no DROP needed here — unlike notify() in
-- notifications_center_hardening.sql). No data is deleted; existing
-- `phone_verified` values on rows whose phone hasn't changed are untouched.
-- ============================================================================

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

  -- A changed phone number can never carry over a stale "verified" flag
  -- from the number it's replacing — silently correct rather than reject,
  -- since this is the expected/desired outcome of an otherwise-legitimate
  -- phone-number edit, not something to block.
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    NEW.phone_verified := false;
  ELSIF NEW.phone_verified IS DISTINCT FROM OLD.phone_verified
     AND coalesce(current_setting('pamojaride.system_update', true), '') <> 'true'
  THEN
    RAISE EXCEPTION 'phone_verified can only be changed by the system';
  END IF;

  RETURN NEW;
END;
$function$;

-- The trigger itself already exists and points at this function by name
-- (trg_protect_profile_privileged_columns, from critical_security_fixes.sql)
-- — CREATE OR REPLACE above is enough to pick up the new logic, no need to
-- drop/recreate the trigger.
-- ============================================================================
