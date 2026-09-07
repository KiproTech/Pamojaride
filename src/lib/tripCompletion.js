import { supabase } from './supabase';

// Fetches the live completion status (confirmations so far / required,
// seconds left, etc.) for one trip that's in (or was in) the 20-minute
// completion_pending window. Safe to call for a driver, a passenger with a
// booking on the trip, or an admin — the RPC itself enforces that.
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

// Passenger action: confirm that a completion_pending trip actually finished.
export async function confirmTripCompletion(tripId) {
  const { data, error } = await supabase.rpc('confirm_trip_completion', { p_trip_id: tripId });
  if (error) throw error;
  return data;
}

// Opportunistic client-side nudge: asks the database to finalize any
// completion_pending trips whose 20-minute deadline has already passed.
// This is purely a convenience so someone who has the app open doesn't
// have to wait for the next pg_cron tick (up to 1 minute) — the deadline
// itself is always enforced server-side regardless of whether this is ever
// called (see database/trip_auto_completion.sql, section 10, pg_cron).
export async function nudgeAutoCompletion() {
  try {
    await supabase.rpc('auto_complete_pending_trips');
  } catch (err) {
    // Non-fatal: the scheduled job is the source of truth for this.
    console.error('nudgeAutoCompletion error:', err);
  }
}

// Formats seconds remaining as "12:34 left" / "less than a minute left" /
// "any moment now" for display next to a countdown.
export function formatSecondsRemaining(seconds) {
  if (seconds == null) return '';
  const s = Math.max(0, Math.floor(seconds));
  if (s <= 0) return 'Finalizing…';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s left`;
  return `${m}:${String(r).padStart(2, '0')} left`;
}
