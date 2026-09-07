import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import TripCard from '../../components/shared/TripCard';
import CancelTripModal from '../../components/driver/CancelTripModal';
import CompletionStatus from '../../components/shared/CompletionStatus';
import { fetchTripCompletionStatuses, nudgeAutoCompletion } from '../../lib/tripCompletion';

// ── status grouping ──────────────────────────────────────────────────────
// Mirrors driver/Dashboard.jsx's own grouping exactly, so a trip always
// lands in the same bucket on both pages. Nothing here is a fabricated
// status — everything is derived from the real `status` + `departure_time`
// columns on `trips`. A trip in `completion_pending` (driver has marked it
// finished, waiting on the 20-minute passenger-confirmation window) is
// still shown as "Active" — it's the same in-progress bucket, just in its
// final stage.
function isUpcomingTrip(trip) {
  return trip.status === 'scheduled' && new Date(trip.departure_time) > new Date();
}
function isActiveTrip(trip) {
  if (trip.status === 'ongoing' || trip.status === 'completion_pending') return true;
  return trip.status === 'scheduled' && new Date(trip.departure_time) <= new Date();
}
function isCompletedTrip(trip) {
  return trip.status === 'completed' || trip.status === 'expired';
}
function isCancelledTrip(trip) {
  return trip.status === 'cancelled';
}

const TABS = [
  {
    key: 'upcoming', label: 'Upcoming', predicate: isUpcomingTrip,
    emptyIcon: '🗓️', emptyTitle: 'No upcoming trips',
  },
  {
    key: 'active', label: 'Active', predicate: isActiveTrip,
    emptyIcon: '🟠', emptyTitle: 'No active trips',
    emptyText: "Trips currently in progress will show up here.",
  },
  {
    key: 'completed', label: 'Completed', predicate: isCompletedTrip,
    emptyIcon: '✅', emptyTitle: 'No completed trips',
    emptyText: "Trips you've finished driving will appear here.",
  },
  {
    key: 'cancelled', label: 'Cancelled', predicate: isCancelledTrip,
    emptyIcon: '🚫', emptyTitle: 'No cancelled trips',
    emptyText: "Trips you cancel will be listed here.",
  },
];

// Bookings that still count toward "who's on this trip" — excludes
// cancelled/no-show, so the passenger count reflects real, current riders.
const LIVE_BOOKING_STATUSES = ['pending', 'confirmed', 'completed'];

