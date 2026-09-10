import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import VerificationPopup from '../../components/driver/Verificationpopup';
import CancelTripModal from '../../components/driver/CancelTripModal';
import CompletionStatus from '../../components/shared/CompletionStatus';
import TripPassengerCompletionsModal from '../../components/shared/TripPassengerCompletionsModal';
import ReviewsList from '../../components/shared/ReviewsList';
import { fetchTripCompletionStatuses, nudgeAutoCompletion } from '../../lib/tripCompletion';
import { fetchDriverReviews } from '../../lib/driverDetails';

// ── formatting helpers ──────────────────────────────────────────────────
function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

function formatDateShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

// A trip counts as "active / in progress" if it's explicitly ongoing, or if
// it's still scheduled but its departure time has already passed (the same
// live-data condition ManageTrips uses to surface "Mark completed") — never
// a fabricated status, always derived from real columns.
function isActiveTrip(trip) {
  if (trip.status === 'ongoing' || trip.status === 'completion_pending') return true;
  return trip.status === 'scheduled' && new Date(trip.departure_time) <= new Date();
}
function isUpcomingTrip(trip) {
  return trip.status === 'scheduled' && new Date(trip.departure_time) > new Date();
}
// Mirrors ManageTrips' own "Past" grouping (completed + expired together).
function isPastTrip(trip) {
  return trip.status === 'completed' || trip.status === 'expired';
}

const VERIFICATION_META = {
  verified:             { label: 'Verified driver',   badge: 'badge-green' },
  pending_verification: { label: 'Under review',      badge: 'badge-teal' },
  under_review:         { label: 'Under review',      badge: 'badge-teal' },
  rejected:             { label: 'Action needed',     badge: 'badge-danger' },
};
function verificationMeta(status) {
  return VERIFICATION_META[status] || { label: 'Not verified', badge: 'badge-amber' };
}

const TRIP_STATUS_BADGE = {
  scheduled: 'badge-teal', ongoing: 'badge-amber', completion_pending: 'badge-amber', completed: 'badge-green',
  cancelled: 'badge-danger', expired: 'badge-gray',
};

const QUICK_ACTIONS = [
  { to: '/driver/create-trip', icon: '🚌', title: 'Post a trip', sub: 'Fill your empty seats', requiresVerified: true },
  { to: '/driver/trips', icon: '🗺️', title: 'Manage trips', sub: 'View and edit your posted trips' },
  { to: '/driver/bookings', icon: '🎫', title: 'Bookings', sub: "See who's booked your seats" },
  { to: '/driver/profile', icon: '👤', title: 'Profile', sub: 'Update your details' },
];

