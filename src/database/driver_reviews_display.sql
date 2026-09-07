-- ============================================================================
-- PamojaRide — Driver Reviews: privacy-safe review list for passengers &
-- drivers (Prompt 8)
--
-- Run this whole script once in the Supabase SQL Editor. Purely additive:
-- it only creates ONE new function. No existing table, view, function,
-- policy, trigger, or RLS rule is touched, dropped, replaced, or weakened.
-- No row in public.ratings is touched, edited, or deleted.
-- ============================================================================
--
-- ROOT CAUSE / WHY THIS IS NEEDED:
--
--   ratings_security_hardening.sql correctly locks public.ratings SELECT
--   down to "rater, ratee, or admin only" — a random authenticated user
--   cannot browse another rider's individual review rows directly. That is
--   correct and is NOT changed here.
--
--   But Prompt 8 also asks for passengers to read a driver's reviews
--   BEFORE booking, and for a driver to see recent reviews left about them.
--   Neither of those callers is the rater, so the direct-table SELECT
--   policy correctly denies them — there is currently no way to show a
--   review list anywhere in the app, and none exists in the UI today.
--
--   Exactly like get_trip_driver_previews() (trip_search_driver_preview.sql)
--   and get_booked_trip_driver_details() (passenger_driver_details.sql),
--   the fix is a single narrow, read-only SECURITY DEFINER function that
--   hand-picks a safe column list — never a policy change on public.ratings
--   itself.
--
-- WHAT get_driver_reviews() RETURNS AND WHY:
--
--   - rating, comment, created_at: the review content itself.
--   - reviewer_display_name: the reviewing passenger's first name plus
--     their last name's initial (e.g. "Jane M."), NEVER their full name,
--     phone, or email. This mirrors the "don't publicly expose a
--     passenger's private phone number through reviews" instruction one
--     step further — a review is shown to strangers pre-booking, so it
--     gets the same lightweight-identity treatment common review UIs use,
--     rather than the fuller identity a driver/passenger already see about
--     each other post-booking (get_booked_trip_driver_details).
--   - total_count: total number of non-removed reviews for this driver, as
--     a window count, so the frontend can show "12 reviews" / paginate
--     without a second round trip.
--
--   Excludes: rater_id, ratee_id, booking_id, trip_id, removed_by_admin,
--   removal_reason, flagged_for_review — nothing beyond what a review card
--   needs is ever returned.
--
--   Only rating_type = 'passenger_to_driver' rows are returned (this is a
--   DRIVER's review list; driver_to_passenger ratings are a separate,
--   private concern already handled by the existing ratings SELECT
--   policy). Rows with removed_at IS NOT NULL (admin-moderated) are
--   excluded — same "moderated content stops surfacing publicly" rule
--   already used elsewhere in this project.
--
-- AUTHORIZATION:
--
--   Callable by any authenticated user, same authorization level as
--   get_trip_driver_previews() — this is public, pre-booking browsing
--   data by design (a driver's review list is meant to be seen by anyone
--   deciding whether to book them), and the column list itself is the
--   privacy boundary, not row-level gating. A driver calling this with
--   their own id (to power their dashboard's "Recent reviews") gets
--   exactly the same shape everyone else sees about them — no special
--   case needed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_driver_reviews(
  p_driver_id uuid,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  id uuid,
  rating integer,
  comment text,
  created_at timestamptz,
  reviewer_display_name text,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    r.id,
    r.rating,
    r.comment,
    r.created_at,
    CASE
      WHEN p.full_name IS NULL OR btrim(p.full_name) = '' THEN 'Passenger'
      WHEN position(' ' IN btrim(p.full_name)) = 0 THEN btrim(p.full_name)
      ELSE split_part(btrim(p.full_name), ' ', 1)
           || ' ' || left(split_part(btrim(p.full_name), ' ', 2), 1) || '.'
    END AS reviewer_display_name,
    count(*) OVER() AS total_count
  FROM public.ratings r
  LEFT JOIN public.profiles p ON p.id = r.rater_id
  WHERE r.ratee_id = p_driver_id
    AND r.rating_type = 'passenger_to_driver'
    AND r.removed_at IS NULL
  ORDER BY r.created_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 10), 1), 50)
  OFFSET GREATEST(coalesce(p_offset, 0), 0);
$function$;

GRANT EXECUTE ON FUNCTION public.get_driver_reviews(uuid, integer, integer) TO authenticated;

-- ============================================================================
-- End of migration. No other database change is required for Prompt 8 —
-- rating submission (RatingModal.jsx → public.ratings insert), the
-- eligibility/duplicate guards, and the existing driver-preview aggregate
-- (get_trip_driver_previews) were already correctly built in a prior task
-- and are untouched here.
-- ============================================================================
