import { useState } from 'react';
import { CANCELLATION_REASONS, CANCELLATION_REASON_OTHER } from '../../lib/cancellationReasons';

function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-KE', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Professional confirmation dialog for a driver cancelling one of their own
 * trips — replaces the old browser `confirm()` popup.
 *
 * A cancellation reason is REQUIRED: the driver must pick one of the fixed
 * dropdown reasons, and if they pick "Other" they must also type an
 * explanation. This component only gates the UI though — the real,
 * unbypassable enforcement (reason mandatory, category must be one of the
 * fixed values, "Other" must include text, and a trip that has already
 * started can never be cancelled by a driver) lives in the `cancel_trip`
 * database function, so even a direct RPC call without going through this
 * form is still rejected server-side. Callers should only render this for
 * a trip that hasn't started yet (i.e. it's still `scheduled` and its
 * departure time hasn't passed) — cancel_trip enforces that too.
 *
 * `passengerCount` / `seatsBooked` are optional — when omitted (or zero) the
 * dialog shows the "no passengers yet" message instead of the warning.
 *
 * `onConfirm` is called with `{ category, details }` — `category` is one of
 * the CANCELLATION_REASONS values, `details` is the free-text explanation
 * (only meaningful, and only required, when category is 'other').
 */
export default function CancelTripModal({ trip, passengerCount = 0, seatsBooked = 0, busy, error, onConfirm, onClose }) {
  const [category, setCategory] = useState('');
  const [details, setDetails] = useState('');
  const [attempted, setAttempted] = useState(false);
  const hasPassengers = passengerCount > 0;
  const isOther = category === CANCELLATION_REASON_OTHER;

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
          <h3 style={{ fontSize: 17 }}>Cancel this trip?</h3>
          {!busy && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>

        <p style={{ fontSize: 13.5, marginBottom: 14 }}>
          <strong>{trip.origin} → {trip.destination}</strong><br />
          <span style={{ color: 'var(--text-muted)' }}>{formatWhen(trip.departure_time)}</span>
        </p>

        {hasPassengers ? (
          <div className="alert alert-danger" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
            <strong>{passengerCount} passenger{passengerCount === 1 ? '' : 's'}</strong>{' '}
            {passengerCount === 1 ? 'has' : 'have'} {seatsBooked} seat{seatsBooked === 1 ? '' : 's'} booked on this trip.
            Cancelling will immediately cancel {passengerCount === 1 ? 'their booking' : 'their bookings'} and notify{' '}
            {passengerCount === 1 ? 'them' : 'each of them'} with the reason below. Affected bookings will be flagged for a refund review.
          </div>
        ) : (
          <div className="alert alert-amber" style={{ marginBottom: 16, fontSize: 13 }}>
            No passengers have booked this trip yet — cancelling now won't affect anyone.
          </div>
        )}

        <div className="form-group" style={{ marginBottom: isOther ? 10 : 16 }}>
          <label className="form-label">Reason for cancelling <span style={{ color: 'var(--danger)' }}>*</span></label>
          <select
            className="form-select"
            value={category}
            disabled={busy}
            required
            onChange={e => { setCategory(e.target.value); if (e.target.value !== CANCELLATION_REASON_OTHER) setDetails(''); }}
          >
            <option value="">Select a reason</option>
            {CANCELLATION_REASONS.map(r => (
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
              placeholder="Tell us why you're cancelling — this is shown to affected passengers"
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
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>Keep trip</button>
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={handleConfirmClick}
          >
            {busy ? <span className="spinner" /> : 'Yes, cancel trip'}
          </button>
        </div>
      </div>
    </div>
  );
}
