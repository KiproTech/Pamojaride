-- ============================================================================
-- PamojaRide — persistent, resumable driver verification progress
-- ============================================================================
-- CONTEXT: builds on the existing driver_profiles.verification_status flow
-- (db.sql), the document storage/RLS setup (verification_storage.sql), the
-- vehicle/face-verification columns (vehicle_face_verification_upgrade.sql),
-- and the explicit driver/admin UPDATE policies (driver_approval_admin_policy.sql).
-- Run this AFTER all of those. Idempotent — safe to re-run.
--
-- WHAT THIS ADDS: exactly one new column, `verification_step`, which records
-- which step of the 5-step wizard (0=Personal, 1=Vehicle, 2=Documents,
-- 3=Face Verification, 4=Confirm) the driver should resume on. Nothing else
-- needs to change:
--
--   - "Draft" vs "In Progress" vs "Pending Review" is ALREADY modelled by
--     the existing verification_status column: a driver actively filling
--     in (or partway through) the form sits at verification_status =
--     'pending' the entire time — it only ever flips to
--     'pending_verification' on final, explicit submission, exactly as
--     protect_driver_profile_privileged_columns() already enforces. No new
--     status values are introduced, and no existing values change meaning.
--
--   - Partial per-step data ALREADY has dedicated columns for almost
--     everything the wizard collects (licence_number, licence_expiry,
--     vehicle_make/model/year/color/plate/seats/type, kyc_documents on
--     driver_profiles; national_id, emergency_contact_name/phone on
--     profiles) — this migration does not duplicate any of that into a
--     separate "draft" blob. The application now simply writes to these
--     same columns incrementally, per step, instead of once at the end.
--
--   - No trigger change is required. protect_driver_profile_privileged_
--     columns() (verification_storage.sql / vehicle_face_verification_
--     upgrade.sql) only restricts verification_status, account_status, and
--     a short explicit list of admin-only fields (trust_level,
--     kyc_approved_at, kyc_rejection_reason, etc). It does NOT touch
--     verification_step, kyc_documents, or any of the vehicle/licence
--     columns above — those remain freely writable by the row owner via
--     the existing "drivers can update own profile" RLS policy
--     (profile_id = auth.uid()), which is exactly what incremental
--     per-step/autosave persistence needs. Nothing here weakens or
--     bypasses that trigger.
-- ============================================================================

-- ── 1. driver_profiles: one new column, safely defaulted ───────────────────
-- DEFAULT 0 means every existing row (every driver who has never seen this
-- feature) is backfilled to "resume at Step 1 (Personal)" — identical to
-- today's behaviour, where the wizard always opens on step 0. No existing
-- driver data (licence/vehicle/kyc_documents/verification_status/etc.) is
-- touched, read, or reinterpreted by this migration.
ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS verification_step smallint NOT NULL DEFAULT 0;

-- 0..4 inclusive — one entry per wizard step (Personal, Vehicle, Documents,
-- Face Verification, Confirm). Re-created idempotently so re-running this
-- file is always safe.
ALTER TABLE public.driver_profiles
  DROP CONSTRAINT IF EXISTS driver_profiles_verification_step_range;
ALTER TABLE public.driver_profiles
  ADD CONSTRAINT driver_profiles_verification_step_range
  CHECK (verification_step BETWEEN 0 AND 4);

COMMENT ON COLUMN public.driver_profiles.verification_step IS
  'Which step (0=Personal, 1=Vehicle, 2=Documents, 3=Face Verification, '
  '4=Confirm) an in-progress driver should resume the verification wizard '
  'on. Only ever moves forward for a given driver (see application code); '
  'has no bearing on completion — verification_status is still the single '
  'source of truth for draft/in-progress vs pending-review vs '
  'approved/rejected.';

-- Speeds up any admin-side "how far along is this driver" queries
-- (e.g. an incomplete-applications report), same pattern as the existing
-- verification_status / (verification_status, account_status) indexes.
CREATE INDEX IF NOT EXISTS idx_driver_profiles_verification_step
  ON public.driver_profiles (verification_step);

-- ── 2. RLS: re-assert that a driver can read their OWN row ─────────────────
-- Every other migration in this project re-asserts its RLS policies
-- idempotently rather than assuming a policy discovered via prior live
-- introspection is still present under the same name (see the reasoning at
-- the top of driver_approval_admin_policy.sql) — this does the same for
-- SELECT. Resuming the wizard requires the driver to be able to read back
-- their own verification_step/kyc_documents/etc., and critical_security_
-- fixes.sql intentionally narrowed driver_profiles SELECT to admin-only,
-- so this explicitly restores the driver's own-row access alongside it.
-- Postgres OR's multiple permissive policies together, so at worst this is
-- a harmless duplicate of a same-effect policy that already exists under a
-- different name.
DROP POLICY IF EXISTS "drivers can read own profile" ON public.driver_profiles;
CREATE POLICY "drivers can read own profile"
ON public.driver_profiles FOR SELECT
TO authenticated
USING (profile_id = auth.uid());

-- ============================================================================
-- Explicitly NOT done here, and why:
--
--   - No new "draft" table or jsonb blob: every field the wizard collects
--     already has a real column (see above), so a driver's own row IS the
--     draft — no duplicate storage to keep in sync or garbage-collect.
--
--   - No change to how a verification gets marked Pending Review: that
--     still only happens via submitDriverVerification() in the
--     application, which is still the only non-admin path allowed to move
--     verification_status away from 'pending'/'rejected', per the
--     unmodified trigger.
--
--   - No destructive backfill: existing driver_profiles rows keep every
--     column exactly as they are; verification_step is simply appended
--     with a safe default.
-- ============================================================================