export default function ManageTrips() {
  const { user, isDriverVerified } = useAuth();
  const [trips, setTrips] = useState([]);
  const [bookingStats, setBookingStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('upcoming');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [cancelTarget, setCancelTarget] = useState(null); // trip being considered for cancellation
  const [cancelModalError, setCancelModalError] = useState('');
  const [completionStatuses, setCompletionStatuses] = useState({}); // tripId -> get_trip_completion_status row
  const [completionLoading, setCompletionLoading] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async ({ silent } = {}) => {
    if (!user) return;
    if (silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const { data: tripsData, error: tripsErr } = await supabase
        .from('trips')
        .select('*')
        .eq('driver_id', user.id)
        .order('departure_time', { ascending: false });

      if (tripsErr) throw tripsErr;
      const list = tripsData || [];
      setTrips(list);

      const tripIds = list.map(t => t.id);
      if (tripIds.length > 0) {
        const { data: bookingsData, error: bookingsErr } = await supabase
          .from('bookings')
          .select('trip_id, seats_booked, passenger_id, status')
          .in('trip_id', tripIds)
          .in('status', LIVE_BOOKING_STATUSES);

        if (bookingsErr) throw bookingsErr;

        const grouped = {};
        for (const b of bookingsData || []) {
          if (!grouped[b.trip_id]) grouped[b.trip_id] = { seats: 0, passengers: new Set() };
          grouped[b.trip_id].seats += Number(b.seats_booked || 0);
          grouped[b.trip_id].passengers.add(b.passenger_id);
        }
        const stats = {};
        Object.entries(grouped).forEach(([tripId, v]) => {
          stats[tripId] = { seatsBooked: v.seats, passengerCount: v.passengers.size };
        });
        setBookingStats(stats);
      } else {
        setBookingStats({});
      }
    } catch (err) {
      console.error('ManageTrips load error:', err);
      setError('Could not load your trips. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // While any trip is in `completion_pending`, poll its confirmation
  // progress/time-remaining every 15s (and nudge the server-side auto-
  // completion check so a trip whose 20 minutes already elapsed flips over
  // without waiting for the next pg_cron tick). The 20-minute deadline
  // itself is always enforced in the database regardless of this polling —
  // see database/trip_auto_completion.sql.
  useEffect(() => {
    const pendingIds = trips.filter(t => t.status === 'completion_pending').map(t => t.id);
    if (pendingIds.length === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    let cancelled = false;
    async function poll() {
      setCompletionLoading(true);
      await nudgeAutoCompletion();
      const statuses = await fetchTripCompletionStatuses(pendingIds);
      if (!cancelled) {
        setCompletionStatuses(prev => ({ ...prev, ...statuses }));
        setCompletionLoading(false);
        // If the server just auto-completed or threshold-completed one of
        // these trips, refresh the trip list so it moves out of "Active".
        if (Object.values(statuses).some(s => s && s.status !== 'completion_pending')) {
          load({ silent: true });
        }
      }
    }

    poll();
    pollRef.current = setInterval(poll, 15000);
    return () => { cancelled = true; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips.map(t => `${t.id}:${t.status}`).join(',')]);

  // Opens the professional confirmation dialog instead of cancelling right
  // away. Only ever called for an upcoming (not-yet-started) trip — the
  // "Cancel trip" button is not rendered at all once a trip is active, and
  // the cancel_trip RPC enforces the same rule server-side regardless.
  function openCancelModal(trip) {
    setCancelModalError('');
    setCancelTarget(trip);
  }

  async function confirmCancelTrip({ category, details }) {
    if (!cancelTarget) return;
    setBusyId(cancelTarget.id);
    setCancelModalError('');
    // p_reason_category is the mandatory fixed reason; p_reason only carries
    // free text, and only matters when category is 'other' — cancel_trip
    // validates both server-side regardless of what the UI already checked.
    const { error: err } = await supabase.rpc('cancel_trip', {
      p_trip_id: cancelTarget.id,
      p_reason_category: category,
      p_reason: details,
    });
    setBusyId(null);
    if (err) {
      setCancelModalError(err.message);
    } else {
      setCancelTarget(null);
      load({ silent: true });
    }
  }

  async function handleComplete(tripId) {
    if (!confirm("Mark this trip as finished? If there are passengers on board, they'll get 20 minutes to confirm before it's completed automatically.")) return;
    setBusyId(tripId); setActionError('');
    const { error: err } = await supabase.rpc('complete_trip', { p_trip_id: tripId });
    setBusyId(null);
    if (err) setActionError(err.message); else load({ silent: true });
  }

  const counts = {
    upcoming: trips.filter(isUpcomingTrip).length,
    active: trips.filter(isActiveTrip).length,
    completed: trips.filter(isCompletedTrip).length,
    cancelled: trips.filter(isCancelledTrip).length,
  };

  const activeTab = TABS.find(t => t.key === filter) || TABS[0];
  const filtered = trips
    .filter(activeTab.predicate)
    .sort((a, b) => {
      // Upcoming/active: soonest departure first. Completed/cancelled: most recent first.
      if (filter === 'upcoming' || filter === 'active') {
        return new Date(a.departure_time) - new Date(b.departure_time);
      }
      const aWhen = a.cancelled_at || a.updated_at || a.departure_time;
      const bWhen = b.cancelled_at || b.updated_at || b.departure_time;
      return new Date(bWhen) - new Date(aWhen);
    });

  return (
    <DashboardLayout title="My Trips">
      <div className="page-header flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>My Trips</h1>
          <p>Manage the trips you've posted, from booking to completion.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => load({ silent: true })}
            disabled={loading || refreshing}
            title="Refresh"
          >
            {refreshing ? <span className="spinner" /> : '↻ Refresh'}
          </button>
          {isDriverVerified && <Link to="/driver/create-trip" className="btn btn-primary btn-sm">+ Post a trip</Link>}
        </div>
      </div>

      {/* Summary stats */}
      <div className="driver-stats-grid" style={{ marginBottom: 20 }}>
        {loading ? (
          <>
            <StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard label="Upcoming" value={counts.upcoming} />
            <StatCard label="Active" value={counts.active} />
            <StatCard label="Completed" value={counts.completed} />
            <StatCard label="Cancelled" value={counts.cancelled} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`btn btn-sm ${filter === t.key ? 'btn-primary' : 'btn-outline'}`}
          >
            {t.label} {!loading && <span style={{ opacity: 0.75 }}>({counts[t.key]})</span>}
          </button>
        ))}
      </div>

      {actionError && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{actionError}</div>}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <TripCardSkeleton /><TripCardSkeleton /><TripCardSkeleton />
        </div>
      ) : error ? (
        <div className="empty-state">
          <div className="empty-icon">⚠️</div>
          <h3>Something went wrong</h3>
          <p>{error}</p>
          <button className="btn btn-sm btn-primary" style={{ marginTop: 14 }} onClick={() => load()}>Try again</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">{activeTab.emptyIcon}</div>
          <h3>{activeTab.emptyTitle}</h3>
          <p>
            {activeTab.key === 'upcoming'
              ? (isDriverVerified ? "Post a trip to start earning." : "Get verified to post your first trip.")
              : activeTab.emptyText}
          </p>
          {activeTab.key === 'upcoming' && isDriverVerified && (
            <Link to="/driver/create-trip" className="btn btn-primary btn-sm" style={{ marginTop: 14 }}>+ Post a trip</Link>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filtered.map(trip => {
            const stats = bookingStats[trip.id];
            return (
              <TripCard
                key={trip.id}
                trip={trip}
                passengerCount={stats ? stats.passengerCount : 0}
                seatsBooked={stats ? stats.seatsBooked : undefined}
                statusExtra={trip.status === 'completion_pending' && (
                  <CompletionStatus status={completionStatuses[trip.id]} loading={completionLoading} />
                )}
                actions={
                  <>
                    <Link to={`/driver/bookings?trip=${trip.id}`} className="btn btn-sm btn-outline">
                      View bookings
                    </Link>
                    {isUpcomingTrip(trip) && (
                      <button className="btn btn-sm btn-danger" disabled={busyId === trip.id} onClick={() => openCancelModal(trip)}>
                        {busyId === trip.id ? <span className="spinner" /> : 'Cancel trip'}
                      </button>
                    )}
                    {isActiveTrip(trip) && trip.status !== 'completion_pending' && (
                      // Once a trip has started (ongoing, or scheduled but past its
                      // departure time) it can no longer be cancelled by the driver —
                      // only "Mark completed" remains available here. Once marked,
                      // it moves to `completion_pending` and this button disappears
                      // in favor of the countdown/confirmation status above.
                      <button className="btn btn-sm btn-primary" disabled={busyId === trip.id} onClick={() => handleComplete(trip.id)}>
                        {busyId === trip.id ? <span className="spinner" /> : 'Mark completed'}
                      </button>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {cancelTarget && (
        <CancelTripModal
          trip={cancelTarget}
          passengerCount={bookingStats[cancelTarget.id]?.passengerCount || 0}
          seatsBooked={bookingStats[cancelTarget.id]?.seatsBooked || 0}
          busy={busyId === cancelTarget.id}
          error={cancelModalError}
          onConfirm={confirmCancelTrip}
          onClose={() => { if (busyId !== cancelTarget.id) setCancelTarget(null); }}
        />
      )}
    </DashboardLayout>
  );
}

// ── small presentational helpers ────────────────────────────────────────
function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function StatCardSkeleton() {
  return (
    <div className="skeleton-stat-card">
      <div className="skeleton skeleton-text" style={{ width: '50%' }} />
      <div className="skeleton skeleton-title" style={{ width: '40%' }} />
    </div>
  );
}

function TripCardSkeleton() {
  return (
    <div className="card card-pad">
      <div className="skeleton skeleton-text" style={{ width: '40%', marginBottom: 10 }} />
      <div className="skeleton skeleton-text" style={{ width: '25%', marginBottom: 16 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 8 }}>
        <div className="skeleton skeleton-text" style={{ width: '70%' }} />
        <div className="skeleton skeleton-text" style={{ width: '70%' }} />
        <div className="skeleton skeleton-text" style={{ width: '70%' }} />
      </div>
    </div>
  );
}
