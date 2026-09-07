-- ============================================================================
-- PamojaRide — Registration: RLS hardening for the "attach a second role to
-- an existing identity" flow (defense-in-depth)
-- ============================================================================
--
-- CONTEXT: PassengerRegister.jsx and DriverRegister.jsx both handle the case
-- where someone registers with an email that already has an identity under
-- the OTHER role (e.g. an existing driver signs up as a passenger too). In
-- that case they never call auth.signUp a second time — they sign in to the
-- existing identity and run a plain client-side insert:
--
--   supabase.from('passenger_profiles').insert({ profile_id: existingUser.id })
--   supabase.from('driver_profiles').insert({ profile_id: existingUser.id })
--
-- Every other migration in this project was written against live
-- introspection; I do not have live database access in this task to confirm
-- an INSERT policy already exists for this. Postgres RLS defaults to DENY
-- with no matching policy, so if one doesn't already exist, this exact flow
-- is currently broken for real users. This migration is idempotent
-- (DROP/CREATE) and scoped tightly, so it's safe to run whether or not an
-- equivalent policy already exists under a different name.
--
-- SECURITY: WITH CHECK (profile_id = auth.uid()) means a signed-in user can
-- only ever insert a role row for THEIR OWN identity — never for anyone
-- else's. Every column on driver_profiles/passenger_profiles besides
-- profile_id defaults (verification_status defaults to 'pending' at the DB
-- level per db.sql; account_status defaults to 'active'; is_admin doesn't
-- exist on these tables at all, only on profiles, which this migration does
-- not touch). So this can never be used to create a pre-verified driver, a
-- pre-approved anything, or an admin account — it only ever creates the same
-- bare, unverified/pending row the signup trigger itself creates for a
-- brand-new identity.
-- ============================================================================

DROP POLICY IF EXISTS "users can attach own passenger profile" ON public.passenger_profiles;
CREATE POLICY "users can attach own passenger profile"
ON public.passenger_profiles FOR INSERT
TO authenticated
WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS "users can attach own driver profile" ON public.driver_profiles;
CREATE POLICY "users can attach own driver profile"
ON public.driver_profiles FOR INSERT
TO authenticated
WITH CHECK (profile_id = auth.uid());

-- SELECT is intentionally untouched here: passenger_profiles already grants
-- read access for a user's own row, and driver_profiles' own-row SELECT
-- (narrowed to admin-only by critical_security_fixes.sql for the PII leak,
-- then explicitly restored for the driver's own row by
-- verification_progress_persistence.sql's "drivers can read own profile"
-- policy) is unaffected by this migration. This file only adds the missing
-- INSERT grant needed for the dual-role-attach path above.
-- ============================================================================
