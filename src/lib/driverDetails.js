import { supabase } from './supabase';

// Fetches the full driver details bundle (name, photo, phone, vehicle,
// verification status) for a trip the caller has a confirmed/completed
// booking on. The RPC itself enforces that authorization — see
// database/passenger_driver_details.sql. Returns null if the caller isn't
// authorized or the RPC errors, rather than throwing, so a single failed
// card doesn't take down the rest of the bookings list.
export async function fetchBookedTripDriverDetails(tripId) {
  const { data, error } = await supabase.rpc('get_booked_trip_driver_details', { p_trip_id: tripId });
  if (error) {
    console.error('fetchBookedTripDriverDetails error for', tripId, error);
    return null;
  }
  return Array.isArray(data) ? data[0] || null : data || null;
}

// Fetches driver details for several trips at once (e.g. every confirmed
// booking on My Bookings). Failures for one trip don't block the others.
export async function fetchBookedTripDriverDetailsBatch(tripIds) {
  const uniqueIds = [...new Set(tripIds)];
  const entries = await Promise.all(
    uniqueIds.map(async (id) => [id, await fetchBookedTripDriverDetails(id)])
  );
  return Object.fromEntries(entries);
}

// Fetches the PRE-booking driver trust preview (name, photo, rating, trust
// level, verification status, vehicle) for one or more trips in a single
// round trip — used on the search results page and trip details, before a
// booking exists. Deliberately does NOT include phone; see
// database/trip_search_driver_preview.sql for why. Returns a map keyed by
// trip_id; trips the RPC couldn't resolve are simply absent from the map
// rather than causing the whole batch to fail.
export async function fetchTripDriverPreviews(tripIds) {
  const uniqueIds = [...new Set(tripIds)].filter(Boolean);
  if (uniqueIds.length === 0) return {};
  const { data, error } = await supabase.rpc('get_trip_driver_previews', { p_trip_ids: uniqueIds });
  if (error) {
    console.error('fetchTripDriverPreviews error', error);
    return {};
  }
  return Object.fromEntries((data || []).map(row => [row.trip_id, row]));
}

// Fetches a page of a driver's reviews (rating, comment, date, and a
// privacy-safe reviewer display name — first name + last initial, never
// phone/email/full name) via the get_driver_reviews() RPC. Used both
// pre-booking (TripDetails.jsx, so a passenger can read what past riders
// said) and on the driver's own dashboard ("Recent reviews"). See
// database/driver_reviews_display.sql. Returns an empty list (not a throw)
// on error so a failed reviews fetch never blocks the rest of the page.
export async function fetchDriverReviews(driverId, { limit = 10, offset = 0 } = {}) {
  if (!driverId) return { reviews: [], totalCount: 0 };
  const { data, error } = await supabase.rpc('get_driver_reviews', {
    p_driver_id: driverId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    console.error('fetchDriverReviews error', error);
    return { reviews: [], totalCount: 0, error: error.message };
  }
  const rows = data || [];
  return { reviews: rows, totalCount: rows[0]?.total_count ?? 0 };
}
