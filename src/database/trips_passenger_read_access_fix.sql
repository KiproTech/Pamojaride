-- ============================================================================
-- PamojaRide — fix passengers losing access to their own trip's details
-- once it's no longer 'scheduled' ("Trip details unavailable" / the old
-- "undefined → undefined" / "Invalid Date" symptom on My Bookings).
-- Run once in the Supabase SQL Editor. Idempotent — safe to re-run.
-- ============================================================================
--
-- ROOT CAUSE:
--
--   `public.trips` has Row Level Security enabled, but none of this
--   project's migration files (including the base schema) grant a
--   passenger SELECT access to a trip once they've booked it — only a
--   policy for browsing/searching trips with status = 'scheduled' exists.
--   The moment a trip moves to 'completion_pending', 'completed',
--   'cancelled', etc., RLS silently hides that trips row from the
--   passenger who booked it.
--
--   The passenger-side query on My Bookings embeds the trip via
--   PostgREST (`.select('*, trips(...)')`). When RLS blocks the embedded
--   row, PostgREST doesn't error the whole query — it just returns
--   `trips: null` for that booking. The frontend then had nothing to
--   render, which is exactly the "Trip details unavailable" placeholder
--   (and, before that placeholder existed, the raw
--   "undefined → undefined" / "Invalid Date" the origin bug report
--   described) — the booking row itself (reference, seats, total) comes
--   straight from `bookings`, which the passenger can always read, so
--   only the trip fields were ever missing. This also explains why the
--   ⭐ Rate Driver button disappeared on the same bookings: the frontend
--   needs `trip.driver_id` to open the rating modal, and that was
--   silently null for the same reason.
--
-- FIX:
--
--   Add explicit, additive SELECT policies on `public.trips` so a trip is
--   always visible to everyone who legitimately has a stake in it,
--   regardless of its current status:
--     - the driver who owns it
--     - any passenger with a booking on it (any booking status — a
--       cancelled or no-show booking should still show the passenger
--       what trip it was)
--     - admins
--     - the public/authenticated "browse trips" policy for status =
--       'scheduled' trips is left untouched (dropped and recreated
--       verbatim below only so this migration is fully idempotent and
--       self-contained, not because its logic changes).
--
--   Because Postgres RLS OR's together all permissive policies that
--   apply to a role, adding these does not remove or narrow any access
--   that already worked — it only adds the cases that were missing.
-- ============================================================================

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

-- Remove only the specific policies this migration owns (by name) before
-- recreating them, so re-running this file is always safe. Any
-- differently-named pre-existing policy on public.trips is left alone.
DROP POLICY IF EXISTS "trips are visible while scheduled" ON public.trips;
DROP POLICY IF EXISTS "driver can view own trips at any status" ON public.trips;
DROP POLICY IF EXISTS "passenger can view trips they booked" ON public.trips;
DROP POLICY IF EXISTS "admin can view all trips" ON public.trips;

-- Anyone signed in can browse/search trips that are currently open for
-- booking (unchanged behaviour from before this migration).
CREATE POLICY "trips are visible while scheduled"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (status = 'scheduled');

-- A driver can always see their own trip, at any status — scheduled,
-- ongoing, completion_pending, completed, or cancelled.
CREATE POLICY "driver can view own trips at any status"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (driver_id = auth.uid());

-- THE FIX: a passenger can always see a trip they have (or had) a booking
-- on, at any trip status — this is what was missing. Deliberately not
-- filtered by booking status: a cancelled or no-show booking should still
-- show the passenger which trip it referred to.
CREATE POLICY "passenger can view trips they booked"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.trip_id = trips.id AND b.passenger_id = auth.uid()
    )
  );

-- Admins can see every trip regardless of status, for oversight.
CREATE POLICY "admin can view all trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- ============================================================================
-- End of migration. This only adds SELECT visibility on public.trips;
-- INSERT/UPDATE/DELETE policies, every other table, and all RPCs are
-- untouched.
-- ============================================================================