export default function Dashboard() {
  const { user, profile, driverProfile, verificationStatus, isDriverVerified } = useAuth();

  const [trips, setTrips] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [totalBookingsCount, setTotalBookingsCount] = useState(null);
  const [rating, setRating] = useState({ avg: null, count: 0 });
  const [reviews, setReviews] = useState([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewsError, setReviewsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyTripId, setBusyTripId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [cancelTarget, setCancelTarget] = useState(null); // trip being considered for cancellation
  const [cancelModalError, setCancelModalError] = useState('');
  const [completionStatuses, setCompletionStatuses] = useState({}); // tripId -> get_trip_completion_status row
  const [completionLoading, setCompletionLoading] = useState(false);
  const [passengerCompletionsTrip, setPassengerCompletionsTrip] = useState(null); // trip whose per-passenger modal is open
  const pollRef = useRef(null);

  const [notifications, setNotifications] = useState([]);
  const [notifLoading, setNotifLoading] = useState(true);

  async function loadDashboard() {
    if (!user) return;
    setError('');

    try {
      const [tripsRes, bookingsRes, countRes, ratingsRes] = await Promise.all([
        supabase
          .from('trips')
          .select('id, origin, destination, departure_time, price_per_seat, total_seats, available_seats, vehicle_make, vehicle_model, vehicle_plate, status, cancellation_reason, cancelled_at, updated_at')
          .eq('driver_id', user.id)
          .order('departure_time', { ascending: false }),
        supabase
          .from('bookings')
          .select('id, seats_booked, total_price, status, created_at, passenger_id, trip_id, profiles:passenger_id(full_name), trips!inner(id, origin, destination, departure_time, status, driver_id)')
          .eq('trips.driver_id', user.id)
          .order('created_at', { ascending: false })
          .limit(300),
        supabase
          .from('bookings')
          .select('id, trips!inner(driver_id)', { count: 'exact', head: true })
          .eq('trips.driver_id', user.id),
        supabase
          .from('ratings')
          .select('rating')
          .eq('ratee_id', user.id)
          .eq('rating_type', 'passenger_to_driver'),
      ]);

      for (const res of [tripsRes, bookingsRes, countRes, ratingsRes]) {
        if (res.error) throw res.error;
      }

      setTrips(tripsRes.data || []);
      setBookings(bookingsRes.data || []);
      setTotalBookingsCount(typeof countRes.count === 'number' ? countRes.count : (bookingsRes.data || []).length);

      const ratingsData = ratingsRes.data || [];
      setRating({
        avg: ratingsData.length ? (ratingsData.reduce((s, r) => s + r.rating, 0) / ratingsData.length).toFixed(1) : null,
        count: ratingsData.length,
      });
    } catch (err) {
      console.error('Driver dashboard load error:', err);
      setError('Some data failed to load. Pull to refresh or try again shortly.');
    } finally {
      setLoading(false);
    }
  }

  async function loadNotifications() {
    if (!user) return;
    setNotifLoading(true);
    try {
      const { data, error: err } = await supabase
        .from('notifications')
        .select('id, type, title, body, is_read, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (err) throw err;
      setNotifications(data || []);
    } catch (err) {
      console.error('Driver dashboard notifications load error:', err);
    } finally {
      setNotifLoading(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    (async () => { if (active) await loadDashboard(); })();
    (async () => { if (active) await loadNotifications(); })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Recent reviews received by this driver (rating, comment, date, and a
  // privacy-safe reviewer name only — never a passenger's phone/email). Uses
  // the same get_driver_reviews() RPC passengers use pre-booking, called
  // with the signed-in driver's own id. See database/driver_reviews_display.sql.
  useEffect(() => {
    if (!user) return;
    let active = true;
    setReviewsLoading(true);
    fetchDriverReviews(user.id, { limit: 5 }).then(({ reviews: rows, error: err }) => {
      if (!active) return;
      setReviews(rows);
      setReviewsError(err || '');
      setReviewsLoading(false);
    });
    return () => { active = false; };
  }, [user]);

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
        if (Object.values(statuses).some(s => s && s.status !== 'completion_pending')) {
          loadDashboard();
        }
      }
    }

    poll();
    pollRef.current = setInterval(poll, 15000);
    return () => { cancelled = true; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips.map(t => `${t.id}:${t.status}`).join(',')]);

  async function markNotificationRead(notif) {
    if (notif.is_read) return;
    setNotifications(prev => prev.map(n => (n.id === notif.id ? { ...n, is_read: true } : n)));
    const { error: err } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notif.id);
    if (err) console.error('Failed to mark notification read:', err);
  }

  async function markAllNotificationsRead() {
    const unread = notifications.filter(n => !n.is_read);
    if (unread.length === 0) return;
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    const { error: err } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('is_read', false);
    if (err) console.error('Failed to mark all notifications read:', err);
  }

  async function handleCompleteTrip(tripId) {
    if (!confirm("Mark this trip as finished? Each passenger will be asked individually to confirm or decline — nobody is marked completed automatically just because others confirm.")) return;
    setBusyTripId(tripId); setActionError('');
    const { error: err } = await supabase.rpc('complete_trip', { p_trip_id: tripId });
    setBusyTripId(null);
    if (err) setActionError(err.message); else loadDashboard();
  }

  // Opens the professional confirmation dialog instead of cancelling right
  // away. Only ever wired up for upcoming (not-yet-started) trips — once a
  // trip is active it has no Cancel action at all, and cancel_trip enforces
  // the same rule server-side regardless.
  function openCancelModal(trip) {
    setCancelModalError('');
    setCancelTarget(trip);
  }

  // Live (non-cancelled, non-no-show) booking stats for one trip, derived
  // from the same `bookings` list the rest of the dashboard already uses.
  function getTripBookingStats(tripId) {
    const live = bookings.filter(b => b.trip_id === tripId && ['pending', 'confirmed'].includes(b.status));
    return {
      passengerCount: new Set(live.map(b => b.passenger_id)).size,
      seatsBooked: live.reduce((sum, b) => sum + Number(b.seats_booked || 0), 0),
    };
  }

  async function confirmCancelTrip({ category, details }) {
    if (!cancelTarget) return;
    setBusyTripId(cancelTarget.id);
    setCancelModalError('');
    // p_reason_category is the mandatory fixed reason; p_reason only carries
    // free text, and only matters when category is 'other' — cancel_trip
    // validates both server-side regardless of what the UI already checked.
    const { error: err } = await supabase.rpc('cancel_trip', {
      p_trip_id: cancelTarget.id,
      p_reason_category: category,
      p_reason: details,
    });
    setBusyTripId(null);
    if (err) {
      setCancelModalError(err.message);
    } else {
      setCancelTarget(null);
      loadDashboard();
    }
  }

  // ── derive real sections straight from live trip/booking data ─────────
  const activeTrips = trips.filter(isActiveTrip).sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));
  const upcomingTrips = trips.filter(isUpcomingTrip).sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));
  const completedTrips = trips.filter(isPastTrip).sort((a, b) => new Date(b.departure_time) - new Date(a.departure_time));
  const cancelledTrips = trips.filter(t => t.status === 'cancelled').sort((a, b) => new Date(b.cancelled_at || b.updated_at) - new Date(a.cancelled_at || a.updated_at));

  const liveTripIds = new Set([...activeTrips, ...upcomingTrips].map(t => t.id));
  const passengersBooked = bookings
    .filter(b => ['pending', 'confirmed'].includes(b.status) && liveTripIds.has(b.trip_id))
    .reduce((sum, b) => sum + Number(b.seats_booked || 0), 0);

  const weekAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weeklyBookings = bookings.filter(b => new Date(b.created_at) >= weekAgoDate);
  const weeklyEarnings = weeklyBookings
    .filter(b => ['confirmed', 'completed'].includes(b.status))
    .reduce((sum, b) => sum + Number(b.total_price || 0), 0);

  // Recent activity: recent bookings + recently cancelled trips, merged newest-first.
  const activityFromBookings = bookings.slice(0, 8).map(b => ({
    id: `booking-${b.id}`,
    at: b.created_at,
    icon: b.status === 'cancelled' ? '🚫' : '🎫',
    title: b.status === 'cancelled'
      ? `Booking cancelled — ${b.profiles?.full_name || 'a passenger'}`
      : `New booking from ${b.profiles?.full_name || 'a passenger'}`,
    sub: `${b.trips?.origin || '—'} → ${b.trips?.destination || '—'} · ${b.seats_booked} seat${b.seats_booked > 1 ? 's' : ''} · ${formatKES(b.total_price)}`,
  }));
  const activityFromTrips = trips.filter(t => t.status === 'cancelled' && t.cancelled_at).slice(0, 5).map(t => ({
    id: `trip-${t.id}`,
    at: t.cancelled_at,
    icon: '🗺️',
    title: `You cancelled a trip`,
    sub: `${t.origin} → ${t.destination} · ${formatDateShort(t.departure_time)}${t.cancellation_reason ? ` · ${t.cancellation_reason}` : ''}`,
  }));
  const recentActivity = [...activityFromBookings, ...activityFromTrips]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 6);

  const vMeta = verificationMeta(verificationStatus);
  const unreadNotifCount = notifications.filter(n => !n.is_read).length;

  return (
    <DashboardLayout title="Dashboard">
      <VerificationPopup status={verificationStatus} rejectionReason={driverProfile?.kyc_rejection_reason} />

      <div className="page-header flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Welcome back{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''} 👋</h1>
          <p>Here's what's happening with your trips today.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge ${vMeta.badge}`}>{vMeta.label}</span>
          <TrustBadge level={driverProfile?.trust_level} />
        </div>
      </div>

      {error && <div className="alert alert-amber" style={{ marginBottom: 20 }}>{error}</div>}
      {actionError && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{actionError}</div>}

      <div className="dash-layout">
        {/* ── Main column ─────────────────────────────────────────── */}
        <div className="dash-main">

          {/* Active / current trip */}
          {loading ? (
            <div className="skeleton-stat-card" style={{ padding: 24 }}>
              <div className="skeleton skeleton-text" style={{ width: '30%', marginBottom: 10 }} />
              <div className="skeleton skeleton-title" style={{ width: '60%' }} />
            </div>
          ) : activeTrips.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {activeTrips.map(trip => (
                <div key={trip.id} className="card card-pad driver-active-trip">
                  <div className="flex-between" style={{ marginBottom: 10, alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <span className="driver-section-eyebrow">🟠 Active trip — in progress</span>
                      <strong style={{ fontSize: 17, display: 'block', marginTop: 4 }}>{trip.origin} → {trip.destination}</strong>
                      <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>Departed {formatDateTime(trip.departure_time)}</p>
                    </div>
                    <span className={`badge ${TRIP_STATUS_BADGE[trip.status]}`}>
                      {trip.status === 'completion_pending' ? 'Awaiting confirmation' : trip.status}
                    </span>
                  </div>

                  <div className="grid-3" style={{ gap: 8, marginBottom: 16 }}>
                    <MiniStat label="Price/seat" value={formatKES(trip.price_per_seat)} />
                    <MiniStat label="Seats" value={`${trip.available_seats} / ${trip.total_seats} open`} />
                    <MiniStat label="Vehicle" value={trip.vehicle_plate || '—'} />
                  </div>

                  {trip.status === 'completion_pending' && (
                    <div style={{ marginBottom: 14 }}>
                      <CompletionStatus status={completionStatuses[trip.id]} loading={completionLoading} />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Link to={`/driver/bookings?trip=${trip.id}`} className="btn btn-sm btn-outline">View bookings</Link>
                    {trip.status === 'completion_pending' && (
                      <button className="btn btn-sm btn-outline" onClick={() => setPassengerCompletionsTrip(trip)}>
                        View passenger confirmations
                      </button>
                    )}
                    {trip.status !== 'completion_pending' && (
                      <button className="btn btn-sm btn-primary" disabled={busyTripId === trip.id} onClick={() => handleCompleteTrip(trip.id)}>
                        {busyTripId === trip.id ? <span className="spinner" /> : 'Mark completed'}
                      </button>
                    )}
                    {/* Once a trip has started (ongoing, or scheduled but past its
                        departure time) it can no longer be cancelled by the driver —
                        no Cancel action here, only Mark completed / the countdown above. */}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card card-pad" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 26 }}>🟢</span>
              <div>
                <strong style={{ fontSize: 14.5 }}>No trip in progress right now</strong>
                <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                  {isDriverVerified ? 'Post a trip to get moving.' : 'Complete verification to start posting trips.'}
                </p>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="driver-stats-grid">
            {loading ? (
              <>
                <StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton />
                <StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton />
              </>
            ) : (
              <>
                <StatCard label="Upcoming trips" value={upcomingTrips.length} />
                <StatCard label="Active trips" value={activeTrips.length} />
                <StatCard label="Completed trips" value={completedTrips.length} sub={`${driverProfile?.trips_completed || 0} lifetime`} />
                <StatCard label="Cancelled trips" value={cancelledTrips.length} />
                <StatCard label="Passengers booked" value={passengersBooked} sub={`${totalBookingsCount ?? '—'} bookings all-time`} />
                <StatCard label="Earnings this week" value={formatKES(weeklyEarnings)} sub={`${weeklyBookings.length} bookings this week`} />
              </>
            )}
          </div>

          {/* Upcoming trips */}
          <div className="card card-pad">
            <div className="flex-between" style={{ marginBottom: 14 }}>
              <h3 style={{ fontSize: 16 }}>Upcoming trips</h3>
              <Link to="/driver/trips" className="btn btn-sm btn-ghost">View all</Link>
            </div>

            {loading ? (
              <div><BookingRowSkeleton /><BookingRowSkeleton /></div>
            ) : upcomingTrips.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🗺️</div>
                <h3>No upcoming trips</h3>
                <p>{isDriverVerified ? 'Post a trip to start taking bookings.' : 'Get verified to post your first trip.'}</p>
                {isDriverVerified && <Link to="/driver/create-trip" className="btn btn-primary btn-sm" style={{ marginTop: 14 }}>+ Post a trip</Link>}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {upcomingTrips.slice(0, 4).map(trip => (
                  <div key={trip.id} className="driver-mini-row">
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ fontSize: 13.5 }}>{trip.origin} → {trip.destination}</strong>
                      <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
                        {formatDateTime(trip.departure_time)} · {trip.available_seats}/{trip.total_seats} seats open
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                      <span className={`badge ${TRIP_STATUS_BADGE[trip.status]}`}>{trip.status}</span>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={busyTripId === trip.id}
                        onClick={() => openCancelModal(trip)}
                        title="Cancel this trip"
                      >
                        {busyTripId === trip.id ? <span className="spinner" /> : 'Cancel'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Completed & cancelled */}
          <div className="driver-two-col">
            <div className="card card-pad">
              <div className="flex-between" style={{ marginBottom: 14 }}>
                <h3 style={{ fontSize: 16 }}>Completed trips</h3>
                <Link to="/driver/trips" className="btn btn-sm btn-ghost">View all</Link>
              </div>
              {loading ? (
                <BookingRowSkeleton />
              ) : completedTrips.length === 0 ? (
                <div className="empty-state" style={{ padding: '32px 12px' }}>
                  <div className="empty-icon" style={{ fontSize: 34 }}>✅</div>
                  <p>No completed trips yet.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {completedTrips.slice(0, 3).map(trip => (
                    <div key={trip.id} className="driver-mini-row">
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: 13.5 }}>{trip.origin} → {trip.destination}</strong>
                        <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{formatDateShort(trip.departure_time)}</p>
                      </div>
                      <span className={`badge ${TRIP_STATUS_BADGE[trip.status]}`}>{trip.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card card-pad">
              <div className="flex-between" style={{ marginBottom: 14 }}>
                <h3 style={{ fontSize: 16 }}>Cancelled trips</h3>
                <Link to="/driver/trips" className="btn btn-sm btn-ghost">View all</Link>
              </div>
              {loading ? (
                <BookingRowSkeleton />
              ) : cancelledTrips.length === 0 ? (
                <div className="empty-state" style={{ padding: '32px 12px' }}>
                  <div className="empty-icon" style={{ fontSize: 34 }}>🚫</div>
                  <p>No cancelled trips.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {cancelledTrips.slice(0, 3).map(trip => (
                    <div key={trip.id} className="driver-mini-row">
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: 13.5 }}>{trip.origin} → {trip.destination}</strong>
                        <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
                          {formatDateShort(trip.cancelled_at || trip.departure_time)}{trip.cancellation_reason ? ` · ${trip.cancellation_reason}` : ''}
                        </p>
                      </div>
                      <span className={`badge ${TRIP_STATUS_BADGE[trip.status]}`}>{trip.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recent activity */}
          <div className="card card-pad">
            <h3 style={{ fontSize: 16, marginBottom: 14 }}>Recent activity</h3>
            {loading ? (
              <div><BookingRowSkeleton /><BookingRowSkeleton /><BookingRowSkeleton /></div>
            ) : recentActivity.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📋</div>
                <h3>Nothing here yet</h3>
                <p>Bookings and trip updates will show up here as they happen.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recentActivity.map(item => (
                  <div key={item.id} className="driver-activity-item">
                    <span className="driver-activity-icon">{item.icon}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong style={{ fontSize: 13.5, display: 'block' }}>{item.title}</strong>
                      <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{item.sub}</p>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{timeAgo(item.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right rail ──────────────────────────────────────────── */}
        <div className="dash-rail">

          {/* Profile summary */}
          <div className="card card-pad">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              {profile?.profile_picture ? (
                <img src={profile.profile_picture} alt="" className="driver-rail-avatar-img" />
              ) : (
                <span className="driver-rail-avatar">{initials(profile?.full_name)}</span>
              )}
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 15, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {profile?.full_name || 'Driver'}
                </strong>
                <span className={`badge ${vMeta.badge}`} style={{ marginTop: 4 }}>{vMeta.label}</span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              <InfoRow label="Email" value={profile?.email} />
              <InfoRow label="Phone" value={profile?.phone} />
              {profile?.created_at && <InfoRow label="Member since" value={formatDateShort(profile.created_at)} />}
            </div>

            {isDriverVerified && (
              <>
                <div className="divider" style={{ margin: '14px 0' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                  <InfoRow label="Vehicle" value={`${driverProfile?.vehicle_make || ''} ${driverProfile?.vehicle_model || ''}`.trim()} />
                  <InfoRow label="Plate" value={driverProfile?.vehicle_plate} />
                </div>
              </>
            )}

            <div className="divider" style={{ margin: '14px 0' }} />
            <div className="grid-3" style={{ gap: 8 }}>
              <TrustStat label="Trust level" value={`L${driverProfile?.trust_level || 1}`} />
              <TrustStat label="Rating" value={rating.avg ? `⭐ ${rating.avg}` : '—'} />
              <TrustStat label="Trips" value={driverProfile?.trips_completed || 0} />
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
              {rating.count > 0
                ? `Based on ${rating.count} rating${rating.count === 1 ? '' : 's'}`
                : 'New driver — no ratings yet'}
            </p>

            <Link to="/driver/profile" className="btn btn-sm btn-outline btn-full" style={{ marginTop: 8 }}>View full profile</Link>
          </div>

          {/* Recent reviews */}
          <div className="card card-pad">
            <h3 style={{ fontSize: 14, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
              Recent reviews
            </h3>
            <ReviewsList reviews={reviews} loading={reviewsLoading} error={reviewsError} compact />
          </div>

          {/* Notifications */}
          <div className="card card-pad">
            <div className="flex-between" style={{ marginBottom: 14 }}>
              <h3 style={{ fontSize: 14, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Notifications {unreadNotifCount > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }}>{unreadNotifCount} new</span>}
              </h3>
              {unreadNotifCount > 0 && (
                <button className="btn btn-sm btn-ghost" onClick={markAllNotificationsRead}>Mark all read</button>
              )}
            </div>

            {notifLoading ? (
              <div><BookingRowSkeleton /><BookingRowSkeleton /></div>
            ) : notifications.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 12px' }}>
                <div className="empty-icon" style={{ fontSize: 32 }}>🔔</div>
                <p>No notifications yet.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {notifications.map(n => (
                  <button
                    key={n.id}
                    onClick={() => markNotificationRead(n)}
                    className="driver-notif-item"
                    style={{ background: n.is_read ? 'transparent' : 'var(--primary-xlight)' }}
                  >
                    <strong style={{ fontSize: 13, display: 'block', color: 'var(--text)' }}>{n.title}</strong>
                    {n.body && <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{n.body}</p>}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>{timeAgo(n.created_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="card card-pad">
            <h3 style={{ fontSize: 14, marginBottom: 14, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Quick actions
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {QUICK_ACTIONS.map(a => {
                const disabled = a.requiresVerified && !isDriverVerified;
                const isPrimary = a.requiresVerified && !disabled;
                const inner = (
                  <>
                    <span className="quick-action-icon">{a.icon}</span>
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ fontSize: 13.5, display: 'block' }}>{a.title}</strong>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {disabled ? 'Requires verification' : a.sub}
                      </p>
                    </div>
                  </>
                );
                const className = `quick-action${isPrimary ? ' quick-action-primary' : ''}${disabled ? ' disabled' : ''}`;
                return disabled ? (
                  <div key={a.to} className={className}>{inner}</div>
                ) : (
                  <Link key={a.to} to={a.to} className={className} style={{ textDecoration: 'none', color: 'inherit' }}>
                    {inner}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {cancelTarget && (
        <CancelTripModal
          trip={cancelTarget}
          passengerCount={getTripBookingStats(cancelTarget.id).passengerCount}
          seatsBooked={getTripBookingStats(cancelTarget.id).seatsBooked}
          busy={busyTripId === cancelTarget.id}
          error={cancelModalError}
          onConfirm={confirmCancelTrip}
          onClose={() => { if (busyTripId !== cancelTarget.id) setCancelTarget(null); }}
        />
      )}

      {passengerCompletionsTrip && (
        <TripPassengerCompletionsModal
          tripId={passengerCompletionsTrip.id}
          tripLabel={`${passengerCompletionsTrip.origin} → ${passengerCompletionsTrip.destination}`}
          onClose={() => setPassengerCompletionsTrip(null)}
        />
      )}
    </DashboardLayout>
  );
}

// ── small presentational helpers ────────────────────────────────────────
const TRUST_COLORS = {
  1: { color: '#64748B', bg: '#F1F5F9' },
  2: { color: '#0E7490', bg: 'var(--primary-xlight)' },
  3: { color: '#16A34A', bg: 'var(--green-light)' },
  4: { color: '#F59E0B', bg: 'var(--amber-light)' },
  5: { color: '#F97316', bg: 'var(--accent-light)' },
};

function TrustBadge({ level }) {
  const l = level || 1;
  const { color, bg } = TRUST_COLORS[l] || TRUST_COLORS[1];
  return (
    <span className="badge" style={{ background: bg, color, border: `1px solid ${color}33` }}>
      Trust Level {l}
    </span>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
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

function BookingRowSkeleton() {
  return (
    <div className="skeleton-row">
      <div style={{ flex: 1 }}>
        <div className="skeleton skeleton-text" style={{ width: '35%', marginBottom: 8 }} />
        <div className="skeleton skeleton-text" style={{ width: '60%' }} />
      </div>
      <div className="skeleton skeleton-text" style={{ width: 60 }} />
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex-between" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 12.5, fontWeight: 600, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value || '—'}
      </span>
    </div>
  );
}

function TrustStat({ label, value }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}
