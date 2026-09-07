import { useState } from 'react';
import { BOOKING_CANCELLATION_REASONS, BOOKING_CANCELLATION_REASON_OTHER } from '../../lib/bookingCancellationReasons';

function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-KE', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Professional confirmation dialog for a driver cancelling a single
 * passenger's booking on one of their own trips — mirrors CancelTripModal's
 * pattern, but scoped to one booking instead of the whole trip.
 *
 * A cancellation reason is REQUIRED: the driver must pick one of the fixed
 * dropdown reasons, and if they pick "Other" they must also type an
 * explanation. This component only gates the UI though — the real,
 * unbypassable enforcement (reason mandatory, category must be one of the
 * fixed values, "Other" must include text, driver must own the trip, and a
 * completed trip's bookings can never be cancelled this way) lives in the
 * `cancel_booking` database function, so even a direct RPC call without
 * going through this form is still rejected server-side.
 *
 * `onConfirm` is called with `{ category, details }` — `category` is one of
 * the BOOKING_CANCELLATION_REASONS values, `details` is the free-text
 * explanation (only meaningful, and only required, when category is
 * 'other').
 */
export default function CancelBookingModal({ booking, busy, error, onConfirm, onClose }) {
  const [category, setCategory] = useState('');
  const [details, setDetails] = useState('');
  const [attempted, setAttempted] = useState(false);
  const isOther = category === BOOKING_CANCELLATION_REASON_OTHER;

  const categoryMissing = !category;
  const detailsMissing = isOther && !details.trim();
  const isValid = !categoryMissing && !detailsMissing;

  function handleConfirmClick() {
    if (!isValid) {
      setAttempted(true);
      return;
    }
    onConfirm({ category, details: details.trim() || null });
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Cancel this passenger's booking?</h3>
          {!busy && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>

        <p style={{ fontSize: 13.5, marginBottom: 14 }}>
          <strong>{booking.passenger_name || 'Passenger'}</strong> — {booking.seats_booked} seat{booking.seats_booked === 1 ? '' : 's'} · {booking.booking_reference}<br />
          <span style={{ color: 'var(--text-muted)' }}>{booking.origin} → {booking.destination} · {formatWhen(booking.departure_time)}</span>
        </p>

        <div className="alert alert-danger" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
          Cancelling will immediately release this passenger's seat back to your trip and notify them, including the reason you select below. This cannot be undone — the booking record is kept for history, but its status will change to "Cancelled".
        </div>

        <div className="form-group" style={{ marginBottom: isOther ? 10 : 16 }}>
          <label className="form-label">Reason for cancelling <span style={{ color: 'var(--danger)' }}>*</span></label>
          <select
            className="form-select"
            value={category}
            disabled={busy}
            required
            onChange={e => { setCategory(e.target.value); if (e.target.value !== BOOKING_CANCELLATION_REASON_OTHER) setDetails(''); }}
          >
            <option value="">Select a reason</option>
            {BOOKING_CANCELLATION_REASONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          {attempted && categoryMissing && (
            <span className="form-error">A cancellation reason is required.</span>
          )}
        </div>

        {isOther && (
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">Please explain <span style={{ color: 'var(--danger)' }}>*</span></label>
            <textarea
              className="form-input"
              rows={3}
              value={details}
              onChange={e => setDetails(e.target.value)}
              placeholder="Tell us why you're cancelling this booking — this is shown to the passenger"
              disabled={busy}
              required
              style={{ resize: 'vertical', fontFamily: "'DM Sans', sans-serif" }}
            />
            {attempted && detailsMissing && (
              <span className="form-error">Please explain the reason for cancelling.</span>
            )}
          </div>
        )}

        {error && <div className="alert alert-danger" style={{ marginBottom: 16, fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>Keep booking</button>
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={handleConfirmClick}
          >
            {busy ? <span className="spinner" /> : 'Yes, cancel booking'}
          </button>
        </div>
      </div>
    </div>
  );
}
