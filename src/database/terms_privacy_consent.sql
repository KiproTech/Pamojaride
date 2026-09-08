-- ============================================================================
-- PamojaRide — Terms & Conditions / Privacy Policy: registration consent
-- Run this whole script once in the Supabase SQL Editor.
-- ============================================================================
--
-- WHAT THIS ADDS
--   1. Three new columns on public.profiles that record consent PER
--      IDENTITY (one profile row = one PamojaRide-wide agreement, covering
--      both the passenger and driver sides of a dual-role identity — this
--      project deliberately has ONE Terms & Conditions / Privacy Policy,
--      not a separate one per role):
--        - terms_accepted       boolean, defaults false
--        - terms_accepted_at    timestamptz, server-set, never client-set
--        - terms_version        text, e.g. '1.0'
--   2. A BEFORE INSERT trigger on public.profiles that reads the consent
--      fields PassengerRegister.jsx / DriverRegister.jsx send through
--      supabase.auth.signUp()'s `options.data` (the SAME mechanism this
--      project already uses to get full_name/phone/role onto a brand-new
--      profile row — see the existing handle_new_user trigger on
--      auth.users, which this migration does not touch or need to know the
--      body of). This works regardless of whether "confirm your email" is
--      turned on: raw_user_meta_data is written to auth.users at signUp()
--      call time either way, and profiles is created immediately either
--      way (per the existing comments in DriverRegister.jsx/
--      PassengerRegister.jsx: "the profile-creation trigger has already
--      run" even before email confirmation).
--   3. Extends the EXISTING protect_profile_privileged_columns() trigger
--      function (last redefined in profile_settings_hardening.sql — this
--      migration is a CREATE OR REPLACE of that same function, preserving
--      every rule it already enforces: is_admin, trips_completed,
--      phone_verified) so terms_accepted can move false -> true (that's
--      exactly what registration, and attaching a second role to an
--      existing identity, both legitimately do) but never true -> false
--      by a non-admin, and terms_accepted_at is always server time, never
--      a client-supplied value.
--   4. An audit trail: every time terms_accepted flips to true, a row is
--      written to the EXISTING public.audit_logs table (no new table),
--      so consent is independently auditable later even if a profile's
--      terms_version/terms_accepted_at were ever hypothetically edited by
--      an admin.
--
-- EXISTING USERS (do not break, no forced re-consent):
--   ADD COLUMN ... DEFAULT false is non-destructive and instantaneous —
--   every row that already exists gets terms_accepted = false,
--   terms_accepted_at = null, terms_version = null, and NOTHING in this
--   migration blocks login, blocks any route, or requires recreating an
--   account for those rows. The application layer (see
--   LegalConsentCard.jsx) shows existing users a soft, dismissible-by-
--   ignoring invitation to review and accept on their own Profile page;
--   it never gates access.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS terms_version text;

-- ----------------------------------------------------------------------------
-- Step 1: capture consent at the moment a brand-new profile row is created,
-- straight from the signUp() metadata — no second network round trip needed
-- for the common "new identity" registration path.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_registration_consent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_meta jsonb;
BEGIN
  SELECT raw_user_meta_data INTO v_meta FROM auth.users WHERE id = NEW.id;

  IF v_meta IS NOT NULL
     AND (v_meta->>'terms_accepted') IS NOT NULL
     AND (v_meta->>'terms_accepted')::boolean = true
  THEN
    NEW.terms_accepted := true;
    NEW.terms_accepted_at := now();
    NEW.terms_version := v_meta->>'terms_version';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_apply_registration_consent ON public.profiles;
CREATE TRIGGER trg_apply_registration_consent
BEFORE INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.apply_registration_consent();

-- ----------------------------------------------------------------------------
-- Step 2: protect the consent columns the same way every other
-- integrity-sensitive profiles column is already protected. This is a
-- CREATE OR REPLACE of the EXISTING function (last defined in
-- profile_settings_hardening.sql) — every prior rule is copied verbatim
-- below, nothing removed, only the new terms_* block is added. The trigger
-- itself (trg_protect_profile_privileged_columns, BEFORE UPDATE) already
-- exists and points at this function by name, so no DROP/CREATE TRIGGER is
-- needed here.
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

  -- Terms & Privacy consent: an audit record, not a togglable preference.
  -- A user CAN move from not-yet-accepted to accepted — that's exactly
  -- what registration, and attaching a second role (driver/passenger) to
  -- an already-registered identity, both legitimately do via a plain
  -- client-side update() from PassengerRegister.jsx / DriverRegister.jsx,
  -- and it's also exactly what an existing (pre-feature) user does when
  -- they voluntarily accept from LegalConsentCard.jsx on their Profile
  -- page. It can never be revoked (true -> false) by anyone but an admin,
  -- and the timestamp is always this server's clock, never whatever the
  -- client sends — so it can't be backdated or forward-dated.
  IF OLD.terms_accepted = true AND NEW.terms_accepted = false THEN
    RAISE EXCEPTION 'terms_accepted cannot be revoked once granted';
  END IF;

  IF NEW.terms_accepted = true AND OLD.terms_accepted IS DISTINCT FROM true THEN
    NEW.terms_accepted_at := now();
  END IF;

  RETURN NEW;
END;
$function$;

-- ----------------------------------------------------------------------------
-- Step 3: audit trail — reuse the existing audit_logs table. Fires once,
-- the moment a profile's consent actually transitions to true (covers both
-- the INSERT-time path from Step 1 and the UPDATE-time path an existing
-- user or a dual-role signup takes).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_terms_consent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.terms_accepted = true
     AND (TG_OP = 'INSERT' OR OLD.terms_accepted IS DISTINCT FROM true)
  THEN
    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, new_value)
    VALUES (
      NEW.id,
      'terms_privacy_consent_accepted',
      'profiles',
      NEW.id,
      jsonb_build_object(
        'terms_version', NEW.terms_version,
        'terms_accepted_at', NEW.terms_accepted_at
      )
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_terms_consent ON public.profiles;
CREATE TRIGGER trg_log_terms_consent
AFTER INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.log_terms_consent();

-- Helpful for admin/audit lookups ("who hasn't accepted the latest
-- version yet") without a full table scan.
CREATE INDEX IF NOT EXISTS idx_profiles_terms_accepted
  ON public.profiles (terms_accepted);
-- ============================================================================
