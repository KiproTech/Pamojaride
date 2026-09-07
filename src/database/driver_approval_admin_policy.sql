-- ============================================================================
-- PamojaRide — driver approval: explicit admin UPDATE policy (defense-in-depth)
-- ============================================================================
-- CONTEXT: this project already has a complete driver-approval system —
-- driver_profiles.verification_status (pending -> pending_verification ->
-- verified/rejected, defaulting to 'pending' per db.sql), the
-- protect_driver_profile_privileged_columns() trigger (verification_storage.sql)
-- which already lets an admin (is_admin(auth.uid())) change
-- verification_status/kyc_approved_at/kyc_approved_by/kyc_rejection_reason
-- freely while blocking everyone else, and a working admin approve/reject UI
-- in src/pages/admin/DriverReview.jsx that has clearly been exercising this
-- path already. NO new column, table, or field is needed for this feature —
-- reusing verification_status is exactly what db.sql's `approval_status`-style
-- field already is under a different name.
--
-- WHAT THIS FILE ACTUALLY DOES: the privileged-columns trigger only decides
-- what an admin is ALLOWED to change once an UPDATE row-lock is already being
-- attempted -- it does not, by itself, grant admins permission to reach
-- driver_profiles rows for UPDATE at the RLS layer. That permission has to
-- come from a USING/WITH CHECK policy. The other migrations in this project
-- were written against live introspection and found this project already had
-- one; I do not have live database access to confirm it's still there or
-- still named/scoped the same way, so this migration re-asserts it explicitly
-- and idempotently. Safe to run whether or not an equivalent policy already
-- exists under a different name -- Postgres OR's multiple permissive
-- policies together, so at worst you'll have a harmless duplicate (which you
-- can find and drop later via `select policyname from pg_policies where
-- tablename = 'driver_profiles'`).
-- ============================================================================

DROP POLICY IF EXISTS "admin can update driver profiles" ON public.driver_profiles;
CREATE POLICY "admin can update driver profiles"
ON public.driver_profiles FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- Driver's own row -- needed for KYC submission (AuthContext.submitDriverVerification)
-- and any other self-service field a driver is allowed to edit. The
-- trigger already restricts WHICH columns/values a non-admin update may
-- touch; this policy just grants reaching the row at all. Same
-- idempotent/defense-in-depth reasoning as above.
DROP POLICY IF EXISTS "drivers can update own profile" ON public.driver_profiles;
CREATE POLICY "drivers can update own profile"
ON public.driver_profiles FOR UPDATE
TO authenticated
USING (profile_id = auth.uid())
WITH CHECK (profile_id = auth.uid());

-- Composite index to speed up the admin User Management / Driver Review
-- screens, which now both filter/sort on verification_status alongside
-- account_status (e.g. "pending drivers that are also active"). The plain
-- verification_status index already exists (verification_storage.sql);
-- this adds the pair.
CREATE INDEX IF NOT EXISTS idx_driver_profiles_verification_account_status
  ON public.driver_profiles (verification_status, account_status);
