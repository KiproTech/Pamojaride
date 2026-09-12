import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import TripPassengerCompletionsModal from '../../components/shared/TripPassengerCompletionsModal';
import PassengerManifestModal from '../../components/shared/PassengerManifestModal';
import DriverDetailsModal from '../../components/admin/DriverDetailsModal';
import TripDetailsModal from '../../components/admin/TripDetailsModal';
import PassengerProfileModal from '../../components/admin/PassengerProfileModal';
import BookingDetailsModal from '../../components/admin/BookingDetailsModal';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'completion_pending', label: 'Awaiting confirmation' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
  { value: 'pending_completion', label: 'Pending passenger completion' },
  { value: 'declined_completion', label: 'Declined passenger completion' },
  { value: 'has_reports', label: 'Has reports' },
  { value: 'needs_attention', label: 'Needs attention' },
];

const STATUS_BADGE = {
  scheduled: 'badge-teal',
  ongoing: 'badge-amber',
  completion_pending: 'badge-amber',
  completed: 'badge-green',
  cancelled: 'badge-danger',
  expired: 'badge-gray',
};

const PAGE_SIZE = 20;

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function DriverAvatar({ picture, name }) {
  return picture ? (
    <img src={picture} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  ) : (
    <span className="topbar-avatar" style={{ width: 30, height: 30, fontSize: 11, flexShrink: 0 }}>{initials(name)}</span>
  );
}

