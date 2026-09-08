-- ============================================================================
-- PamojaRide — Admin-Managed Support Contacts (Foundation) — Prompt 9/20
-- Run this whole script once in the Supabase SQL Editor. Safe to run
-- multiple times: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, and
-- DROP POLICY/TRIGGER IF EXISTS + CREATE throughout. No existing table,
-- column, or row is dropped, truncated, or altered in a breaking way.
-- ============================================================================
--
-- SCOPE (Prompt 9/20 only):
--   A single, centrally-stored set of PamojaRide's own support contact
--   details (support email, support phone, WhatsApp number, Facebook,
--   Twitter/X) that Admin can manage from the app, so a future page can
--   read them instead of a hardcoded value. These are PamojaRide's own
--   system-wide contacts — NOT a passenger's or driver's personal contact
--   info, and NOT the existing `support_requests` ticket system
--   (database/customer_support_system.sql), which is untouched here.
--
--   Wiring these contacts into the Passenger/Driver Help & Support pages,
--   the Banned/Suspended/PendingApproval pages, and receipt/report PDFs
--   (all of which currently hardcode "support@pamojaride.co.ke") is
--   deliberately OUT of scope for this migration — that is Prompt 10/20.
--   This migration only builds the foundation: storage, admin write
--   access, and read access for later use.
--
-- WHAT THIS ADDS:
--
--   1. support_contacts — ONE new table, deliberately a single-row
--      ("singleton") table: id is fixed to 1 via a CHECK constraint, so
--      there is always exactly one current set of contacts, never a list
--      to pick from. Seeded with the support email already hardcoded
--      elsewhere in this project (support@pamojaride.co.ke) so the
--      starting value matches what's already live; every other field
--      starts blank until Admin fills it in.
--
--   2. A BEFORE UPDATE trigger that stamps updated_at/updated_by from
--      the server (now() / auth.uid()) on every save, ignoring whatever
--      a client might send for those two columns — the same
--      "server decides, client can't lie" pattern already used by
--      touch_support_request_updated_at() (customer_support_system.sql).
--
-- SECURITY:
--   - RLS is enabled on support_contacts with exactly two policies:
--     SELECT (any signed-in user — passenger, driver, or admin) and
--     UPDATE (admin only, re-checked both USING and WITH CHECK). There is
--     no INSERT and no DELETE policy for anyone — RLS defaults to deny,
--     so the single seeded row can never be duplicated or removed through
--     the app, only ever updated in place by an admin.
--   - No RLS is disabled anywhere. No existing RLS policy on any other
--     table is modified. No unrestricted write access is created.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. support_contacts — single-row table of PamojaRide's own support
--    contact details.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_contacts (
  id smallint NOT NULL DEFAULT 1,
  support_email text,
  support_phone text,
  whatsapp_number text,
  facebook_url text,
  twitter_url text,
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT support_contacts_pkey PRIMARY KEY (id),
  CONSTRAINT support_contacts_singleton_row CHECK (id = 1),
  CONSTRAINT support_contacts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id)
);

-- Seed the one-and-only row if it doesn't exist yet. Starting email
-- matches the value already hardcoded elsewhere in this project so
-- nothing changes for end users the moment this migration is wired up
-- in Prompt 10 — every other field starts blank for Admin to fill in.
INSERT INTO public.support_contacts (id, support_email)
VALUES (1, 'support@pamojaride.co.ke')
ON CONFLICT (id) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 2. Server-stamped updated_at / updated_by — mirrors the
--    touch_support_request_updated_at() pattern from
--    customer_support_system.sql; a client can never backdate a change
--    or attribute it to someone else.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_support_contacts_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  -- id is fixed to 1 by support_contacts_singleton_row; ignore any other
  -- value a client might try to send.
  NEW.id := 1;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_touch_support_contacts_updated_at ON public.support_contacts;
CREATE TRIGGER trg_touch_support_contacts_updated_at
BEFORE UPDATE ON public.support_contacts
FOR EACH ROW EXECUTE FUNCTION public.touch_support_contacts_updated_at();


-- ----------------------------------------------------------------------------
-- 3. RLS — any signed-in user can read; only admin can write; nobody can
--    insert a second row or delete the row.
-- ----------------------------------------------------------------------------

ALTER TABLE public.support_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated users can view support contacts" ON public.support_contacts;
CREATE POLICY "authenticated users can view support contacts"
ON public.support_contacts FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "admin can update support contacts" ON public.support_contacts;
CREATE POLICY "admin can update support contacts"
ON public.support_contacts FOR UPDATE
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- Intentionally no INSERT and no DELETE policy for anyone, including
-- admins — RLS defaults to deny, so the single row can only ever be
-- updated in place, never duplicated or removed through the app.

-- ============================================================================
-- End of migration.
-- ============================================================================
