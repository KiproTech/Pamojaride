import { useEffect, useState } from 'react';
import { fetchTripPassengerCompletions, DECLINE_REASONS } from '../../lib/tripCompletion';

const REASON_LABEL = Object.fromEntries(DECLINE_REASONS.map(r => [r.value, r.label]));

const RESPONSE_META = {
  accepted: { label: 'Confirmed', badge: 'badge-green' },
  declined: { label: 'Declined', badge: 'badge-danger' },
  pending: { label: 'Waiting for confirmation', badge: 'badge-amber' },
  auto_completed: { label: 'Auto-completed (no response)', badge: 'badge-gray' },
  admin_override: { label: 'Completed by admin', badge: 'badge-teal' },
};

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Per-passenger trip completion breakdown — "who confirmed, who's still
 * pending, who declined and why" — for a single trip. Used by both the
 * driver's own trip ("View passenger confirmations") and admin Trip
 * Oversight ("View Details"). Backed by get_trip_passenger_completions(),
 * which itself enforces that only the trip's driver or an admin sees every
 * row (see database/trip_completion_individual_confirmations.sql).
 */
export default function TripPassengerCompletionsModal({ tripId, tripLabel, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    fetchTripPassengerCompletions(tripId)
      .then(data => { if (active) setRows(data); })
      .catch(err => { if (active) setError(err.message || 'Could not load passenger confirmations.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tripId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Passenger completion status</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {tripLabel && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>{tripLabel}</p>}

        {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner" /></div>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No passenger confirmations recorded for this trip.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
            {rows.map(r => {
              const meta = RESPONSE_META[r.response] || RESPONSE_META.pending;
              return (
                <div key={r.confirmation_id} className="card" style={{ padding: 12, border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {r.passenger_picture ? (
                        <img src={r.passenger_picture} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
                      ) : (
                        <span className="topbar-avatar" style={{ width: 36, height: 36, fontSize: 13 }}>{initials(r.passenger_name)}</span>
                      )}
                      <div>
                        <strong style={{ fontSize: 13.5 }}>{r.passenger_name || 'Passenger'}</strong>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          Ref {r.booking_reference} · {r.seats_booked} seat{r.seats_booked === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                    <span className={`badge ${meta.badge}`}>{meta.label}</span>
                  </div>

                  {r.response === 'declined' && (
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      <strong>Reason:</strong> {REASON_LABEL[r.decline_reason] || r.decline_reason || '—'}
                      {r.decline_comment && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>“{r.decline_comment}”</div>}
                    </div>
                  )}

                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    Requested {formatDateTime(r.requested_at)}
                    {r.responded_at && <> · Responded {formatDateTime(r.responded_at)}</>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
