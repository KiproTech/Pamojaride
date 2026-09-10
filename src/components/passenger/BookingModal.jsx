import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import SecurePaymentNotice from '../shared/SecurePaymentNotice';

function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

export default function BookingModal({ trip, onClose, onSuccess }) {
  const [seats, setSeats] = useState(1);
  const [pickup, setPickup] = useState(trip.pickup_point || '');
  const [dropoff, setDropoff] = useState(trip.dropoff_point || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const maxSeats = Math.min(trip.available_seats, 8);
  const total = seats * trip.price_per_seat;

  async function handleConfirm() {
    setSubmitting(true); setError('');
    // book_seats() row-locks the trip and decrements available_seats in the
    // same transaction — this is what actually prevents overbooking, not
    // any check we do here on the client.
    const { error: err } = await supabase.rpc('book_seats', {
      p_trip_id: trip.id,
      p_seats: seats,
      p_pickup_point: pickup || null,
      p_dropoff_point: dropoff || null,
    });
    setSubmitting(false);
    if (err) { setError(err.message); return; }
    onSuccess();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Book this trip</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16 }}>
          {trip.origin} → {trip.destination} · {new Date(trip.departure_time).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>

        {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

        <div className="form-group">
          <label className="form-label">Number of seats</label>
          <select className="form-select" value={seats} onChange={e => setSeats(parseInt(e.target.value, 10))}>
            {Array.from({ length: maxSeats }, (_, i) => i + 1).map(n => (
              <option key={n} value={n}>{n} seat{n > 1 ? 's' : ''}</option>
            ))}
          </select>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{trip.available_seats} seat(s) available.</p>
        </div>

        <div className="form-group">
          <label className="form-label">Pickup point <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input className="form-input" value={pickup} onChange={e => setPickup(e.target.value)} placeholder="e.g. Nyayo Stadium" />
        </div>
        <div className="form-group">
          <label className="form-label">Drop-off point <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input className="form-input" value={dropoff} onChange={e => setDropoff(e.target.value)} placeholder="e.g. Kondele" />
        </div>

        <div className="divider" />

        <div style={{ marginBottom: 16 }}>
          <SecurePaymentNotice variant="compact" />
        </div>

        <div className="flex-between" style={{ marginBottom: 16 }}>
          <span style={{ fontWeight: 600 }}>Total</span>
          <span style={{ fontSize: 18, fontWeight: 800 }}>{formatKES(total)}</span>
        </div>

        <button className="btn btn-primary btn-full" disabled={submitting} onClick={handleConfirm}>
          {submitting ? <span className="spinner" /> : `Confirm booking · ${formatKES(total)}`}
        </button>
      </div>
    </div>
  );
}
