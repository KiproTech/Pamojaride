-- ============================================================================
-- PamojaRide — Trip Location Validation & Route/Travel-Time Estimation
-- Run this once in the Supabase SQL Editor.
-- ============================================================================
--
-- WHAT THIS IS FOR
-- CreateTrip.jsx now requires the driver to pick pickup and destination
-- from a real, geocoded location (via OpenStreetMap Nominatim) instead of
-- typing free text, and computes a route distance/duration (via the OSRM
-- routing service, with a straight-line fallback) before the trip can be
-- saved. This migration adds the columns needed to store that resolved
-- data on the trip row itself, so it's available later for trip
-- scheduling and overlap-prevention work (a future prompt) without having
-- to re-geocode or re-run routing at that point.
--
-- `estimated_arrival_time` already existed on `public.trips` (defined in
-- db.sql) but was never actually populated by the app — CreateTrip.jsx now
-- sets it to departure_time + the calculated route duration.
--
-- SAFE TO RUN MULTIPLE TIMES: every ADD COLUMN uses IF NOT EXISTS, and the
-- CHECK constraints are dropped-then-recreated by name. No existing rows,
-- tables, functions, or policies are touched — all new columns are
-- nullable, so historical trips created before this change (which have no
-- coordinates/route data) remain valid as-is.
-- ============================================================================

-- 1. New columns on public.trips ---------------------------------------------
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS origin_lat numeric,
  ADD COLUMN IF NOT EXISTS origin_lng numeric,
  ADD COLUMN IF NOT EXISTS destination_lat numeric,
  ADD COLUMN IF NOT EXISTS destination_lng numeric,
  ADD COLUMN IF NOT EXISTS route_distance_km numeric,
  ADD COLUMN IF NOT EXISTS route_duration_minutes integer;

COMMENT ON COLUMN public.trips.origin_lat IS 'Latitude of the geocoded pickup location (Nominatim). Null for trips created before location validation was added.';
COMMENT ON COLUMN public.trips.origin_lng IS 'Longitude of the geocoded pickup location (Nominatim).';
COMMENT ON COLUMN public.trips.destination_lat IS 'Latitude of the geocoded destination location (Nominatim).';
COMMENT ON COLUMN public.trips.destination_lng IS 'Longitude of the geocoded destination location (Nominatim).';
COMMENT ON COLUMN public.trips.route_distance_km IS 'Driving distance in km between pickup and destination, from OSRM (or a straight-line estimate if OSRM was unreachable at creation time).';
COMMENT ON COLUMN public.trips.route_duration_minutes IS 'Estimated driving duration in minutes, used to derive estimated_arrival_time from departure_time.';

-- 2. Sanity CHECK constraints (nullable-safe: a NULL value always passes,
--    so these only guard new/updated rows that actually carry this data) --
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_origin_lat_range;
ALTER TABLE public.trips ADD CONSTRAINT trips_origin_lat_range
  CHECK (origin_lat IS NULL OR origin_lat BETWEEN -90 AND 90);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_origin_lng_range;
ALTER TABLE public.trips ADD CONSTRAINT trips_origin_lng_range
  CHECK (origin_lng IS NULL OR origin_lng BETWEEN -180 AND 180);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_destination_lat_range;
ALTER TABLE public.trips ADD CONSTRAINT trips_destination_lat_range
  CHECK (destination_lat IS NULL OR destination_lat BETWEEN -90 AND 90);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_destination_lng_range;
ALTER TABLE public.trips ADD CONSTRAINT trips_destination_lng_range
  CHECK (destination_lng IS NULL OR destination_lng BETWEEN -180 AND 180);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_route_distance_positive;
ALTER TABLE public.trips ADD CONSTRAINT trips_route_distance_positive
  CHECK (route_distance_km IS NULL OR route_distance_km > 0);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_route_duration_positive;
ALTER TABLE public.trips ADD CONSTRAINT trips_route_duration_positive
  CHECK (route_duration_minutes IS NULL OR route_duration_minutes > 0);

-- Backstop against an exact-duplicate-coordinate pickup/destination slipping
-- through (the app's own same-location check uses a ~1km radius, which SQL
-- can't easily express as a portable CHECK — this catches the exact-match
-- case as defense-in-depth, not a replacement for the app-side check).
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_pickup_destination_not_identical;
ALTER TABLE public.trips ADD CONSTRAINT trips_pickup_destination_not_identical
  CHECK (
    origin_lat IS NULL OR destination_lat IS NULL
    OR origin_lat <> destination_lat OR origin_lng <> destination_lng
  );

-- No RLS changes needed: these are plain additional columns on a table
-- whose existing insert/update policies already govern the whole row.
-- ============================================================================
