import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'completion_pending', label: 'Awaiting confirmation' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
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

  // ── Cancellation history (booking-level) ────────────────────────────────
  // Whole-trip cancellations are already shown inline in the table below
  // (t.cancellation_reason). This adds the one thing that was missing:
  // visibility into a driver cancelling an INDIVIDUAL passenger's booking,
  // via the admin-only get_cancellation_history() RPC. Collapsed by
  // default and self-contained on this same page, so nothing about the
  // existing Trip Oversight table or admin navigation changes.
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

  useEffect(() => { setPage(0); }, [statusFilter, search]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');

      let query = supabase
        .from('trips')
        .select('id, origin, destination, departure_time, status, price_per_seat, total_seats, available_seats, vehicle_plate, driver_id, cancellation_reason, cancelled_at, profiles:driver_id (full_name, phone)', { count: 'exact' })
        .order('departure_time', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      if (statusFilter !== 'all') query = query.eq('status', statusFilter);
      if (search.trim()) {
        const q = search.trim();
        query = query.or(`origin.ilike.%${q}%,destination.ilike.%${q}%,vehicle_plate.ilike.%${q}%`);
      }

      const { data, error: fetchError, count } = await query;
      if (cancelled) return;
      if (fetchError) setError(fetchError.message);
      else { setTrips(data || []); setTotal(count || 0); }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [statusFilter, search, page, refreshTick]);

  async function confirmCancel() {
    if (!cancelTarget || !reason.trim()) return;
    setBusy(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('cancel_trip', {
      p_trip_id: cancelTarget.id,
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
        <p>Monitor every trip posted on the platform — {total} total. You can force-cancel a scheduled or ongoing trip if needed.</p>
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
          placeholder="Search origin, destination, or plate…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
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
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['Route', 'Driver', 'Departure', 'Seats', 'Price', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trips.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '14px 20px', fontSize: 13.5, fontWeight: 600 }}>
                    {t.origin} → {t.destination}
                    {t.vehicle_plate && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 400 }}>{t.vehicle_plate}</div>}
                  </td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {t.profiles?.full_name || '—'}<br />{t.profiles?.phone}
                  </td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{formatDateTime(t.departure_time)}</td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{t.available_seats}/{t.total_seats}</td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>KSh {t.price_per_seat}</td>
                  <td style={{ padding: '14px 20px' }}>
                    <span className={`badge ${STATUS_BADGE[t.status] || 'badge-teal'}`}>{t.status}</span>
                    {t.status === 'cancelled' && t.cancellation_reason && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, maxWidth: 220 }}>
                        {t.cancellation_reason}
                        {t.cancelled_at && <div>{formatDateTime(t.cancelled_at)}</div>}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                    {(t.status === 'scheduled' || t.status === 'ongoing') && (
                      <button className="btn btn-sm btn-danger" onClick={() => { setCancelTarget(t); setReason(''); }}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
