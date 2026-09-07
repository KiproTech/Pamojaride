-- ============================================================================
-- PamojaRide — Ratings: RLS lockdown + real eligibility/duplicate validation
--
-- Run this whole script once in the Supabase SQL Editor. Purely additive/
-- corrective to the EXISTING public.ratings table (see db.sql) — no table is
-- dropped, no rating row is deleted or edited, no column is removed. Safe to
-- run multiple times (every CREATE/DROP below is IF EXISTS / OR REPLACE).
-- ============================================================================
--
-- ROOT CAUSE OF THE ISSUE THIS FIXES:
--
--   components/passenger/RatingModal.jsx has a comment claiming:
--     "validate_rating_participant() trigger confirms this booking is
--      actually completed and this passenger actually took this trip
--      before allowing the insert — client-side checks here are just UX,
--      not the real guard."
--
--   That function does not exist anywhere in this project's SQL files
--   (confirmed by grepping every file under src/database), and no RLS
--   policy, trigger, or constraint on public.ratings exists anywhere
--   either — db.sql defines the table's columns/foreign keys only, with a
--   header explicitly noting "not meant to be run" (schema-for-context).
--   In other words: the comment describes a real security control, but it
--   was never actually written. Whatever protection ratings has today
--   depends entirely on whatever ad-hoc state the live database happens to
--   be in — which, per the brief, is exactly the "may have serious missing
--   security and validation protections" the audit flagged. This migration
--   makes that comment true by actually building the thing it describes,
--   and closes every gap listed in the brief, whether or not RLS was
--   already enabled on this table.
--
-- WHAT THIS MIGRATION DOES:
--
--   1. Enables RLS on public.ratings (idempotent if already on) and
--      REMOVES every existing policy on the table first (see the DO block
--      below) before creating the correct ones — this guarantees no
--      leftover permissive policy (e.g. a default "authenticated users can
--      insert" policy) can coexist with, and silently bypass, the strict
--      policies created here. This only removes access RULES, never data.
--   2. rating_relationship_is_valid(): a SECURITY DEFINER function (same
--      pattern as report_relationship_is_valid() in
--      report_relationship_and_duplicate_hardening.sql) that is the real
--      guard behind the INSERT policy. For a proposed rating it checks:
--        - the booking exists and belongs to the given trip,
--        - the booking's status is 'completed' (see trip_auto_completion.sql
--          — this is set only once a trip is genuinely finalized, via
--          confirm_trip_completion() or auto_complete_pending_trips(), so
--          it is the correct, already-established "trip really happened"
--          signal — never a client-supplied flag),
--        - for rating_type = 'passenger_to_driver': the rater is that
--          booking's passenger AND the ratee is that trip's driver,
--        - for rating_type = 'driver_to_passenger': the rater is that
--          trip's driver AND the ratee is that booking's passenger,
--        - rater and ratee are never the same person.
--      A booking_id/trip_id that don't exist, don't match each other, or
--      don't match the rater/ratee/rating_type given, all return false —
--      closing "rate a trip that isn't completed", "rate an unrelated
--      user", and "malformed/unrelated booking or trip id" all at once.
--   3. The INSERT policy uses that function, plus rater_id = auth.uid()
--      (a passenger/driver can only ever submit a rating as themselves —
--      closes "insert a rating impersonating someone else"), plus blocking
--      any attempt to pre-seed the moderation columns
--      (removed_by_admin/removed_at/removal_reason/flagged_for_review) on
--      insert — same "can't pre-seed moderation fields" rule already used
--      for public.reports.
--   4. SELECT policy: a user can see a rating iff they are its rater, its
--      ratee, or an admin. This matches the only two real read patterns in
--      the app today — MyBookings.jsx reads the passenger's OWN submitted
--      ratings (to grey out "Rate driver" once already rated) and
--      driver/Dashboard.jsx reads ratings received BY the signed-in driver
--      — and stops a random authenticated user from browsing everyone
--      else's individual reviews/comments. (The separate, already-correct
--      get_trip_driver_previews() SECURITY DEFINER function is untouched
--      and keeps working exactly as before — it only ever returns an
--      aggregate avg/count, never a raw row, so it bypasses this table's
--      RLS by design, same as before this migration.)
--   5. UPDATE policy: admin-only (moderation: flagging/removing a rating).
--      There is no rating-edit feature anywhere in the current UI, so no
--      policy allows a rater to update their own submitted rating — this
--      is the strictest correct reading of "prevent editing another user's
--      rating" without inventing a new edit feature that wasn't asked for.
--   6. No DELETE policy at all (for anyone, including admins) — same
--      "permanently available for review" reasoning already used for
--      public.reports. RLS defaults to deny, so ratings can never be
--      deleted through the app.
--   7. Duplicate-rating prevention, in two layers:
--        a) prevent_duplicate_rating(): a BEFORE INSERT trigger that
--           always installs successfully (regardless of what's already in
--           the table) and rejects a second rating of the same type for
--           the same booking with a friendly, catchable error — this is
--           the primary, always-on guard.
--        b) A best-effort UNIQUE index on (booking_id, rating_type) as
--           defense-in-depth, created only if the live data doesn't
--           already contain a conflicting duplicate (checked first — see
--           the DO block below). If duplicates already exist, the index
--           is skipped with a RAISE NOTICE naming the affected bookings
--           for manual review, rather than either (a) silently failing the
--           whole migration, or (b) auto-deleting someone's real historical
--           review to force the index to fit. The trigger in (a) still
--           fully prevents any *new* duplicates either way.
--   8. Helpful indexes for the access patterns above (rater_id, ratee_id,
--      booking_id).
--
-- WHAT IS DELIBERATELY UNCHANGED:
--   - Table columns, foreign keys, and the existing
--     `rating BETWEEN 1 AND 5` / `rating_type IN (...)` CHECK constraints
--     (db.sql) — rating-value and rating-type validation already exist at
--     the column level and are correct as-is.
--   - get_trip_driver_previews() (trip_search_driver_preview.sql) and every
--     other existing function/trigger/policy on any other table.
--   - The ratings UI itself (RatingModal.jsx keeps its existing star
--     picker/comment box) — the only frontend change is catching the new
--     duplicate-rating error code with a friendly message, exactly the
--     pattern already used in ReportModal.jsx for the equivalent reports
--     constraint.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. rating_relationship_is_valid(): the real eligibility guard.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rating_relationship_is_valid(
  p_rater_id uuid,
  p_ratee_id uuid,
  p_trip_id uuid,
  p_booking_id uuid,
  p_rating_type text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_booking RECORD;
  v_trip RECORD;
BEGIN
  IF p_rater_id IS NULL OR p_ratee_id IS NULL OR p_trip_id IS NULL OR p_booking_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_rater_id = p_ratee_id THEN
    RETURN false; -- can never rate yourself
  END IF;

  SELECT id, trip_id, passenger_id, status INTO v_booking
  FROM public.bookings
  WHERE id = p_booking_id;

  IF v_booking.id IS NULL THEN
    RETURN false; -- booking doesn't exist
  END IF;

  IF v_booking.trip_id IS DISTINCT FROM p_trip_id THEN
    RETURN false; -- trip_id doesn't actually belong to this booking
  END IF;

  IF v_booking.status <> 'completed' THEN
    RETURN false; -- trip/booking hasn't reached the required completed state
  END IF;

  SELECT id, driver_id INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF v_trip.id IS NULL THEN
    RETURN false; -- trip doesn't exist (shouldn't happen given the FK, but cheap to check)
  END IF;

  IF p_rating_type = 'passenger_to_driver' THEN
    RETURN v_booking.passenger_id = p_rater_id AND v_trip.driver_id = p_ratee_id;
  ELSIF p_rating_type = 'driver_to_passenger' THEN
    RETURN v_trip.driver_id = p_rater_id AND v_booking.passenger_id = p_ratee_id;
  END IF;

  RETURN false; -- unknown rating_type
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rating_relationship_is_valid(uuid, uuid, uuid, uuid, text) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. Duplicate-rating trigger — always installs, always enforced, regardless
--    of any pre-existing duplicate data.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_duplicate_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ratings
    WHERE booking_id = NEW.booking_id
      AND rating_type = NEW.rating_type
  ) THEN
    -- Reuse Postgres's standard "unique_violation" error code so the
    -- frontend can catch it exactly like a real unique-constraint hit
    -- (same pattern ReportModal.jsx already uses for err.code === '23505').
    RAISE EXCEPTION 'A % rating has already been submitted for this booking', NEW.rating_type
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_rating ON public.ratings;
CREATE TRIGGER trg_prevent_duplicate_rating
BEFORE INSERT ON public.ratings
FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_rating();


