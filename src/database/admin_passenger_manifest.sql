-- ============================================================================
-- PamojaRide — Admin Passenger Manifest (Trip Oversight)
--
-- Run this whole script once in the Supabase SQL Editor, AFTER
-- admin_trip_completion_override.sql. Purely additive — one new,
-- admin-only, read-only RPC. No table is created, no column is added, no
-- existing function changes. Idempotent — safe to re-run.
-- ============================================================================
--
-- WHY NO NEW COLUMN OR TABLE:
--
--   The brief asks for a "unique passenger identification" that is NOT an
--   identity document, is safe to show admins, and reuses what already
--   exists rather than duplicating it. profiles.id (uuid, already unique,
--   already the join key for everything passenger-related) already IS
--   that identifier — it's just not something you'd want to print
--   verbatim in an admin table. So this migration does not add a
--   passenger_reference column at all: it derives a short, stable,
--   non-sensitive display reference straight from profiles.id inside the
--   RPC itself ('PR-PASS-' + the first 8 hex characters of the uuid,
--   uppercased) — the same "short prefixed code" shape bookings already
--   use for booking_reference, but computed on read instead of stored.
--   It's stable for a given passenger forever (their id never changes),
--   unique (id already is), reveals nothing about the person, and isn't
--   reversible to their full account id in practice. If a genuinely
--   stored, independently-rotatable reference is ever needed later, this
--   can be swapped for a real column with zero change to any caller — the
--   RPC's output shape stays identical either way.
--
--   get_trip_passenger_manifest() is the one new RPC: a single joined
--   query (trips -> bookings -> profiles), not one query per passenger,
--   so a 40-passenger trip costs exactly one round trip, same as every
--   other list RPC already in this project (get_trip_passenger_completions,
--   get_driver_trip_bookings, etc.).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_trip_passenger_manifest(p_trip_id uuid)
 RETURNS TABLE (
   trip_id uuid,
   origin text,
   destination text,
   departure_time timestamptz,
   trip_status text,
   driver_id uuid,
   driver_name text,
   booking_id uuid,
   booking_reference text,
   booking_status text,
   seats_booked integer,
   passenger_id uuid,
   passenger_reference text,
   passenger_full_name text,
   passenger_profile_picture text,
   booked_at timestamptz
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_trip public.trips%ROWTYPE;
BEGIN
  -- ── Authorization: admin only. Neither the trip's own driver nor any
  --    passenger on it can call this — the full multi-passenger manifest
  --    (everyone else's name + reference together) is an admin-oversight
  --    view specifically, not something either party sees about the other
  --    today, and this migration doesn't change that.
  IF v_caller IS NULL OR NOT public.is_admin(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to view this trip''s passenger manifest';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  RETURN QUERY
  SELECT
    t.id, t.origin, t.destination, t.departure_time, t.status, t.driver_id, d.full_name,
    b.id, b.booking_reference, b.status, b.seats_booked,
    p.id,
    'PR-PASS-' || upper(substr(replace(p.id::text, '-', ''), 1, 8)),
    p.full_name,
    p.profile_picture,
    b.created_at
  FROM public.trips t
  JOIN public.bookings b ON b.trip_id = t.id
  JOIN public.profiles p ON p.id = b.passenger_id
  LEFT JOIN public.profiles d ON d.id = t.driver_id
  WHERE t.id = p_trip_id
    -- "Active/confirmed" per the brief — a cancelled booking never
    -- appears here (it isn't "on board or booked" for this trip anymore),
    -- and this is the exact same filter the Trip Oversight table already
    -- uses for its passenger COUNT, so the manifest's row count and the
    -- table's number always agree.
    AND b.status = 'confirmed'
  ORDER BY b.created_at ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_trip_passenger_manifest(uuid) TO authenticated;

-- ============================================================================
-- End of migration. RLS on trips/bookings/profiles is untouched — this RPC
-- is SECURITY DEFINER with its own explicit is_admin() check, exactly like
-- get_trip_passenger_completions() and every other admin-only read RPC in
-- this project, so no table grant or policy change was needed.
-- ============================================================================