export default function TripOversight() {
  const [trips, setTrips] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [cancelTarget, setCancelTarget] = useState(null); // trip being cancelled
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [passengerCompletionsTrip, setPassengerCompletionsTrip] = useState(null); // trip whose per-passenger modal is open
  const [manifestTripId, setManifestTripId] = useState(null); // trip whose passenger manifest is open
  const [completeTarget, setCompleteTarget] = useState(null); // trip being admin-completed
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState('');

  // ── Trip -> Passenger -> Booking navigation stack ───────────────────────
  // A single stack (rather than separate pieces of state per modal type) so
  // "Back" always returns to exactly where the admin came from, preserving
  // context per the brief: Trip Details -> Passenger Profile -> Booking
  // Details -> back to Trip Details, and the reverse, without re-fetching
  // from scratch or losing place. "View Driver Profile" opens on top as a
  // simple overlay since a driver profile has no further drill-down here.
  const [modalStack, setModalStack] = useState([]); // [{ type: 'trip'|'passenger'|'booking', id }]
  const [driverModalId, setDriverModalId] = useState(null);

  function openTrip(id) { setModalStack([{ type: 'trip', id }]); }
  function pushModal(type, id) { setModalStack(s => [...s, { type, id }]); }
  function popModal() { setModalStack(s => s.slice(0, -1)); }
  function closeModals() { setModalStack([]); }
  const activeModal = modalStack[modalStack.length - 1];

  useEffect(() => { setPage(0); }, [statusFilter, search]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const { data, error: rpcError } = await supabase.rpc('get_admin_trip_oversight', {
        p_status: statusFilter === 'all' ? null : statusFilter,
        p_search: search.trim() || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (cancelled) return;
      if (rpcError) setError(rpcError.message);
      else {
        setTrips(data || []);
        setTotal(data && data.length > 0 ? Number(data[0].total_count) : 0);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [statusFilter, search, page, refreshTick]);

  // ── Cancellation history (booking-level) ────────────────────────────────
  const [showCancelHistory, setShowCancelHistory] = useState(false);
  const [cancelHistory, setCancelHistory] = useState([]);
  const [cancelHistoryLoading, setCancelHistoryLoading] = useState(false);
  const [cancelHistoryError, setCancelHistoryError] = useState('');
  const [cancelHistoryLoaded, setCancelHistoryLoaded] = useState(false);

  async function loadCancelHistory() {
    setCancelHistoryLoading(true);
    setCancelHistoryError('');
    const { data, error: rpcError } = await supabase.rpc('get_cancellation_history');
    setCancelHistoryLoading(false);
    setCancelHistoryLoaded(true);
    if (rpcError) { setCancelHistoryError(rpcError.message); return; }
    setCancelHistory((data || []).filter(row => row.source === 'booking'));
  }

  function toggleCancelHistory() {
    const next = !showCancelHistory;
    setShowCancelHistory(next);
    if (next && !cancelHistoryLoaded) loadCancelHistory();
  }

  async function confirmComplete() {
    if (!completeTarget) return;
    setCompleteBusy(true);
    setCompleteError('');
    const { error: rpcError } = await supabase.rpc('admin_complete_trip', { p_trip_id: completeTarget.trip_id });
    setCompleteBusy(false);
    if (rpcError) { setCompleteError(rpcError.message); return; }
    setCompleteTarget(null);
    setRefreshTick(t => t + 1);
  }

  async function confirmCancel() {
    if (!cancelTarget || !reason.trim()) return;
    setBusy(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('cancel_trip', {
      p_trip_id: cancelTarget.trip_id,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (rpcError) { setError(rpcError.message); return; }
    setCancelTarget(null);
    setReason('');
    setRefreshTick(t => t + 1); // re-run the load effect
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <DashboardLayout title="Trip Oversight">
      <div className="page-header">
        <h1>Trip Oversight</h1>
        <p>Monitor every trip posted on the platform — {total} total. Open any trip for its complete driver, passenger, and completion record.</p>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="flex-between" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {STATUS_TABS.map(t => (
            <button
              key={t.value}
              className={`btn btn-sm ${statusFilter === t.value ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setStatusFilter(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          className="form-input"
          placeholder="Search trip ID, route, driver, passenger, phone, or booking ref…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24 }}>
            <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
          </div>
        ) : trips.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗺️</div>
            <h3>No trips found</h3>
            <p>Try a different filter or search term.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['Route', 'Driver', 'Departure', 'Seats', 'Passengers', 'Price', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trips.map(t => (
                <tr key={t.trip_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '14px 20px', fontSize: 13.5, fontWeight: 600 }}>
                    {t.origin} → {t.destination}
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 400 }}>
                      {[t.vehicle_make, t.vehicle_model, t.vehicle_plate].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <DriverAvatar picture={t.driver_profile_picture} name={t.driver_name} />
                      <div>
                        {t.driver_name || '—'}<br />{t.driver_phone}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{formatDateTime(t.departure_time)}</td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{t.available_seats}/{t.total_seats}</td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>
                    {t.passenger_count} booked
                    {(t.accepted_count + t.declined_count + t.pending_count) > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {t.accepted_count} confirmed · {t.declined_count} declined · {t.pending_count} pending
                      </div>
                    )}
                    {t.reports_count > 0 && <span className="badge badge-danger" style={{ marginTop: 4, display: 'inline-block' }}>{t.reports_count} report{t.reports_count === 1 ? '' : 's'}</span>}
                  </td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>KSh {t.price_per_seat}</td>
                  <td style={{ padding: '14px 20px' }}>
                    <span className={`badge ${STATUS_BADGE[t.status] || 'badge-teal'}`}>{t.status.replace(/_/g, ' ')}</span>
                    {t.needs_attention && <div style={{ marginTop: 4 }}><span className="badge badge-danger">Needs attention</span></div>}
                    {t.status === 'cancelled' && t.cancellation_reason && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, maxWidth: 220 }}>
                        {t.cancellation_reason}
                        {t.cancelled_at && <div>{formatDateTime(t.cancelled_at)}</div>}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-primary" onClick={() => openTrip(t.trip_id)}>
                        View Trip Details
                      </button>
                      {(t.status === 'scheduled' || t.status === 'ongoing') && (
                        <button className="btn btn-sm btn-danger" onClick={() => { setCancelTarget(t); setReason(''); }}>
                          Cancel
                        </button>
                      )}
                      {(t.status === 'ongoing' || t.status === 'completion_pending') && (
                        <button className="btn btn-sm btn-outline" onClick={() => { setCompleteTarget(t); setCompleteError(''); }}>
                          Mark as Complete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {!loading && totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
          <button className="btn btn-sm btn-outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Previous</button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', alignSelf: 'center' }}>Page {page + 1} of {totalPages}</span>
          <button className="btn btn-sm btn-outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      {/* Booking-level cancellation history — see get_cancellation_history()
          in database/trip_complaints_admin_alerts_cancellation_history.sql.
          Collapsed by default; only fetched the first time it's opened. */}
      <div style={{ marginTop: 32 }}>
        <button className="btn btn-sm btn-outline" onClick={toggleCancelHistory}>
          {showCancelHistory ? '▾' : '▸'} Booking cancellations (driver/admin-initiated)
        </button>

        {showCancelHistory && (
          <div className="card" style={{ overflow: 'hidden', marginTop: 12 }}>
            {cancelHistoryError && <div className="alert alert-danger" style={{ margin: 16 }}>{cancelHistoryError}</div>}
            {cancelHistoryLoading ? (
              <div style={{ padding: 24 }}>
                <div className="skeleton-row" /><div className="skeleton-row" />
              </div>
            ) : cancelHistory.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🧾</div>
                <h3>No booking cancellations</h3>
                <p>No passenger booking has ever been cancelled by a driver or admin.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                    {['Route', 'Passenger', 'Cancelled by', 'Reason', 'When'].map(h => (
                      <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cancelHistory.map(row => (
                    <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '14px 20px', fontSize: 13, fontWeight: 600 }}>{row.origin} → {row.destination}</td>
                      <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{row.passenger_name || '—'}</td>
                      <td style={{ padding: '14px 20px', fontSize: 12.5 }}>
                        {row.cancelled_by_name || '—'}
                        {row.driver_name && row.cancelled_by_name === row.driver_name && <span className="badge badge-gray" style={{ marginLeft: 6 }}>Driver</span>}
                      </td>
                      <td style={{ padding: '14px 20px', fontSize: 12.5, maxWidth: 260 }}>
                        {row.cancellation_reason || '—'}
                        {row.cancellation_reason_category === 'other' && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>(Other — custom reason)</div>}
                      </td>
                      <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{formatDateTime(row.cancelled_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {cancelTarget && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>Cancel {cancelTarget.origin} → {cancelTarget.destination}?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Every confirmed booking on this trip will be cancelled too, and each passenger
              (and the driver) will be notified automatically. This can't be undone.
            </p>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label className="form-label">Reason (shown to the driver and passengers)</label>
              <textarea
                className="form-input"
                rows={3}
                value={reason}
                onChange={e => setReason(e.target.value)}
                style={{ resize: 'vertical', fontFamily: "'DM Sans', sans-serif" }}
                placeholder="e.g. Trip cancelled following a safety report under investigation"
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCancelTarget(null)}>Back</button>
              <button className="btn btn-danger btn-sm" disabled={busy || !reason.trim()} onClick={confirmCancel}>
                {busy ? <span className="spinner" /> : 'Confirm cancellation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {completeTarget && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>Mark {completeTarget.origin} → {completeTarget.destination} as complete?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              This action will immediately complete the trip and affected bookings. Passengers will be
              notified. Unlike driver-requested completion, passengers will not be asked to accept or
              reject this admin action, and their existing individual confirmations are preserved.
            </p>
            {completeError && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{completeError}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={completeBusy} onClick={() => setCompleteTarget(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" disabled={completeBusy} onClick={confirmComplete}>
                {completeBusy ? <span className="spinner" /> : 'Confirm Completion'}
              </button>
            </div>
          </div>
        </div>
      )}

      {manifestTripId && (
        <PassengerManifestModal tripId={manifestTripId} onClose={() => setManifestTripId(null)} />
      )}

      {passengerCompletionsTrip && (
        <TripPassengerCompletionsModal
          tripId={passengerCompletionsTrip.id}
          tripLabel={`${passengerCompletionsTrip.origin} → ${passengerCompletionsTrip.destination}`}
          onClose={() => setPassengerCompletionsTrip(null)}
        />
      )}

      {/* ── Trip -> Passenger -> Booking navigation stack ────────────────── */}
      {activeModal?.type === 'trip' && (
        <TripDetailsModal
          key={`trip-${activeModal.id}`}
          tripId={activeModal.id}
          onClose={closeModals}
          onBack={modalStack.length > 1 ? popModal : undefined}
          onViewDriver={id => setDriverModalId(id)}
          onViewPassenger={id => pushModal('passenger', id)}
          onViewBooking={id => pushModal('booking', id)}
          onChanged={() => setRefreshTick(t => t + 1)}
        />
      )}
      {activeModal?.type === 'passenger' && (
        <PassengerProfileModal
          key={`passenger-${activeModal.id}`}
          passengerId={activeModal.id}
          onClose={closeModals}
          onBack={popModal}
          onViewBooking={id => pushModal('booking', id)}
        />
      )}
      {activeModal?.type === 'booking' && (
        <BookingDetailsModal
          key={`booking-${activeModal.id}`}
          bookingId={activeModal.id}
          onClose={closeModals}
          onBack={popModal}
          onViewTrip={id => pushModal('trip', id)}
          onViewPassenger={id => pushModal('passenger', id)}
        />
      )}
      {driverModalId && (
        <DriverDetailsModal driverId={driverModalId} onClose={() => setDriverModalId(null)} />
      )}
    </DashboardLayout>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
};
const modalStyle = {
  background: 'white', borderRadius: 16, padding: '28px 30px', maxWidth: 420, width: '100%',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', fontFamily: "'DM Sans', sans-serif",
};
