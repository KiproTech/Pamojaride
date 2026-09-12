import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

const BOOKING_STATUS_BADGE = {
  confirmed: 'badge-teal',
  completed: 'badge-green',
  no_show: 'badge-danger',
  cancelled: 'badge-gray',
  pending: 'badge-amber',
};

/**
 * Admin-only passenger manifest for a single trip — "who is booked on this
 * trip, and how do I tell them apart at a glance" — deliberately separate
 * from TripPassengerCompletionsModal (which is about completion
 * accept/decline status, not identity). Backed entirely by the one
 * get_trip_passenger_manifest() RPC (database/admin_passenger_manifest.sql),
 * which already enforces admin-only access and returns everything in a
 * single joined query, so this component does no per-passenger fetching.
 *
 * This project has no real boarding/check-in system — only booking status
 * — so the heading and every row deliberately say "booked", never
 * "boarded", to avoid claiming something the system doesn't actually
 * track.
 */
export default function PassengerManifestModal({ tripId, onClose }) {
  const [rows, setRows] = useState([]);
  const [trip, setTrip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    supabase.rpc('get_trip_passenger_manifest', { p_trip_id: tripId })
      .then(({ data, error: rpcError }) => {
        if (!active) return;
        if (rpcError) { setError(rpcError.message); return; }
        const list = data || [];
        setRows(list);
        if (list.length > 0) {
          setTrip({
            origin: list[0].origin, destination: list[0].destination,
            driver_name: list[0].driver_name, trip_status: list[0].trip_status,
          });
        }
      })
      .catch(err => { if (active) setError(err.message || 'Could not load the passenger manifest.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tripId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Passengers Booked for This Trip</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {trip && (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
            <div><strong style={{ color: 'var(--text)' }}>Trip:</strong> {trip.origin} → {trip.destination}</div>
            <div><strong style={{ color: 'var(--text)' }}>Driver:</strong> {trip.driver_name || '—'}</div>
            <div><strong style={{ color: 'var(--text)' }}>Status:</strong> {trip.trip_status}</div>
            <div><strong style={{ color: 'var(--text)' }}>Passengers:</strong> {rows.length}</div>
          </div>
        )}

        {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner" /></div>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No confirmed bookings for this trip.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
            {rows.map((r, i) => (
              <div key={r.booking_id} className="card" style={{ padding: 12, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  {r.passenger_profile_picture ? (
                    <img src={r.passenger_profile_picture} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  ) : (
                    <span className="topbar-avatar" style={{ width: 40, height: 40, fontSize: 14, flexShrink: 0 }}>{initials(r.passenger_full_name)}</span>
                  )}
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div className="flex-between" style={{ gap: 8 }}>
                      <strong style={{ fontSize: 13.5 }}>{i + 1}. {r.passenger_full_name || 'Passenger'}</strong>
                      <span className={`badge ${BOOKING_STATUS_BADGE[r.booking_status] || 'badge-gray'}`}>{r.booking_status}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                      Passenger ID: {r.passenger_reference}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      Booking Reference: {r.booking_reference}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {r.seats_booked} seat{r.seats_booked === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
