import { supabase } from '../supabase';

// Data-fetching / submission helpers for the Customer Support feature
// (Passenger + Driver). Reads go through the RPCs added in
// database/customer_support_system.sql (get_my_support_bookings /
// get_my_support_requests) rather than a raw `.select()` — those RPCs
// already scope everything to the signed-in user server-side and resolve
// trip/booking context safely (a client-side embed on `profiles` silently
// returns null because profiles' RLS only allows reading your own row).
// Submission is a plain `.insert()` into `support_requests`, gated by that
// table's own RLS policy — the authenticated user's identity comes from
// the Supabase auth session, never from anything typed into the form.

// Fetches booking/trip options for the Contact Support form's "Related
// booking/trip" dropdown. Returns [] (never throws) on error.
export async function fetchMySupportBookings() {
  const { data, error } = await supabase.rpc('get_my_support_bookings');
  if (error) {
    console.error('fetchMySupportBookings error:', error);
    return { bookings: [], error };
  }
  return { bookings: data || [], error: null };
}

// Fetches the signed-in user's own support requests.
export async function fetchMySupportRequests() {
  const { data, error } = await supabase.rpc('get_my_support_requests');
  if (error) {
    console.error('fetchMySupportRequests error:', error);
    return { requests: [], error };
  }
  return { requests: data || [], error: null };
}

// Fetches a single support request the signed-in user submitted. Returns
// null (not an error) if the RPC comes back empty — happens both when the
// id doesn't exist and when it belongs to someone else, deliberately
// indistinguishable to the caller.
export async function fetchMySupportRequestDetail(requestId) {
  const { data, error } = await supabase.rpc('get_my_support_requests', { p_request_id: requestId });
  if (error) {
    console.error('fetchMySupportRequestDetail error:', error);
    return { request: null, error };
  }
  const request = Array.isArray(data) ? data[0] || null : null;
  return { request, error: null };
}

// Submits a new support request. `userId` is passed down from the caller
// (already sourced from useAuth()'s signed-in session), matching the same
// pattern ReportModal.jsx uses for reporter_id — never something the user
// types in themselves.
export async function submitSupportRequest({ userId, category, subject, message, tripId, bookingId }) {
  if (!userId) return { error: { message: 'You must be signed in to contact support.' } };

  const { error } = await supabase.from('support_requests').insert({
    user_id: userId,
    category,
    subject: subject.trim(),
    message: message.trim(),
    trip_id: tripId || null,
    booking_id: bookingId || null,
  });

  if (error) {
    console.error('submitSupportRequest error:', error);
    // Never surface a raw Postgres/PostgREST error to the user.
    return { error: { message: "We couldn't submit your request right now. Please try again." } };
  }
  return { error: null };
}
