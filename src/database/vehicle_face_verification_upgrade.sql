-- ============================================================================
-- PamojaRide — Simplified driver verification + vehicle type + face verification
-- ============================================================================
-- CONTEXT: builds on the existing driver_profiles.verification_status flow
-- and the driver-documents storage/RLS setup from verification_storage.sql.
-- Run AFTER db.sql (base schema), verification_storage.sql, and
-- driver_approval_admin_policy.sql. Idempotent — safe to re-run.
--
-- WHAT'S REUSED, NOT DUPLICATED:
--   - Vehicle photo and the face-verification capture are stored as two
--     more entries in the EXISTING driver_profiles.kyc_documents jsonb
--     array (same {type, path, file_name, size, mime_type, uploaded_at}
--     shape, same 'driver-documents' storage bucket, same RLS policies).
--     No new table or storage bucket needed for either.
--   - vehicle_make / vehicle_model / vehicle_color remain the existing
--     plain-text columns — the new "dropdown → Other → manual" behaviour
--     is a frontend-only UX layer over the same free-text columns.
-- ============================================================================

-- ── 1. Vehicle types: lookup table, not a hardcoded enum ───────────────────
-- Deliberately a table rather than a CHECK-constrained enum column: adding
-- "Van", "Minibus", "Bus", etc. later is an INSERT, never a migration.
CREATE TABLE IF NOT EXISTS public.vehicle_types (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamp with time zone DEFAULT now()
);

INSERT INTO public.vehicle_types (code, label, sort_order) VALUES
  ('private_car', 'Private Car', 1),
  ('other',       'Other',       99)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.vehicle_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone authenticated can read vehicle types" ON public.vehicle_types;
CREATE POLICY "anyone authenticated can read vehicle types"
ON public.vehicle_types FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "admin can manage vehicle types" ON public.vehicle_types;
CREATE POLICY "admin can manage vehicle types"
ON public.vehicle_types FOR ALL
TO authenticated
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- ── 2. driver_profiles: new columns ─────────────────────────────────────────
ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS vehicle_type text NOT NULL DEFAULT 'private_car',
  ADD COLUMN IF NOT EXISTS vehicle_type_other text,
  ADD COLUMN IF NOT EXISTS face_verification_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS face_verification_captured_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS accuracy_confirmed_at timestamp with time zone;

-- face_verification_image_path is intentionally NOT a separate column —
-- the capture is stored as a normal entry in kyc_documents (type =
-- 'face_verification'), same as the vehicle photo and every paper
-- document, so admin review already picks it up with zero extra code.
-- (See KYCReviewer.jsx, which reads driver.kyc_documents generically.)

DO $$ BEGIN
  ALTER TABLE public.driver_profiles
    ADD CONSTRAINT driver_profiles_vehicle_type_fkey
    FOREIGN KEY (vehicle_type) REFERENCES public.vehicle_types(code);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.driver_profiles
  DROP CONSTRAINT IF EXISTS driver_profiles_face_verification_status_check;
ALTER TABLE public.driver_profiles
  ADD CONSTRAINT driver_profiles_face_verification_status_check
  CHECK (face_verification_status IN ('not_started', 'captured', 'approved', 'rejected'));

-- ── 3. Passenger seats: 1–100, not the old implicit 1–7 dropdown ceiling ───
-- db.sql shows vehicle_seats had NO existing range constraint at all (the
-- 1–7 limit lived only in the old frontend <select>), so this is a new
-- addition, not a widening of an existing one.
ALTER TABLE public.driver_profiles
  DROP CONSTRAINT IF EXISTS driver_profiles_vehicle_seats_range;
ALTER TABLE public.driver_profiles
  ADD CONSTRAINT driver_profiles_vehicle_seats_range
  CHECK (vehicle_seats IS NULL OR (vehicle_seats BETWEEN 1 AND 100));

-- ── 4. licence_class: deprecated, not deleted ───────────────────────────────
-- Already nullable in db.sql (no NOT NULL constraint), so no ALTER is
-- needed to stop requiring it — the frontend and submitDriverVerification()
-- simply stop sending it. Historical values are left exactly as they are.
COMMENT ON COLUMN public.driver_profiles.licence_class IS
  'Deprecated: no longer collected by the driver verification form as of the vehicle/face-verification simplification. Retained only for historical submissions made before this change — do not require or display for new submissions.';

-- ── 5. Indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_driver_profiles_vehicle_type ON public.driver_profiles (vehicle_type);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_face_verification_status ON public.driver_profiles (face_verification_status);

-- ── 6. Trigger: extend the existing privileged-columns guard ───────────────
-- Same function as verification_storage.sql, redefined (CREATE OR REPLACE
-- on the identical name/signature — no new trigger, no trigger drop/recreate
-- needed since the CREATE TRIGGER statement pointing at this function
-- already exists). Adds ONE new rule: a driver may move their own
-- face_verification_status to 'captured' (that's just "I recorded a new
-- capture"), but never directly to 'approved' or 'rejected' — those are
-- admin-only decisions, applied via DriverReview.jsx's approve/reject
-- actions, which bypass this whole function anyway via the is_admin(...)
-- check at the top. Everything else is unchanged from verification_storage.sql.
CREATE OR REPLACE FUNCTION public.protect_driver_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_driver_kyc_submission boolean;
begin
  if public.is_admin(auth.uid()) then
    return new;
  end if;

  v_is_driver_kyc_submission := (
    auth.uid() = old.profile_id
    and old.verification_status in ('pending', 'active', 'rejected')
    and new.verification_status = 'pending_verification'
  );

  if new.verification_status is distinct from old.verification_status then
    if not v_is_driver_kyc_submission then
      raise exception 'Only an administrator may change verification_status (the sole exception is a driver submitting KYC documents)';
    end if;
    new.kyc_submitted_at := now();
    new.kyc_attempts := coalesce(old.kyc_attempts, 0) + 1;
  end if;

  if new.face_verification_status is distinct from old.face_verification_status then
    if new.face_verification_status not in ('captured', 'not_started') then
      raise exception 'Only an administrator may approve or reject face verification';
    end if;
    new.face_verification_captured_at := now();
  end if;

  if new.account_status is distinct from old.account_status then
    raise exception 'Only an administrator may change account_status';
  end if;

  if new.trust_level          is distinct from old.trust_level
     or new.max_seats_per_trip   is distinct from old.max_seats_per_trip
     or new.max_active_trips     is distinct from old.max_active_trips
     or new.payout_delay_hours   is distinct from old.payout_delay_hours
     or new.trips_completed      is distinct from old.trips_completed
     or new.dispute_count        is distinct from old.dispute_count
     or new.flagged_for_review   is distinct from old.flagged_for_review
     or new.suspension_reason    is distinct from old.suspension_reason
     or new.kyc_approved_at      is distinct from old.kyc_approved_at
     or new.kyc_approved_by      is distinct from old.kyc_approved_by
     or new.kyc_rejection_reason is distinct from old.kyc_rejection_reason
  then
    raise exception 'Only an administrator may change privileged driver profile fields';
  end if;

  return new;
end;
$function$;

-- ============================================================================
-- Nothing to change in is_verified_driver() / trips_insert_verified_driver —
-- both key off verification_status = 'verified', which this migration
-- doesn't touch the meaning of. A driver still can't post a trip until an
-- admin sets verification_status = 'verified', exactly as before.
-- ============================================================================
