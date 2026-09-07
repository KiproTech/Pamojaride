import { formatSecondsRemaining } from '../../lib/tripCompletion';

/**
 * Shows "3 of 5 confirmed · 12:34 left" for a trip in `completion_pending`.
 * Pass `onConfirm` (and `confirming`) to also render the passenger's
 * "Confirm trip is complete" button — omit it for the driver's read-only view.
 *
 * `status` is the row returned by get_trip_completion_status (see
 * src/lib/tripCompletion.js). Renders a lightweight loading line if `status`
 * is still null (first fetch in flight).
 */
export default function CompletionStatus({ status, loading, onConfirm, confirming }) {
  if (!status) {
    return (
      <div className="alert alert-amber" style={{ padding: '8px 12px', fontSize: 12.5 }}>
        {loading ? 'Checking confirmation status…' : 'Awaiting passenger confirmation.'}
      </div>
    );
  }

  const { confirmed_count, required_confirmations, total_passengers, seconds_remaining, caller_confirmed } = status;

  return (
    <div className="alert alert-amber" style={{ padding: '10px 12px', fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        🕒 <strong>{confirmed_count} of {required_confirmations}</strong> needed confirmations in
        {' '}({total_passengers} passenger{total_passengers === 1 ? '' : 's'} total) — {formatSecondsRemaining(seconds_remaining)}
        {' '}If the window closes first, the trip completes automatically.
      </div>
      {typeof onConfirm === 'function' && (
        caller_confirmed ? (
          <span className="badge badge-teal" style={{ alignSelf: 'flex-start' }}>✓ You confirmed — waiting on others</span>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={confirming} onClick={onConfirm} style={{ alignSelf: 'flex-start' }}>
            {confirming ? <span className="spinner" /> : '✅ Confirm trip is complete'}
          </button>
        )
      )}
    </div>
  );
}
