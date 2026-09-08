-- ============================================================================
-- PamojaRide — Fix: Driver Verification autosave STILL failing with
-- `record "new" has no field "trips_completed"` on
-- `PATCH .../profiles?id=eq.<user_id>&select=*`
-- ============================================================================
-- Run this once in the Supabase SQL Editor. Idempotent (CREATE OR REPLACE) —
-- safe to re-run. Purely corrective: no column, table, RLS policy, or
-- terms/consent behaviour is touched or removed.
--
-- ── ROOT CAUSE (confirmed by tracing every migration touching this
--    trigger, in the order they actually ran) ────────────────────────────
--
--   1. public.profiles has never had a `trips_completed` column — it only
--      ever lived on driver_profiles/passenger_profiles (db.sql).
--   2. password_reset_and_trips_completed_fix.sql already fixed this once:
--      it shipped protect_profile_privileged_columns() WITHOUT the stale
--      `NEW.trips_completed IS DISTINCT FROM OLD.trips_completed` check.
--   3. terms_privacy_consent.sql was written and run AFTER that fix, but
--      it did its own CREATE OR REPLACE of the SAME function to add the
--      terms_accepted/terms_accepted_at consent rules — based on the
--      *pre-fix* copy of the function. That silently reintroduced the
--      `NEW.trips_completed` / `OLD.trips_completed` reference, undoing
--      the earlier fix.
--   4. profiles_audit_trigger_autosave_fix.sql then investigated the
--      resulting 400 and patched `audit_profile_admin_changes()` instead —
--      a different, unrelated AFTER trigger. That change is harmless but
--      does not touch protect_profile_privileged_columns(), so the actual
--      `NEW.trips_completed` reference has remained live the whole time,
--      which is why the exact same error is still happening today.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
-- Re-apply protect_profile_privileged_columns() one more time: keep EVERY
-- rule terms_privacy_consent.sql added (is_admin guard, phone/
-- phone_verified handling, terms_accepted one-way + server-set timestamp),
-- and only remove the reintroduced trips_completed block. Nothing else
-- changes; the trigger already points at this function by name, so no
-- DROP/CREATE TRIGGER is needed.
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

  -- (Removed again) public.profiles has no trips_completed column — that
  -- field lives on driver_profiles/passenger_profiles only, each already
  -- protected by its own privileged-columns trigger. This stale check was
  -- fixed once in password_reset_and_trips_completed_fix.sql, then
  -- accidentally reintroduced by terms_privacy_consent.sql's
  -- CREATE OR REPLACE of this same function. It must not come back a
  -- third time in any future edit of this function.

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

  -- Terms & Privacy consent (from terms_privacy_consent.sql): an audit
  -- record, not a togglable preference. A user CAN move from
  -- not-yet-accepted to accepted, but it can never be revoked
  -- (true -> false) by anyone but an admin, and the timestamp is always
  -- this server's clock, never a client-supplied value.
  IF OLD.terms_accepted = true AND NEW.terms_accepted = false THEN
    RAISE EXCEPTION 'terms_accepted cannot be revoked once granted';
  END IF;

  IF NEW.terms_accepted = true AND OLD.terms_accepted IS DISTINCT FROM true THEN
    NEW.terms_accepted_at := now();
  END IF;

  RETURN NEW;
END;
$function$;

-- The trigger itself already exists (trg_protect_profile_privileged_columns,
-- BEFORE UPDATE, from critical_security_fixes.sql) and points at this
-- function by name — CREATE OR REPLACE above is enough to pick up the fix,
-- no DROP/CREATE TRIGGER needed.

-- ============================================================================
-- Explicitly NOT done here, and why:
--
--   - apply_registration_consent() and log_terms_consent() (also defined in
--     terms_privacy_consent.sql): untouched, not implicated — the bug was
--     only ever in protect_profile_privileged_columns()'s stale field
--     reference, not in the registration/audit-trail triggers.
--
--   - audit_profile_admin_changes() (profiles_audit_trigger_autosave_fix.sql):
--     untouched. Its fix was safe and can stay; it just wasn't the actual
--     cause of this error.
--
--   - PART C/D of password_reset_and_trips_completed_fix.sql (the
--     complete_trip()/confirm_trip_completion()/auto_complete_pending_trips()
--     redirect to driver_profiles.trips_completed, and
--     protect_driver_profile_privileged_columns()'s system-update carve-out):
--     untouched — nothing since has redefined those functions, so that part
--     of the earlier fix is still intact.
-- ============================================================================