-- ----------------------------------------------------------------------------
-- 3. Best-effort UNIQUE index, defense-in-depth on top of the trigger above.
--    Skipped (with a NOTICE) instead of failing the migration if the live
--    table already contains a conflicting duplicate — no existing rating
--    row is ever touched or deleted by this migration.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_dupe_count integer;
BEGIN
  SELECT count(*) INTO v_dupe_count FROM (
    SELECT booking_id, rating_type
    FROM public.ratings
    GROUP BY booking_id, rating_type
    HAVING count(*) > 1
  ) d;

  IF v_dupe_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ratings_booking_rating_type
      ON public.ratings (booking_id, rating_type);
  ELSE
    RAISE NOTICE 'Skipping uq_ratings_booking_rating_type: % existing booking/rating_type group(s) already have more than one rating row. The trg_prevent_duplicate_rating trigger still blocks any NEW duplicate either way — review the existing duplicates manually with: SELECT booking_id, rating_type, count(*) FROM public.ratings GROUP BY booking_id, rating_type HAVING count(*) > 1;', v_dupe_count;
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 4. RLS: enable, wipe any pre-existing policy on this table (by name,
--    whatever it's called), then create exactly the policies described
--    above. This never touches table data, only access rules.
-- ----------------------------------------------------------------------------

ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ratings'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.ratings', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "users can submit their own valid ratings"
ON public.ratings FOR INSERT
WITH CHECK (
  rater_id = auth.uid()
  AND removed_by_admin IS NULL
  AND removed_at IS NULL
  AND removal_reason IS NULL
  AND coalesce(flagged_for_review, false) = false
  AND public.rating_relationship_is_valid(auth.uid(), ratee_id, trip_id, booking_id, rating_type)
);

CREATE POLICY "users can view ratings they gave or received"
ON public.ratings FOR SELECT
USING (
  rater_id = auth.uid()
  OR ratee_id = auth.uid()
  OR public.is_admin(auth.uid())
);

CREATE POLICY "admin can moderate ratings"
ON public.ratings FOR UPDATE
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

-- No DELETE policy for anyone (including admins) — ratings are permanent,
-- moderation happens via the UPDATE policy above (removed_at/removed_by_admin
-- /removal_reason/flagged_for_review), matching public.reports's pattern.


-- ----------------------------------------------------------------------------
-- 5. Helpful indexes for the access patterns above / this migration's checks.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ratings_rater_id ON public.ratings (rater_id);
CREATE INDEX IF NOT EXISTS idx_ratings_ratee_id ON public.ratings (ratee_id);
CREATE INDEX IF NOT EXISTS idx_ratings_booking_id ON public.ratings (booking_id);

-- ============================================================================
-- End of migration.
-- ============================================================================
