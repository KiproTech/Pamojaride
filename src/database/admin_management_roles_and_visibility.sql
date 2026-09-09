-- ============================================================================
-- PamojaRide — Admin Management & Admin Roles, Profile Picture visibility
-- gaps, and Driver Verification role enforcement.
-- Run this whole script once in the Supabase SQL Editor.
-- ============================================================================
--
-- CONTEXT (found via inspection of src/database/*.sql and the live app):
--
--   Today there is exactly ONE admin concept: profiles.is_admin boolean.
--   Every admin who has it can do everything an admin can do — there is no
--   role tier, no way to add a new admin except by hand-flipping is_admin
--   in the DB, and no way to deactivate one admin without touching that
--   row directly. This migration adds a proper admin-roles layer ON TOP of
--   the existing is_admin flag (never replacing it), following the exact
--   same "identity in profiles, role-specific data in its own table"
--   pattern already used for driver_profiles / passenger_profiles.
--
--   It also closes two small profile-picture visibility gaps found in
--   Part 2 (driver → passenger photo on Bookings, admin → user photo on
--   User Management) and adds real backend enforcement for the
--   "Verification Admin" role on the one action explicitly called out in
--   the spec (driver KYC approve/reject), without touching the broader
--   admin update policies used for suspend/ban (support-type actions),
--   so no existing legitimate admin loses access.
--
-- NON-GOALS / WHAT THIS DELIBERATELY DOES NOT TOUCH:
--   - profiles.is_admin stays the single "is this identity an admin at
--     all" gate used by every existing RLS policy in the project — every
--     one of those policies keeps working unchanged.
--   - Suspend/ban of drivers/passengers (UserManagement.jsx) stays on the
--     existing broad "any admin" policies — that's general/support admin
--     territory, not verification-specific, and narrowing it risks
--     locking out legitimate admins the task says not to break.
--   - No Supabase Edge Function / service-role key is introduced (none
--     exists in this project). Creating a new admin is done via a
--     database-backed INVITATION the new admin accepts themselves by
--     setting their own password — the inviting admin never sees or sets
--     a credential for them, mirroring how every other account in this
--     app is created (self-service signUp), just gated by an invitation.
-- ============================================================================


-- ============================================================================
-- 1. admin_profiles — role/status for admin identities, same shape as
--    driver_profiles / passenger_profiles.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admin_profiles (
  profile_id uuid NOT NULL,
  admin_role text NOT NULL DEFAULT 'admin'
    CHECK (admin_role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'verification_admin'::text, 'support_admin'::text, 'reports_admin'::text])),
  account_status text NOT NULL DEFAULT 'active'
    CHECK (account_status = ANY (ARRAY['active'::text, 'deactivated'::text])),
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT admin_profiles_pkey PRIMARY KEY (profile_id),
  CONSTRAINT admin_profiles_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id),
  CONSTRAINT admin_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_profiles_role ON public.admin_profiles (admin_role);
CREATE INDEX IF NOT EXISTS idx_admin_profiles_status ON public.admin_profiles (account_status);

-- keep updated_at current, same convention as the rest of the schema
CREATE OR REPLACE FUNCTION public.touch_admin_profiles_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_admin_profiles_updated_at ON public.admin_profiles;
CREATE TRIGGER trg_admin_profiles_updated_at
BEFORE UPDATE ON public.admin_profiles
FOR EACH ROW EXECUTE FUNCTION public.touch_admin_profiles_updated_at();

-- Backfill: every existing admin (profiles.is_admin = true) becomes a
-- super_admin, active. This is the safety-critical line for "do not
-- accidentally remove access from existing legitimate administrators" —
-- every admin who could do everything yesterday can still do everything
-- today.
INSERT INTO public.admin_profiles (profile_id, admin_role, account_status)
SELECT p.id, 'super_admin', 'active'
FROM public.profiles p
WHERE p.is_admin = true
ON CONFLICT (profile_id) DO NOTHING;

ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;

-- RLS policies only filter WHICH rows a role can see/touch -- Postgres
-- still requires the underlying table-level privilege before RLS is even
-- consulted. New tables are granted to no one but the owner by default,
-- so without this, every request from the app (running as `authenticated`)
-- fails with `permission denied for table admin_profiles` (42501) before
-- the policies below ever get a chance to run.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_profiles TO authenticated;


-- ============================================================================
-- 2. Role-checking helper functions
-- ============================================================================

-- Current admin_role for uid, or NULL if they have no admin_profiles row
-- (e.g. not an admin at all).
CREATE OR REPLACE FUNCTION public.admin_role_of(uid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT admin_role FROM public.admin_profiles WHERE profile_id = uid;
$function$;

CREATE OR REPLACE FUNCTION public.is_super_admin(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_profiles
    WHERE profile_id = uid AND admin_role = 'super_admin' AND account_status = 'active'
  );
$function$;

-- True if uid is an admin (is_admin flag) whose admin_profiles row (if any)
-- is active. An admin with NO admin_profiles row yet is treated as active
-- defensively (covers the moment between a raw is_admin flip and any
-- row existing) rather than silently locking someone out.
CREATE OR REPLACE FUNCTION public.is_active_admin(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.is_admin(uid) AND COALESCE(
    (SELECT account_status = 'active' FROM public.admin_profiles WHERE profile_id = uid),
    true
  );
$function$;

-- True if uid is an active admin AND (is a super_admin OR their admin_role
-- is one of p_roles). super_admin always passes, matching "Full access,
-- including managing administrators" from the spec.
CREATE OR REPLACE FUNCTION public.admin_has_role(uid uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.is_active_admin(uid) AND (
    public.is_super_admin(uid) OR public.admin_role_of(uid) = ANY (p_roles)
  );
$function$;


-- ============================================================================
-- 3. RLS policies on admin_profiles
-- ============================================================================

-- Any signed-in admin can see the admin directory (needed to render the
-- Admin Management list at all, and for a non-super admin to at least see
-- their own role/status). Non-admins get nothing about OTHER admins --
-- but a user can always see their OWN row even after being deactivated
-- (is_admin flipped false), specifically so the admin login page can look
-- up *why* they were blocked (see AdminLogin.jsx) and show a clear
-- message instead of a generic "no access" error. This does not let a
-- deactivated admin see anyone else's row -- is_admin(auth.uid()) is
-- false for them, so only the `profile_id = auth.uid()` half of this OR
-- ever applies to them.
DROP POLICY IF EXISTS "admins can view admin directory" ON public.admin_profiles;
CREATE POLICY "admins can view admin directory"
ON public.admin_profiles FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()) OR profile_id = auth.uid());

-- Only an active super_admin may create or edit admin_profiles rows
-- directly. (New admins are normally provisioned through
-- accept_admin_invitation() below, which is SECURITY DEFINER and so is
-- unaffected by this — this policy is what stops a non-super-admin from
-- doing `.from('admin_profiles').update({ admin_role: 'super_admin' })`
-- on themselves or anyone else.)
DROP POLICY IF EXISTS "super admin can insert admin profiles" ON public.admin_profiles;
CREATE POLICY "super admin can insert admin profiles"
ON public.admin_profiles FOR INSERT
TO authenticated
WITH CHECK (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "super admin can update admin profiles" ON public.admin_profiles;
CREATE POLICY "super admin can update admin profiles"
ON public.admin_profiles FOR UPDATE
TO authenticated
USING (public.is_super_admin(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()));

-- Permanent removal (distinct from deactivate, which keeps the row for
-- the record). Only a super_admin may delete an admin_profiles row, and
-- only the frontend ever offers this for someone OTHER than yourself
-- (AdminManagement.jsx hides all admin-on-admin actions for your own
-- row) -- enforced here too: WITH CHECK isn't available on DELETE, so
-- self-removal is blocked in the USING clause instead.
DROP POLICY IF EXISTS "super admin can delete admin profiles" ON public.admin_profiles;
CREATE POLICY "super admin can delete admin profiles"
ON public.admin_profiles FOR DELETE
TO authenticated
USING (public.is_super_admin(auth.uid()) AND profile_id <> auth.uid());


-- ============================================================================
-- 4. admin_invitations — how a super_admin "adds" a new admin without ever
--    handling/setting their password. The invited person completes their
--    own signup (choosing their own password) and the invitation is what
--    grants them is_admin + the intended role, once, for a matching email.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admin_invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  phone text,
  admin_role text NOT NULL
    CHECK (admin_role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'verification_admin'::text, 'support_admin'::text, 'reports_admin'::text])),
  invited_by uuid NOT NULL,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamp with time zone,
  CONSTRAINT admin_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT admin_invitations_token_key UNIQUE (token),
  CONSTRAINT admin_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_invitations_email ON public.admin_invitations (lower(email));
CREATE INDEX IF NOT EXISTS idx_admin_invitations_status ON public.admin_invitations (status);

ALTER TABLE public.admin_invitations ENABLE ROW LEVEL SECURITY;

-- Same reason as admin_profiles above: table-level GRANT is required
-- before RLS policies apply at all.
GRANT SELECT, INSERT, UPDATE ON public.admin_invitations TO authenticated;

-- Only super_admins manage invitations directly through the table. The
-- one thing a not-yet-authenticated invitee needs (reading their own
-- invitation by token, and accepting it) goes through the two SECURITY
-- DEFINER functions below instead, never through direct table access —
-- so there is no policy here allowing anon/authenticated-but-not-admin
-- reads of this table at all.
DROP POLICY IF EXISTS "super admin can view invitations" ON public.admin_invitations;
CREATE POLICY "super admin can view invitations"
ON public.admin_invitations FOR SELECT
TO authenticated
USING (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "super admin can create invitations" ON public.admin_invitations;
CREATE POLICY "super admin can create invitations"
ON public.admin_invitations FOR INSERT
TO authenticated
WITH CHECK (public.is_super_admin(auth.uid()) AND invited_by = auth.uid());

DROP POLICY IF EXISTS "super admin can update invitations" ON public.admin_invitations;
CREATE POLICY "super admin can update invitations"
ON public.admin_invitations FOR UPDATE
TO authenticated
USING (public.is_super_admin(auth.uid()))
WITH CHECK (public.is_super_admin(auth.uid()));


-- ── create_admin_invitation ────────────────────────────────────────────────
-- Called by a super_admin from the Admin Management UI. Raises if the
-- caller isn't an active super_admin (defense in depth — the INSERT
-- policy above already enforces this too), or if the email already
-- belongs to an active admin.
CREATE OR REPLACE FUNCTION public.create_admin_invitation(
  p_email text,
  p_full_name text,
  p_phone text,
  p_admin_role text
)
 RETURNS public.admin_invitations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.admin_invitations;
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only a super admin can invite new administrators';
  END IF;

  IF p_admin_role NOT IN ('super_admin', 'admin', 'verification_admin', 'support_admin', 'reports_admin') THEN
    RAISE EXCEPTION 'Invalid admin role: %', p_admin_role;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles pr
    JOIN public.admin_profiles ap ON ap.profile_id = pr.id
    WHERE lower(pr.email) = lower(p_email) AND ap.account_status = 'active'
  ) THEN
    RAISE EXCEPTION 'This email already belongs to an active administrator';
  END IF;

  -- Revoke any earlier still-pending invitation to the same email so
  -- only one active invite link exists at a time.
  UPDATE public.admin_invitations
  SET status = 'revoked'
  WHERE lower(email) = lower(p_email) AND status = 'pending';

  INSERT INTO public.admin_invitations (email, full_name, phone, admin_role, invited_by)
  VALUES (lower(p_email), p_full_name, p_phone, p_admin_role, auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_admin_invitation(text, text, text, text) TO authenticated;

-- ── revoke_admin_invitation ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_admin_invitation(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only a super admin can revoke an invitation';
  END IF;

  UPDATE public.admin_invitations
  SET status = 'revoked'
  WHERE id = p_id AND status = 'pending';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.revoke_admin_invitation(uuid) TO authenticated;

-- ── get_admin_invitation_preview ─────────────────────────────────────────
-- Publicly callable (the invitee is not signed in yet when they land on
-- the accept-invite page) but only ever returns the hand-picked columns
-- needed to render "You've been invited as {role}" for a KNOWN token —
-- there is no way to enumerate/list invitations through this, only to
-- look one up by its random token, and it never returns anything for a
-- non-pending/expired one.
--
-- identity_exists tells the frontend whether this email already has ANY
-- account (as a driver and/or passenger and/or another admin identity)
-- so it can show the right form up front -- "sign in with your existing
-- password to also add admin access" vs "choose a password to create
-- your account" -- instead of guessing by trying signUp first and only
-- discovering the truth from a failure. One email is meant to be able to
-- hold driver + passenger + admin all on the same identity (exactly like
-- driver_profiles/passenger_profiles already coexist today); this is
-- just choosing the right one of those two paths correctly the first
-- time.
DROP FUNCTION IF EXISTS public.get_admin_invitation_preview(uuid);

CREATE OR REPLACE FUNCTION public.get_admin_invitation_preview(p_token uuid)
 RETURNS TABLE (email text, full_name text, phone text, admin_role text, expires_at timestamptz, identity_exists boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    ai.email,
    ai.full_name,
    ai.phone,
    ai.admin_role,
    ai.expires_at,
    EXISTS (SELECT 1 FROM public.profiles pr WHERE lower(pr.email) = lower(ai.email))
  FROM public.admin_invitations ai
  WHERE ai.token = p_token AND ai.status = 'pending' AND ai.expires_at > now();
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_invitation_preview(uuid) TO anon, authenticated;

-- ── accept_admin_invitation ───────────────────────────────────────────────
-- Called by the invitee right after they've created/signed into their own
-- auth identity (see AcceptAdminInvite.jsx). Grants is_admin + creates the
-- admin_profiles row ONLY if:
--   - the token matches a still-pending, unexpired invitation, and
--   - the caller's own profiles.email matches the invited email.
-- The is_admin flip is what needs the carve-out added to
-- protect_profile_privileged_columns() below, since the caller is not yet
-- an admin at the moment they call this.
CREATE OR REPLACE FUNCTION public.accept_admin_invitation(p_token uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invite public.admin_invitations;
  v_caller_email text;
BEGIN
  SELECT * INTO v_invite
  FROM public.admin_invitations
  WHERE token = p_token AND status = 'pending' AND expires_at > now();

  IF v_invite IS NULL THEN
    RAISE EXCEPTION 'This invitation link is invalid, already used, or has expired';
  END IF;

  SELECT email INTO v_caller_email FROM public.profiles WHERE id = auth.uid();

  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'This invitation was issued to a different email address';
  END IF;

  PERFORM set_config('pamojaride.admin_invite_accept', 'true', true);

  UPDATE public.profiles SET is_admin = true WHERE id = auth.uid();

  INSERT INTO public.admin_profiles (profile_id, admin_role, account_status, created_by)
  VALUES (auth.uid(), v_invite.admin_role, 'active', v_invite.invited_by)
  ON CONFLICT (profile_id) DO UPDATE
    SET admin_role = EXCLUDED.admin_role, account_status = 'active', updated_at = now();

  UPDATE public.admin_invitations
  SET status = 'accepted', accepted_at = now()
  WHERE id = v_invite.id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.accept_admin_invitation(uuid) TO authenticated;


-- ============================================================================
-- 5. Carve-out in the existing privileged-columns trigger so
--    accept_admin_invitation() (step 4 above) can flip is_admin true for
--    the invitee themselves. This is built on top of the CORRECTED
--    version of the function from
--    database/password_reset_and_trips_completed_fix.sql (which removed a
--    stale NEW.trips_completed/OLD.trips_completed reference --
--    public.profiles never had that column, it lives on
--    driver_profiles/passenger_profiles only -- and added the
--    phone/phone_verified handling below). An earlier revision of this
--    migration mistakenly rebuilt this function from an older copy and
--    reintroduced that bug; this version restores the fix and adds only
--    the one new carve-out on top of it.
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
    IF NEW.is_admin = true
       AND OLD.is_admin = false
       AND coalesce(current_setting('pamojaride.admin_invite_accept', true), '') = 'true'
    THEN
      -- Allowed: this update is coming from accept_admin_invitation(),
      -- which has already independently verified a valid, matching,
      -- unexpired invitation before setting this flag.
      NULL;
    ELSE
      RAISE EXCEPTION 'Only an administrator may change is_admin';
    END IF;
  END IF;

  -- public.profiles has no trips_completed column -- that field lives on
  -- driver_profiles/passenger_profiles only. (Deliberately not checked
  -- here; see password_reset_and_trips_completed_fix.sql PART B.)

  -- A changed phone number can never carry over a stale "verified" flag
  -- from the number it's replacing -- silently correct rather than reject,
  -- since this is the expected/desired outcome of an otherwise-legitimate
  -- phone-number edit, not something to block.
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    NEW.phone_verified := false;
  ELSIF NEW.phone_verified IS DISTINCT FROM OLD.phone_verified
     AND coalesce(current_setting('pamojaride.system_update', true), '') <> 'true'
  THEN
    RAISE EXCEPTION 'phone_verified can only be changed by the system';
  END IF;

  RETURN NEW;
END;
$function$;

-- Trigger itself is unchanged (still points at the same function name),
-- but re-asserted idempotently per this project's existing convention.
DROP TRIGGER IF EXISTS trg_protect_profile_privileged_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileged_columns
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_columns();


-- ============================================================================
-- 6. Backend-enforced role check for driver KYC approve/reject
--    ("Verification Admin: Driver verification, driver documents, driver
--    approval/rejection"). Wraps exactly the same update DriverReview.jsx
--    already performs, so behavior is unchanged for a super_admin or
--    verification_admin — the only new thing is that a support_admin /
--    reports_admin / plain admin now gets a clear backend rejection
--    instead of silently succeeding via the old broad "any admin" path.
--    The general "admin can update driver profiles" policy is left in
--    place for OTHER driver_profiles writes (e.g. suspend/ban from User
--    Management, which is support/general-admin territory, not
--    verification-specific) — narrowing that shared policy would risk
--    removing legitimate access the task says to preserve.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_review_driver_verification(
  p_driver_id uuid,
  p_decision text,       -- 'verified' | 'rejected'
  p_reason text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_face_status text;
BEGIN
  IF NOT public.admin_has_role(auth.uid(), ARRAY['verification_admin']) THEN
    RAISE EXCEPTION 'You do not have permission to review driver verification';
  END IF;

  IF p_decision NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Invalid decision: %', p_decision;
  END IF;

  SELECT face_verification_status INTO v_face_status
  FROM public.driver_profiles WHERE profile_id = p_driver_id;

  IF p_decision = 'verified' THEN
    UPDATE public.driver_profiles
    SET verification_status = 'verified',
        kyc_approved_at = now(),
        kyc_approved_by = auth.uid(),
        kyc_rejection_reason = NULL,
        face_verification_status = CASE WHEN v_face_status = 'captured' THEN 'approved' ELSE v_face_status END
    WHERE profile_id = p_driver_id;
  ELSE
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'A rejection reason is required';
    END IF;
    UPDATE public.driver_profiles
    SET verification_status = 'rejected',
        kyc_rejection_reason = p_reason,
        face_verification_status = CASE WHEN v_face_status = 'captured' THEN 'rejected' ELSE v_face_status END
    WHERE profile_id = p_driver_id;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_review_driver_verification(uuid, text, text) TO authenticated;

-- Note: 'verification_admin' is in the ARRAY passed to admin_has_role();
-- admin_has_role() ORs that with is_super_admin() internally, so a
-- super_admin always passes too — see function body in section 2.


-- ============================================================================
-- 7. Profile-picture visibility gaps (Part 2)
-- ============================================================================

-- 7a. Driver → passenger photo on the Driver Bookings / Booking Details
-- pages. Same authorization as before (driver sees only their own trips'
-- bookings) — this only widens the SELECT list by one column, so the
-- return type changes and the function must be dropped and recreated.
DROP FUNCTION IF EXISTS public.get_driver_trip_bookings(uuid);

CREATE OR REPLACE FUNCTION public.get_driver_trip_bookings(p_trip_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  booking_reference text,
  trip_id uuid,
  passenger_id uuid,
  passenger_name text,
  passenger_phone text,
  passenger_picture text,
  seats_booked integer,
  total_price numeric,
  status text,
  refund_status text,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_at timestamptz,
  origin text,
  destination text,
  departure_time timestamptz,
  trip_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    b.id,
    b.booking_reference,
    b.trip_id,
    b.passenger_id,
    p.full_name,
    p.phone,
    p.profile_picture,
    b.seats_booked,
    b.total_price,
    b.status,
    b.refund_status,
    b.cancellation_reason,
    b.cancelled_at,
    b.created_at,
    t.origin,
    t.destination,
    t.departure_time,
    t.status
  FROM public.bookings b
  JOIN public.trips t   ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE t.driver_id = auth.uid()
    AND (p_trip_id IS NULL OR b.trip_id = p_trip_id)
  ORDER BY b.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_trip_bookings(uuid) TO authenticated;

-- 7c. Same gap, single-booking version: the driver Booking Details page
-- (components/shared/BookingDetailsView.jsx, portal="driver") uses
-- get_driver_booking_detail() (see database/booking_history_receipts.sql),
-- which has the identical omission as get_driver_trip_bookings() did --
-- passenger_name/passenger_phone but no photo. Same fix, same reasoning:
-- widen the SELECT list by one column. The passenger-facing counterpart
-- (get_passenger_booking_detail) already returns driver_profile_picture,
-- so this brings the driver side to parity.
DROP FUNCTION IF EXISTS public.get_driver_booking_detail(uuid);

CREATE OR REPLACE FUNCTION public.get_driver_booking_detail(p_booking_id uuid)
RETURNS TABLE (
  booking_id uuid,
  booking_reference text,
  booking_status text,
  refund_status text,
  seats_booked integer,
  price_per_seat_snapshot numeric,
  total_price numeric,
  booking_pickup_point text,
  booking_dropoff_point text,
  booking_created_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  trip_id uuid,
  origin text,
  destination text,
  departure_time timestamptz,
  estimated_arrival_time timestamptz,
  trip_status text,
  trip_pickup_point text,
  trip_dropoff_point text,
  vehicle_make text,
  vehicle_model text,
  vehicle_plate text,
  vehicle_color text,
  passenger_id uuid,
  passenger_name text,
  passenger_phone text,
  passenger_picture text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    b.id,
    b.booking_reference,
    b.status,
    b.refund_status,
    b.seats_booked,
    b.price_per_seat_snapshot,
    b.total_price,
    b.pickup_point,
    b.dropoff_point,
    b.created_at,
    b.cancelled_at,
    b.cancellation_reason,
    t.id,
    t.origin,
    t.destination,
    t.departure_time,
    t.estimated_arrival_time,
    t.status,
    t.pickup_point,
    t.dropoff_point,
    t.vehicle_make,
    t.vehicle_model,
    t.vehicle_plate,
    t.vehicle_color,
    p.id,
    p.full_name,
    p.phone,
    p.profile_picture
  FROM public.bookings b
  JOIN public.trips t    ON t.id = b.trip_id
  JOIN public.profiles p ON p.id = b.passenger_id
  WHERE b.id = p_booking_id
    AND (t.driver_id = auth.uid() OR public.is_admin(auth.uid()));
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_booking_detail(uuid) TO authenticated;

-- 7b. Admin → user photo. No RLS/RPC change needed here — Admin already
-- has full SELECT on driver_profiles/passenger_profiles (and their
-- embedded profiles.profile_picture) via existing policies; the gap was
-- purely that UserManagement.jsx's query didn't ask for the column. See
-- the accompanying frontend change (UserManagement.jsx now selects
-- profile_picture and renders a thumbnail).


-- ============================================================================
-- Done. Summary of new objects:
--   Tables:    admin_profiles, admin_invitations
--   Functions: admin_role_of, is_super_admin, is_active_admin,
--              admin_has_role, create_admin_invitation,
--              revoke_admin_invitation, get_admin_invitation_preview,
--              accept_admin_invitation, admin_review_driver_verification,
--              touch_admin_profiles_updated_at
--   Replaced:  protect_profile_privileged_columns() (additive carve-out),
--              get_driver_trip_bookings() (added passenger_picture column)
-- ============================================================================
