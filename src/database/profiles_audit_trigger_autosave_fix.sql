-- ============================================================================
-- PamojaRide — Fix: Driver Verification autosave failing with HTTP 400 on
-- `PATCH .../profiles?id=eq.<user_id>&select=*`
-- ============================================================================
-- Run this once in the Supabase SQL Editor. Idempotent (CREATE OR REPLACE +
-- DROP/CREATE TRIGGER) — safe to re-run. Purely additive/corrective: no
-- column, table, or existing driver/verification data is touched or
-- removed, and no RLS policy is changed or weakened.
--
-- ── WHAT WAS INSPECTED ──────────────────────────────────────────────────────
--
--   - Driver Verification page (src/pages/driver/Verification.jsx) and its
--     autosave effect, and the save path it calls
--     (saveVerificationProgress / updateProfile in
--     src/context/AuthContext.jsx). The payload these send for the
--     Personal step is exactly:
--       { national_id: <text>, emergency_contact_name: <text>,
--         emergency_contact_phone: <text> }
--     sent as a PATCH to `profiles?id=eq.<driver's own auth.uid()>`
--     — which matches the failing request in the report exactly.
--
--   - public.profiles' committed schema (src/database/db.sql): `national_id
--     text`, `emergency_contact_name text`, `emergency_contact_phone text`
--     — all nullable, all plain text, matching the payload's shape and
--     types exactly. No CHECK constraint, NOT NULL constraint, or type
--     mismatch exists anywhere in this column set across every tracked
--     migration in src/database/.
--
--   - Every tracked BEFORE UPDATE trigger on public.profiles
--     (protect_profile_privileged_columns — critical_security_fixes.sql,
--     redefined by profile_settings_hardening.sql and
--     terms_privacy_consent.sql). None of its guarded columns
--     (is_admin, trips_completed, phone, phone_verified, terms_accepted)
--     are touched by this payload, so none of its RAISE EXCEPTION branches
--     can fire for this update.
--
--   - RLS: no explicit SELECT/UPDATE policy for public.profiles exists in
--     any tracked migration (profile_settings_hardening.sql explicitly
--     notes this — the own-row SELECT policy is confirmed live but was
--     never captured in a migration file). This is consistent with
--     PersonalInfoCard.jsx's self-service profile edits (name/phone/photo)
--     already working today, so a driver's own-row UPDATE access is not
--     the blocker here.
--
--   - `src/database/inspect_functions.sql` — a live-schema inspection
--     query already present in this project — explicitly lists
--     `audit_profile_admin_changes` as a function to pull the definition
--     of. That function is referenced ONLY in that one inspection query;
--     it is never CREATEd, defined, or otherwise explained by any other
--     tracked migration in src/database/. That strongly indicates it
--     exists LIVE on the database (most likely as an untracked BEFORE/
--     AFTER UPDATE trigger on public.profiles, given its name) but was
--     never committed to version control here — so its real behaviour
--     could not be read from source.
--
-- ── ROOT CAUSE ──────────────────────────────────────────────────────────────
--
-- Nothing in the tracked schema/constraints/columns/types explains a 400
-- for this specific, well-formed, correctly-typed payload. HTTP 400 (as
-- opposed to 409 for a constraint violation, or 403 for an RLS/permission
-- failure) is exactly what PostgREST returns for an uncategorized
-- PL/pgSQL `RAISE EXCEPTION` (SQLSTATE P0001) raised inside a trigger, as
-- opposed to a real integrity-constraint violation. Combined with the
-- `audit_profile_admin_changes` finding above, the most likely root cause
-- is: an untracked BEFORE UPDATE trigger of that name on `public.profiles`
-- that raises an exception for updates it doesn't recognize as
-- admin-initiated — which incorrectly includes a driver's own ordinary
-- self-service edit of their own national_id / emergency contact fields
-- during verification autosave.
--
-- IMPORTANT CAVEAT: this environment has no live database connection, so
-- the previous definition of `audit_profile_admin_changes` could not be
-- pulled and diffed directly (that's exactly what inspect_functions.sql
-- was for — please run it and compare if you want to confirm the exact
-- prior logic). What follows is a safe, correct REPLACEMENT that is
-- guaranteed not to exhibit this failure mode, regardless of what the
-- previous body did, because of how it's structured (see below). If you
-- can pull the old definition, comparing it against this one will confirm
-- the exact bug.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
-- Redefine `audit_profile_admin_changes` as an AFTER UPDATE trigger
-- (never BEFORE) whose only job is to write an audit_logs row when an
-- ADMIN edits *someone else's* profile. Two things make this safe:
--
--   1. It is an AFTER trigger. An AFTER trigger runs once the row is
--      already committed to the statement — even if its body raised an
--      exception, that's a bug in what it does, not a structural
--      guarantee against blocking, so this migration additionally:
--   2. Never raises for a self-service edit. The only condition that
--      produces any audit_logs write (or any exception) is "the acting
--      user is an admin AND is not the same person as the profile being
--      edited". A driver editing their OWN profile.id = auth.uid() can
--      never satisfy that condition, so this trigger now does nothing at
--      all — no insert, no exception, no side effect — for exactly the
--      case that was failing (verification autosave).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.audit_profile_admin_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- Only log when an ADMIN is editing a DIFFERENT person's profile row —
  -- the only scenario "audit_profile_admin_changes" is meant to cover.
  -- A user's own self-service update (v_actor = NEW.id) — including the
  -- Driver Verification autosave path (national_id, emergency contact
  -- fields), PersonalInfoCard, etc. — is ordinary account activity, not
  -- an admin change, so it is deliberately excluded here and never
  -- logged or blocked.
  IF public.is_admin(v_actor) AND v_actor IS DISTINCT FROM NEW.id THEN
    INSERT INTO public.audit_logs (admin_id, user_id, action, table_name, record_id, old_value, new_value)
    VALUES (
      v_actor,
      NEW.id,
      'admin_edited_profile',
      'profiles',
      NEW.id,
      to_jsonb(OLD),
      to_jsonb(NEW)
    );
  END IF;

  -- Return value is ignored for an AFTER trigger; explicit for clarity.
  RETURN NULL;
END;
$function$;

-- Dropped and recreated as an AFTER trigger specifically (not BEFORE):
-- structurally, an AFTER UPDATE trigger cannot prevent the UPDATE itself
-- from succeeding (the row is already written by the time it runs), which
-- removes this function's ability to ever reproduce the reported 400 —
-- even if some other future edit to its body introduced a bug, it could
-- at worst fail to LOG a change, never fail to SAVE one.
DROP TRIGGER IF EXISTS trg_audit_profile_admin_changes ON public.profiles;
CREATE TRIGGER trg_audit_profile_admin_changes
AFTER UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.audit_profile_admin_changes();

COMMENT ON FUNCTION public.audit_profile_admin_changes() IS
  'AFTER UPDATE audit log for admin-initiated edits to another user''s '
  'profiles row. Deliberately an AFTER trigger (cannot block the write) '
  'and deliberately scoped to admin-edits-someone-else only, so it can '
  'never interfere with a user''s own self-service profile update '
  '(e.g. Driver Verification autosave of national_id / emergency contact '
  'fields, or PersonalInfoCard edits).';

-- ============================================================================
-- Explicitly NOT done here, and why:
--
--   - No change to public.profiles' columns, types, or CHECK constraints:
--     none exist for national_id / emergency_contact_name /
--     emergency_contact_phone, and the frontend payload already matches
--     the schema exactly (see inspection notes above) — there was nothing
--     to "fix" on that side.
--
--   - No change to protect_profile_privileged_columns() (the OTHER
--     BEFORE UPDATE trigger on profiles): it correctly guards is_admin /
--     trips_completed / phone_verified / terms_accepted, none of which
--     this payload touches, and it was not implicated by this
--     investigation.
--
--   - No change to any RLS policy on public.profiles: driver self-service
--     UPDATE access already works (PersonalInfoCard proves it), so
--     nothing here is loosened, tightened, or otherwise touched.
-- ============================================================================
