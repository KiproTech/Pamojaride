-- ============================================================================
-- PamojaRide — Landing page redesign: public read access to support_contacts.
-- Run this once in the Supabase SQL Editor. Purely additive: it only adds
-- one new RLS policy and one new GRANT for the `anon` role. No table,
-- column, trigger, RPC, or existing policy is touched, dropped, replaced,
-- or altered. No data is touched.
-- ============================================================================
--
-- WHY THIS IS NEEDED:
--
--   admin_support_contacts_foundation.sql created public.support_contacts
--   with exactly two RLS policies: SELECT for the `authenticated` role only,
--   and UPDATE restricted to admins. That was correct for the Passenger/
--   Driver Help & Support pages (both live behind login), but the newly
--   redesigned public Landing page (src/pages/Landing.jsx) now also needs
--   to display these same contacts — via the same fetchSupportContacts()
--   used everywhere else — and a signed-out visitor's Supabase client
--   uses the `anon` role, not `authenticated`. Without this, the Landing
--   page's read would fail with 42501 "permission denied for table
--   support_contacts", the same class of bug fixed for `authenticated` in
--   support_contacts_grant_fix.sql.
--
-- WHAT THIS ADDS:
--
--   - A SELECT policy for `anon`, identical in effect to the existing
--     "authenticated users can view support contacts" policy: contact
--     details are PamojaRide's own public-facing support info (email,
--     phone, WhatsApp, Facebook, Twitter/X) — the same information already
--     shown on public marketing/social channels — so exposing it to
--     signed-out visitors carries no new risk. The UPDATE policy remains
--     admin-only and is completely untouched, so nobody's write access
--     changes.
--   - The matching GRANT SELECT for `anon`, since (as with the
--     `authenticated` fix) RLS policies are only ever consulted after the
--     base table-level privilege is granted.
-- ============================================================================

DROP POLICY IF EXISTS "public can view support contacts" ON public.support_contacts;
CREATE POLICY "public can view support contacts"
ON public.support_contacts FOR SELECT
TO anon
USING (true);

GRANT SELECT ON public.support_contacts TO anon;

-- Intentionally no INSERT/UPDATE/DELETE grant or policy for `anon` — this
-- migration only ever adds read access for the public Landing page. Writes
-- remain admin-only via the pre-existing "admin can update support
-- contacts" policy, unchanged.

-- ============================================================================
-- End of migration.
-- ============================================================================
