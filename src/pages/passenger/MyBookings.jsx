import { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import BookingCard from '../../components/shared/BookingCard';
import RatingModal from '../../components/passenger/RatingModal';
import ReportModal from '../../components/shared/ReportModal';
import CompletionStatus from '../../components/shared/CompletionStatus';
import DriverDetailsCard from '../../components/passenger/DriverDetailsCard';
import { fetchTripCompletionStatuses, acceptTripCompletion, declineTripCompletion } from '../../lib/tripCompletion';
import { fetchBookedTripDriverDetailsBatch } from '../../lib/driverDetails';

const TABS = [
  { key: 'upcoming', label: 'Upcoming', statuses: ['pending', 'confirmed'] },
  { key: 'completed', label: 'Completed', statuses: ['completed'] },
  { key: 'cancelled', label: 'Cancelled / No-show', statuses: ['cancelled', 'no_show'] },
];

export default function MyBookings() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [bookings, setBookings] = useState([]);
  const [search, setSearch] = useState('');
  const [myRatings, setMyRatings] = useState({}); // booking_id -> { rating, comment }
  const [loading, setLoading] = useState(true);
  // A "Trip cancelled" notification links here with state: { tab: 'cancelled' }
  // (see components/shared/NotificationBell.jsx) so the passenger lands
  // directly on the booking that was cancelled instead of "Upcoming".
  const [tab, setTab] = useState(
    TABS.some(t => t.key === location.state?.tab) ? location.state.tab : 'upcoming'
  );
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [rateTarget, setRateTarget] = useState(null);
  const [reportTarget, setReportTarget] = useState(null);
  const [completionStatuses, setCompletionStatuses] = useState({}); // tripId -> get_trip_completion_status row
  const [completionLoading, setCompletionLoading] = useState(false);
  const [respondingTripId, setRespondingTripId] = useState(null);
  const [driverDetails, setDriverDetails] = useState({}); // tripId -> get_booked_trip_driver_details row
  const [driverDetailsLoading, setDriverDetailsLoading] = useState(false);
  const pollRef = useRef(null);

  async function load() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('bookings')
      .select('*, trips(id, origin, destination, departure_time, driver_id, status)')
      .eq('passenger_id', user.id)
      .order('created_at', { ascending: false });
    if (!err) setBookings(data || []);

    const { data: myRatingsData } = await supabase
      .from('ratings').select('booking_id, rating, comment').eq('rater_id', user.id).eq('rating_type', 'passenger_to_driver');
    setMyRatings(Object.fromEntries((myRatingsData || []).map(r => [r.booking_id, r])));

    setLoading(false);
  }

  useEffect(() => { if (user) load(); }, [user]);

  // While any of this passenger's bookings sit on a trip that's in
  // `completion_pending`, poll the per-passenger accept/decline breakdown
  // every 15s so the "Accept & Mark Completed / Decline" card stays live.
  // The completion window itself is enforced server-side regardless of
  // whether this passenger ever opens the app — see
  // database/trip_completion_individual_confirmations.sql. Also fetches
  // (once, no polling) the status for a trip behind a declined ('no_show')
  // booking, purely so this passenger's own decline reason can still be
  // shown on that booking's card.
  useEffect(() => {
    const pendingTripIds = [...new Set(
      bookings.filter(b => b.trips?.status === 'completion_pending').map(b => b.trips.id)
    )];
    const declinedTripIds = [...new Set(
      bookings.filter(b => b.status === 'no_show' && b.trips?.id).map(b => b.trips.id)
    )].filter(id => !pendingTripIds.includes(id) && !completionStatuses[id]);

    if (declinedTripIds.length > 0) {
      fetchTripCompletionStatuses(declinedTripIds).then(statuses => {
        setCompletionStatuses(prev => ({ ...prev, ...statuses }));
      });
    }

    if (pendingTripIds.length === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    let cancelled = false;
    async function poll() {
      setCompletionLoading(true);
      const statuses = await fetchTripCompletionStatuses(pendingTripIds);
      if (!cancelled) {
        setCompletionStatuses(prev => ({ ...prev, ...statuses }));
        setCompletionLoading(false);
        if (Object.values(statuses).some(s => s && s.status !== 'completion_pending')) {
          load();
        }
      }
    }

    poll();
    pollRef.current = setInterval(poll, 15000);
    return () => { cancelled = true; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings.map(b => `${b.trips?.id}:${b.trips?.status}:${b.status}`).join(',')]);

  // Fetch full driver details (name, photo, phone, vehicle, verification
  // status) for every trip this passenger has a confirmed or completed
  // booking on. Authorization is enforced by the RPC itself — this only
  // ever asks for trips that already appear in this passenger's own
  // bookings list, so there's no way to request another passenger's
  // driver details from here. See database/passenger_driver_details.sql.
  useEffect(() => {
    const tripIds = [...new Set(
      bookings.filter(b => ['confirmed', 'completed'].includes(b.status) && b.trips?.id).map(b => b.trips.id)
    )];
    if (tripIds.length === 0) { setDriverDetails({}); return; }

    let cancelled = false;
    setDriverDetailsLoading(true);
    fetchBookedTripDriverDetailsBatch(tripIds).then(details => {
      if (!cancelled) { setDriverDetails(details); setDriverDetailsLoading(false); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings.map(b => `${b.id}:${b.status}:${b.trips?.id}`).join(',')]);

  async function handleAcceptCompletion(tripId) {
    setRespondingTripId(tripId); setError('');
    try {
      await acceptTripCompletion(tripId);
      const status = await fetchTripCompletionStatuses([tripId]);
      setCompletionStatuses(prev => ({ ...prev, ...status }));
      load();
    } catch (err) {
      setError(err.message || 'Could not confirm trip completion.');
    } finally {
      setRespondingTripId(null);
    }
  }

  async function handleDeclineCompletion(tripId, reason, comment) {
    setRespondingTripId(tripId);
    try {
      await declineTripCompletion(tripId, reason, comment);
      const status = await fetchTripCompletionStatuses([tripId]);
      setCompletionStatuses(prev => ({ ...prev, ...status }));
      load();
    } finally {
      setRespondingTripId(null);
    }
  }

  // A trip "has started" the moment its departure_time is reached — this is
  // purely a UI convenience to hide/disable the button early; the real rule
  // is enforced server-side in cancel_booking() so it can't be bypassed by
  // calling the RPC directly (see trip_lifecycle_hardening_and_reminders.sql).
  function tripHasStarted(booking) {
    if (!booking.trips?.departure_time) return false;
    return new Date(booking.trips.departure_time).getTime() <= Date.now();
  }

  async function handleCancel(bookingId) {
    if (!confirm('Cancel this booking?')) return;
    setBusyId(bookingId); setError('');
    const { error: err } = await supabase.rpc('cancel_booking', { p_booking_id: bookingId, p_reason: 'Cancelled by passenger' });
    setBusyId(null);
    if (err) {
      // Backend's own guard (belt-and-braces even though the button is
      // already hidden once departure_time has passed — e.g. it could have
      // ticked over between page load and click).
      setError(err.message.includes('already started')
        ? 'This trip has already started, so this booking can no longer be cancelled.'
        : err.message);
    } else {
      load();
    }
  }

  const activeTab = TABS.find(t => t.key === tab);
  const q = search.trim().toLowerCase();
  const inTab = bookings.filter(b => activeTab.statuses.includes(b.status));
  const filtered = inTab.filter(b => {
    if (!q) return true;
    const haystack = [b.booking_reference, b.trips?.origin, b.trips?.destination]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });

  return (
    <DashboardLayout title="My Bookings">
      <div className="page-header">
        <h1>My Bookings</h1>
        <p>Track your upcoming, completed, and cancelled trips.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`btn btn-sm ${tab === t.key ? 'btn-primary' : 'btn-outline'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 20, maxWidth: 360 }}>
        <input
          type="text"
          className="form-input"
          placeholder="Search by reference, origin or destination"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎫</div>
          {inTab.length === 0 ? (
            <>
              <h3>No {activeTab.label.toLowerCase()} bookings</h3>
              <p>{tab === 'upcoming' ? 'Search for a trip to get started.' : 'Nothing here yet.'}</p>
              {tab === 'upcoming' && (
                <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate('/passenger/search')}>
                  Find a trip
                </button>
              )}
            </>
          ) : (
            <>
              <h3>No matches</h3>
              <p>No bookings match "{search}" in this tab.</p>
              <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={() => setSearch('')}>
                Clear search
              </button>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filtered.map(b => {
            const myRating = myRatings[b.id];
            const alreadyRated = !!myRating;
            const hasTrip = !!b.trips?.id;
            const showDriverCard = ['confirmed', 'completed'].includes(b.status) && hasTrip;
            const showCompletion = b.status === 'confirmed' && b.trips?.status === 'completion_pending';
            const showDeclineNote = b.status === 'no_show' && hasTrip && completionStatuses[b.trips.id]?.caller_response === 'declined';
            const extraContent = (showDriverCard || showCompletion || showDeclineNote) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {showDriverCard && (
                  <DriverDetailsCard
                    driver={driverDetails[b.trips.id] || null}
                    loading={driverDetailsLoading && !driverDetails[b.trips.id]}
                  />
                )}
                {showCompletion && (
                  <CompletionStatus
                    status={completionStatuses[b.trips.id]}
                    loading={completionLoading}
                    onAccept={() => handleAcceptCompletion(b.trips.id)}
                    onDecline={(reason, comment) => handleDeclineCompletion(b.trips.id, reason, comment)}
                    responding={respondingTripId === b.trips.id}
                  />
                )}
                {showDeclineNote && (
                  <div className="alert alert-danger" style={{ padding: '8px 12px', fontSize: 12.5 }}>
                    ✕ You declined this trip's completion confirmation.
                  </div>
                )}
              </div>
            ) : false;
            // Defensive fallback: if the embedded trip failed to load for
            // any reason, show a clear placeholder instead of
            // "undefined → undefined" / "Invalid Date".
            const routeLabel = hasTrip ? `${b.trips.origin} → ${b.trips.destination}` : 'Trip details unavailable';
            const departureLabel = hasTrip && b.trips.departure_time
              ? new Date(b.trips.departure_time).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
              : '—';
            return (
              <BookingCard
                key={b.id}
                booking={b}
                personName={routeLabel}
                personLabel={departureLabel}
                extra={extraContent}
                onClick={() => navigate(`/passenger/bookings/${b.id}`)}
                actions={
                  <>
                    {['pending', 'confirmed'].includes(b.status) && (
                      tripHasStarted(b)
                        ? (
                          <span className="badge badge-gray" title="This trip has already started and can no longer be cancelled from here.">
                            Trip started — can't cancel
                          </span>
                        )
                        : (
                          <button className="btn btn-sm btn-danger" disabled={busyId === b.id} onClick={() => handleCancel(b.id)}>
                            {busyId === b.id ? <span className="spinner" /> : 'Cancel'}
                          </button>
                        )
                    )}
                    {b.status === 'completed' && !alreadyRated && hasTrip && (
                      <button className="btn btn-sm btn-primary" onClick={() => setRateTarget(b)}>⭐ Rate driver</button>
                    )}
                    {b.status === 'completed' && alreadyRated && (
                      <span className="badge badge-gray" title={myRating.comment || undefined}>
                        Rated ✓ {'★'.repeat(myRating.rating)}{'☆'.repeat(5 - myRating.rating)}
                      </span>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => setReportTarget(b)}>🚩 Report</button>
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {rateTarget && (
        <RatingModal
          booking={rateTarget}
          driverId={rateTarget.trips.driver_id}
          onClose={() => setRateTarget(null)}
          onSuccess={() => { setRateTarget(null); load(); }}
        />
      )}

      {reportTarget && (
        <ReportModal
          reporterId={user.id}
          tripId={reportTarget.trips?.id}
          bookingId={reportTarget.id}
          reportedUserId={reportTarget.trips?.driver_id}
          reportedRole="driver"
          onClose={() => setReportTarget(null)}
          onSuccess={() => { setReportTarget(null); alert('Report submitted. Our team will review it shortly.'); }}
        />
      )}
    </DashboardLayout>
  );
}
