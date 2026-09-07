-- ============================================================================
-- PamojaRide — Registration validation: optional DB-side defense-in-depth
-- for the two-name requirement.
-- ============================================================================
--
-- IS THIS REQUIRED? No. The task's actual validation (full name shape,
-- email format, required fields, password confirmation, password
-- requirements) is enforced client-side in src/lib/validation.js, called
-- from both PassengerRegister.jsx and DriverRegister.jsx before anything is
-- sent to Supabase Auth. Supabase Auth itself remains the source of truth
-- for email format/uniqueness and password acceptance — nothing here
-- duplicates or replaces that, and this migration adds no password
-- storage of any kind.
--
-- This file is OPTIONAL, additional hardening, offered because every other
-- validated field in this codebase (report relationships, booking/trip
-- status transitions, KYC field changes) is ALSO enforced at the database
-- layer, not just in the React form — the project's own established
-- pattern is "client-side checks are UX, the database is the real guard"
-- (see RatingModal.jsx's comment on validate_rating_participant(), and
-- report_relationship_and_duplicate_hardening.sql). Run this only if you
-- want that same guarantee for full_name; skip it if you'd rather keep
-- this validated in one place (the React form) for now.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT:
-- A CHECK constraint on profiles.full_name would run on every INSERT *and*
-- every UPDATE of a row — including unrelated updates (e.g. a passenger
-- changing their phone number) — and this project's live `profiles` table
-- may already contain rows created before this task (single-name or
-- otherwise messy historical data is realistic for any pre-existing user
-- base). A CHECK constraint would silently start rejecting THOSE users'
-- next unrelated profile update, which would violate "preserve all
-- existing functionality." A BEFORE INSERT trigger only ever runs for a
-- brand-new row, so it enforces the rule for every new registration going
-- forward without touching, validating, or being able to break any
-- existing profile. Safe to run at any time, regardless of what's already
-- in the table.
--
-- Mirrors the same normalization/parts-check as src/lib/validation.js
-- (collapse whitespace, split on spaces, require >= 2 non-empty parts) so
-- the two layers can never disagree about what counts as a valid name.
-- Safe to run multiple times (CREATE OR REPLACE + DROP/CREATE TRIGGER).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_profile_full_name()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_normalized text;
  v_parts text[];
BEGIN
  v_normalized := btrim(regexp_replace(NEW.full_name, '\s+', ' ', 'g'));
  v_parts := regexp_split_to_array(v_normalized, ' ');

  -- regexp_split_to_array('', ' ') returns {''} (one empty element), not an
  -- empty array, so an empty/whitespace-only name must be checked
  -- separately rather than relying on array_length alone.
  IF v_normalized = '' OR array_length(v_parts, 1) < 2 THEN
    RAISE EXCEPTION 'full_name must include at least a first and last name (e.g. "John Kamau")'
      USING ERRCODE = '23514'; -- check_violation, same code a CHECK constraint would raise
  END IF;

  -- Store the same normalized (whitespace-collapsed, trimmed) form the
  -- application already computes, so the stored value is consistent
  -- regardless of what inserted the row.
  NEW.full_name := v_normalized;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_profile_full_name ON public.profiles;
CREATE TRIGGER trg_validate_profile_full_name
BEFORE INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.validate_profile_full_name();

-- Deliberately BEFORE INSERT only (see above) — no BEFORE UPDATE trigger is
-- added, so editing any other profile field later (phone, profile picture,
-- emergency contact, etc.) is completely unaffected, even for a historical
-- row whose full_name wouldn't pass this check today.
-- ============================================================================
