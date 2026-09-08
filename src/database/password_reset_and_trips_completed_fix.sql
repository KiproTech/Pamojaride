-- ============================================================================
-- PamojaRide — Task 3: password-reset email validation + trips_completed fix
-- Run this whole script once in the Supabase SQL Editor.
-- Idempotent — every statement is CREATE OR REPLACE / DROP-IF-EXISTS-then-
-- CREATE, safe to re-run.
-- ============================================================================


-- ============================================================================
-- PART A — Password reset: verify the email is actually registered before
-- a reset link is requested.
--
-- Root cause: ForgotPassword.jsx only ever called
-- supabase.auth.resetPasswordForEmail(), which Supabase deliberately never
-- reports "no such user" for (the framework-level anti-enumeration
-- default). The task explicitly asks for the OPPOSITE behaviour here — a
-- clear "no account exists with that email" message for an unregistered
-- address — so this adds one narrowly-scoped, read-only check in front of
-- that call.
--
-- `public.profiles` (and driver_profiles/passenger_profiles) already has
-- RLS that only lets a user read their OWN row, so the anon key used on
-- this page cannot query them directly — this RPC is SECURITY DEFINER
-- specifically so unauthenticated visitors can get a yes/no answer to
-- "does this email have an account", and it returns ONLY that boolean.
-- It never returns the name, phone, verification/account status, or
-- anything else about the account, so it does not expose unnecessary user
-- information. It is scoped by `p_portal` the exact same way sign-in
-- already is (DriverLogin.jsx/PassengerLogin.jsx reject a login if the
-- identity has no matching driver_profiles/passenger_profiles row), so a
-- driver-only identity correctly reports "no account" on the passenger
-- reset page, and vice versa. `p_portal = 'admin'` checks profiles.is_admin.
--
-- This does NOT touch the actual reset-token flow at all — Supabase Auth
-- (resetPasswordForEmail / the recovery link / auth.updateUser) remains
-- the sole source of truth for issuing, verifying, and consuming the
-- reset token, exactly as before.
--
-- NOTE on the enumeration trade-off: confirming "an account with this
-- email exists" is, by definition, account enumeration — the task
-- explicitly asks for this over Supabase's default anti-enumeration
-- behaviour. It is minimised as far as possible here (a bare boolean,
-- nothing else, and it doesn't affect the reset-token security at all),
-- but if enumeration resistance ever becomes a requirement again, the
-- fix is to remove/no-op this RPC and go back to the previous "always
-- show the same message" copy in ForgotPassword.jsx — nothing else needs
-- to change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.email_is_registered(p_email text, p_portal text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profile_id uuid;
  v_is_admin boolean;
  v_exists boolean;
BEGIN
  SELECT id, is_admin INTO v_profile_id, v_is_admin
  FROM public.profiles
  WHERE lower(email) = lower(trim(p_email))
  LIMIT 1;

  IF v_profile_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_portal = 'driver' THEN
    SELECT EXISTS(
      SELECT 1 FROM public.driver_profiles WHERE profile_id = v_profile_id
    ) INTO v_exists;
  ELSIF p_portal = 'passenger' THEN
    SELECT EXISTS(
      SELECT 1 FROM public.passenger_profiles WHERE profile_id = v_profile_id
    ) INTO v_exists;
  ELSIF p_portal = 'admin' THEN
    v_exists := coalesce(v_is_admin, false);
  ELSE
    -- Unknown/unscoped portal: fall back to "identity exists at all".
    v_exists := true;
  END IF;

  RETURN coalesce(v_exists, false);
END;
$function$;

-- Must be reachable by signed-out visitors (that's the whole point of a
-- "forgot password" page) as well as anyone already signed in elsewhere.
GRANT EXECUTE ON FUNCTION public.email_is_registered(text, text) TO anon, authenticated;


-- ============================================================================
-- PART B — profiles.trips_completed does not exist: fix the trigger that
-- was blocking every profiles update (including the profile-photo PATCH).
--
-- Root cause: `public.profiles` never had a `trips_completed` column —
-- that per-role counter correctly lives on `driver_profiles` and
-- `passenger_profiles` (see db.sql), each already protected by its own
-- privileged-columns trigger. But `protect_profile_privileged_columns()`
-- (critical_security_fixes.sql, later re-CREATE-OR-REPLACEd by
-- profile_settings_hardening.sql) still references `NEW.trips_completed`/
-- `OLD.trips_completed`. Referencing a field that doesn't exist on the
-- row raises `record "new" has no field "trips_completed"` on ANY UPDATE
-- to `public.profiles` — including PersonalInfoCard.jsx's plain
-- `updateProfile({ profile_picture: url })` after a photo upload, which is
-- exactly the 400 error reported.
--
-- Fix: this trigger simply stops referencing a column that was never
-- actually on this table. Nothing else in the function changes — the
-- is_admin bypass, the is_admin-change guard, and the phone/phone_verified
-- logic added by profile_settings_hardening.sql are all preserved exactly.
-- No column is added, removed, or duplicated; RLS is untouched.
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
    RAISE EXCEPTION 'Only an administrator may change is_admin';
  END IF;

  -- (Removed) public.profiles has no trips_completed column — that field
  -- lives on driver_profiles/passenger_profiles only (see PART C below for
  -- where it's actually maintained). The stale check that used to be here
  -- is exactly what made every profiles update fail.

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

  RETURN NEW;
END;
$function$;

-- The trigger itself already exists (trg_protect_profile_privileged_columns,
-- from critical_security_fixes.sql) and points at this function by name —
-- CREATE OR REPLACE above is enough to pick up the fix, no DROP/CREATE
-- TRIGGER needed.


-- ============================================================================
-- PART C — the driver trips_completed counter was being written to the
-- wrong table.
--
-- Same root cause as PART B, the other side of it: complete_trip(),
-- confirm_trip_completion(), and auto_complete_pending_trips() (all three
-- defined in trip_auto_completion.sql, the current versions of these
-- functions) each end with:
--     UPDATE public.profiles SET trips_completed = trips_completed + 1
--       WHERE id = v_trip.driver_id;
-- which fails for the exact same reason as PART B (profiles has no
-- trips_completed column) — except here Postgres reports it as
-- `column "trips_completed" of relation "profiles" does not exist`
-- rather than the trigger's "record ... has no field" message, since this
-- is a plain UPDATE against a nonexistent column, not a trigger
-- referencing NEW/OLD. This wasn't the error the person originally saw
-- (that was PART B, hit first via profile photo uploads), but it is the
-- exact same "field moved to driver_profiles, this call was never
-- updated" defect, and would break trip completion the moment any trip
-- was actually completed. Fixed here since the task asked to correct any
-- SQL logic referencing the outdated field, not just the one blocking the
-- upload.
--
-- Fix: redirect all three UPDATEs to driver_profiles.trips_completed,
-- keyed on profile_id (driver_profiles' actual key column) instead of id.
-- Every other line in these three functions is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_trip(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_total_passengers integer;
  v_required integer;
  v_passenger RECORD;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF NOT (v_trip.driver_id = v_caller OR public.is_admin(v_caller)) THEN
    RAISE EXCEPTION 'Not authorized to complete this trip';
  END IF;
  IF v_trip.status NOT IN ('scheduled', 'ongoing') THEN
    RAISE EXCEPTION 'Trip is already % and cannot be completed', v_trip.status;
  END IF;
  IF v_trip.departure_time > now() THEN
    RAISE EXCEPTION 'Trip cannot be marked completed before its departure time';
  END IF;

  SELECT count(DISTINCT passenger_id) INTO v_total_passengers
  FROM public.bookings
  WHERE trip_id = p_trip_id AND status = 'confirmed';

  -- Set once, up front, so it covers every privileged write below (trips,
  -- bookings, AND driver_profiles.trips_completed) for the rest of this
  -- transaction.
  PERFORM set_config('pamojaride.system_update', 'true', true);

  IF v_total_passengers = 0 THEN
    -- Nothing to confirm — complete immediately, exactly as before this
    -- feature existed.
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id
      RETURNING * INTO v_trip;

    UPDATE public.bookings SET status = 'completed' WHERE trip_id = p_trip_id AND status = 'confirmed';
    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

    RETURN v_trip;
  END IF;

  v_required := ceil(v_total_passengers / 2.0)::integer;

  UPDATE public.trips
    SET status = 'completion_pending',
        completion_requested_at = now(),
        completion_deadline = now() + interval '20 minutes',
        completion_total_passengers = v_total_passengers,
        completion_required_confirmations = v_required
    WHERE id = p_trip_id
    RETURNING * INTO v_trip;

  FOR v_passenger IN
    SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = p_trip_id AND status = 'confirmed'
  LOOP
    PERFORM public.notify(
      v_passenger.passenger_id, 'trip_completion_pending', 'Confirm your trip is complete',
      format('Your driver marked the trip %s -> %s as finished. Please confirm in the app within 20 minutes — once enough passengers confirm (or the 20 minutes run out), it will be marked completed automatically.',
        v_trip.origin, v_trip.destination),
      jsonb_build_object('trip_id', v_trip.id)
    );
  END LOOP;

  RETURN v_trip;
END;
$function$;


CREATE OR REPLACE FUNCTION public.confirm_trip_completion(p_trip_id uuid)
 RETURNS trips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_caller uuid := auth.uid();
  v_has_booking boolean;
  v_confirmed_count integer;
  v_passenger RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Must be authenticated to confirm trip completion';
  END IF;

  -- Locks the row: if auto_complete_pending_trips() is finalizing this same
  -- trip concurrently, this blocks until that commits, then re-reads the
  -- now-'completed' row and correctly raises below instead of double-
  -- processing it.
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  IF v_trip.status <> 'completion_pending' THEN
    RAISE EXCEPTION 'This trip is not awaiting completion confirmation (status: %)', v_trip.status;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.bookings
    WHERE trip_id = p_trip_id AND passenger_id = v_caller AND status IN ('confirmed', 'completed')
  ) INTO v_has_booking;

  IF NOT v_has_booking THEN
    RAISE EXCEPTION 'Only passengers with a confirmed booking on this trip may confirm its completion';
  END IF;

  PERFORM set_config('pamojaride.system_update', 'true', true);

  INSERT INTO public.trip_completion_confirmations (trip_id, passenger_id)
  VALUES (p_trip_id, v_caller)
  ON CONFLICT ON CONSTRAINT trip_completion_confirmations_unique DO NOTHING;

  SELECT count(*) INTO v_confirmed_count
  FROM public.trip_completion_confirmations
  WHERE trip_id = p_trip_id;

  IF v_confirmed_count >= v_trip.completion_required_confirmations THEN
    UPDATE public.trips
      SET status = 'completed', completed_at = now()
      WHERE id = p_trip_id
      RETURNING * INTO v_trip;

    UPDATE public.bookings SET status = 'completed' WHERE trip_id = p_trip_id AND status = 'confirmed';
    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = p_trip_id AND status = 'completed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_completed', 'Trip completed',
        format('Your trip %s -> %s has been confirmed completed by passengers.', v_trip.origin, v_trip.destination),
        jsonb_build_object('trip_id', v_trip.id, 'auto_completed', false)
      );
    END LOOP;
  END IF;

  RETURN v_trip;
END;
$function$;


CREATE OR REPLACE FUNCTION public.auto_complete_pending_trips()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_passenger RECORD;
  v_processed integer := 0;
BEGIN
  FOR v_trip IN
    SELECT * FROM public.trips
    WHERE status = 'completion_pending'
      AND completion_deadline IS NOT NULL
      AND completion_deadline <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('pamojaride.system_update', 'true', true);

    UPDATE public.trips
      SET status = 'completed', completed_at = now(), auto_completed = true
      WHERE id = v_trip.id;

    UPDATE public.bookings SET status = 'completed' WHERE trip_id = v_trip.id AND status = 'confirmed';
    UPDATE public.driver_profiles SET trips_completed = trips_completed + 1 WHERE profile_id = v_trip.driver_id;

    FOR v_passenger IN
      SELECT DISTINCT passenger_id FROM public.bookings WHERE trip_id = v_trip.id AND status = 'completed'
    LOOP
      PERFORM public.notify(
        v_passenger.passenger_id, 'trip_completed', 'Trip automatically completed',
        format('Your trip %s -> %s was automatically marked completed after the 20-minute confirmation window closed.',
          v_trip.origin, v_trip.destination),
        jsonb_build_object('trip_id', v_trip.id, 'auto_completed', true)
      );
    END LOOP;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN v_processed;
END;
$function$;


-- ============================================================================
-- PART D — driver_profiles' own privileged-columns trigger would otherwise
-- now block the system writes PART C redirects to it.
--
-- protect_driver_profile_privileged_columns() (verification_storage.sql,
-- later re-CREATE-OR-REPLACEd by vehicle_face_verification_upgrade.sql —
-- that later version is what's replaced here, in full, with one addition)
-- already bundles `trips_completed` into its blanket
-- "only an administrator may change privileged driver profile fields"
-- check, with NO system-update carve-out. Now that PART C's functions
-- write to driver_profiles.trips_completed directly, a driver completing
-- their own trip would immediately hit
-- "Only an administrator may change privileged driver profile fields"
-- and the whole complete_trip() call would roll back.
--
-- Fix: give trips_completed the exact same
-- `pamojaride.system_update` transaction-local escape hatch already used
-- for this column on public.profiles (previously) and for
-- protect_bookings_privileged_columns() / protect_trips_privileged_columns()
-- elsewhere — i.e. the established pattern in this codebase for "only our
-- own trusted RPCs may change this column, never a client directly". Every
-- OTHER privileged driver_profiles column (trust_level, max_seats_per_trip,
-- max_active_trips, payout_delay_hours, dispute_count, flagged_for_review,
-- suspension_reason, kyc_approved_at/by, kyc_rejection_reason) stays exactly
-- as strictly admin-only-protected as before — only trips_completed gets
-- the carve-out, and only for the system_update-flagged writes PART C's
-- RPCs already make. A driver still cannot set their own trips_completed
-- directly (e.g. via `.from('driver_profiles').update({trips_completed: 999})`),
-- since that call would never have set the transaction-local flag.
-- ============================================================================

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

  -- NEW: trips_completed is written by the system only (complete_trip /
  -- confirm_trip_completion / auto_complete_pending_trips, all three
  -- SECURITY DEFINER and all three set pamojaride.system_update before
  -- writing it) — never by a driver directly.
  if new.trips_completed is distinct from old.trips_completed
     and coalesce(current_setting('pamojaride.system_update', true), '') <> 'true'
  then
    raise exception 'trips_completed can only be changed by the system';
  end if;

  if new.trust_level          is distinct from old.trust_level
     or new.max_seats_per_trip   is distinct from old.max_seats_per_trip
     or new.max_active_trips     is distinct from old.max_active_trips
     or new.payout_delay_hours   is distinct from old.payout_delay_hours
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

-- The trigger itself already exists (pointing at this function by name,
-- from verification_storage.sql) — CREATE OR REPLACE above is enough, no
-- DROP/CREATE TRIGGER needed.

-- ============================================================================
-- End of migration. Nothing else (RLS policies, storage buckets, other
-- tables/functions) was touched.
-- ============================================================================
