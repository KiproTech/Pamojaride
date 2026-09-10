import { supabase } from './supabase';

// ============================================================================
// Trip completion — individual (per-passenger) accept/decline workflow.
// See database/trip_completion_individual_confirmations.sql.
//
// Each passenger on a `completion_pending` trip responds independently:
// accepting marks ONLY their own booking 'completed' (and unlocks rating),
// declining requires a reason and marks ONLY their own booking 'no_show'.
// Nobody is ever auto-marked completed because other passengers responded.
// ============================================================================

export const DECLINE_REASONS = [
  { value: 'did_not_board', label: 'I did not board this trip' },
  { value: 'trip_cancelled', label: 'The trip was cancelled' },
  { value: 'did_not_complete', label: 'I did not complete the journey' },
  { value: 'marked_incorrectly', label: 'Driver marked the trip incorrectly' },
  { value: 'other', label: 'Other' },
];

// Fetches the live aggregate completion status (accepted/declined/pending
// counts, seconds left, and the CALLER's own response) for one trip that's
// in (or was in) the completion window. Safe to call for a driver, a
// passenger with a booking on the trip, or an admin — the RPC enforces that.
export async function fetchTripCompletionStatus(tripId) {
  const { data, error } = await supabase.rpc('get_trip_completion_status', { p_trip_id: tripId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
}

// Fetches completion status for several trips at once (e.g. every
// completion_pending trip on a driver's dashboard). Failures for one trip
// don't block the others.
export async function fetchTripCompletionStatuses(tripIds) {
  const uniqueIds = [...new Set(tripIds)];
  const entries = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const status = await fetchTripCompletionStatus(id);
        return [id, status];
      } catch (err) {
        console.error('fetchTripCompletionStatus error for', id, err);
        return [id, null];
      }
    })
  );
  return Object.fromEntries(entries);
}

// Driver/admin (or a passenger, scoped to just their own row): the full
// per-passenger breakdown for one trip — who accepted, who declined (and
// why), who's still pending. Used by the driver's "View passenger
// confirmations" panel and the admin trip-oversight detail view.
export async function fetchTripPassengerCompletions(tripId) {
  const { data, error } = await supabase.rpc('get_trip_passenger_completions', { p_trip_id: tripId });
  if (error) throw error;
  return data || [];
}

// Passenger action: accept a completion_pending trip's request. Marks only
// this passenger's own booking 'completed'.
export async function acceptTripCompletion(tripId) {
  const { data, error } = await supabase.rpc('respond_trip_completion', {
    p_trip_id: tripId,
    p_response: 'accepted',
  });
  if (error) throw error;
  return data;
}

// Passenger action: decline a completion_pending trip's request. A reason
// is required (comment required too when reason === 'other'), matching
// respond_trip_completion()'s own server-side validation.
export async function declineTripCompletion(tripId, reason, comment) {
  const { data, error } = await supabase.rpc('respond_trip_completion', {
    p_trip_id: tripId,
    p_response: 'declined',
    p_decline_reason: reason,
    p_decline_comment: comment || null,
  });
  if (error) throw error;
  return data;
}

// Opportunistic client-side nudge: asks the database to finalize any
// completion_pending trips whose deadline has already passed. This only
// ever closes the TRIP's own status — it never touches an individual
// passenger's still-pending confirmation or booking. Purely a convenience
// so someone with the app open doesn't wait for the next pg_cron tick; the
// deadline is always enforced server-side regardless (see
// database/trip_completion_individual_confirmations.sql).
export async function nudgeAutoCompletion() {
  try {
    await supabase.rpc('auto_complete_pending_trips');
  } catch (err) {
    console.error('nudgeAutoCompletion error:', err);
  }
}

// Formats seconds remaining as "12:34 left" for display next to the
// trip-level backstop countdown.
export function formatSecondsRemaining(seconds) {
  if (seconds == null) return '';
  const s = Math.max(0, Math.floor(seconds));
  if (s <= 0) return 'Finalizing…';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  const r = s % 60;
  if (m === 0) return `${r}s left`;
  return `${m}:${String(r).padStart(2, '0')} left`;
}
