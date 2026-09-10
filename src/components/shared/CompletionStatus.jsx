import { useState } from 'react';
import { formatSecondsRemaining, DECLINE_REASONS } from '../../lib/tripCompletion';
import DeclineCompletionModal from '../passenger/DeclineCompletionModal';

const REASON_LABEL = Object.fromEntries(DECLINE_REASONS.map(r => [r.value, r.label]));

/**
 * Shows the individual completion-confirmation state for a trip in
 * `completion_pending`. `status` is one row from get_trip_completion_status
 * (see src/lib/tripCompletion.js) — an aggregate accepted/declined/pending
 * breakdown plus the CALLING user's own response.
 *
 * Pass `onAccept` + `onDecline` (and `responding`) to render the
 * passenger's own Accept/Decline actions — omit them for a read-only view
 * (e.g. the driver's dashboard, which only ever sees the aggregate + can
 * open the full per-passenger list via TripPassengerCompletionsModal).
 */
export default function CompletionStatus({ status, loading, onAccept, onDecline, responding }) {
  const [showDecline, setShowDecline] = useState(false);
  const [declineError, setDeclineError] = useState('');

  if (!status) {
    return (
      <div className="alert alert-amber" style={{ padding: '8px 12px', fontSize: 12.5 }}>
        {loading ? 'Checking confirmation status…' : 'Awaiting passenger confirmation.'}
      </div>
    );
  }

  const { accepted_count, declined_count, pending_count, total_passengers, seconds_remaining, caller_response, caller_decline_reason } = status;

  async function handleDeclineSubmit(reason, comment) {
    setDeclineError('');
    try {
      await onDecline(reason, comment);
      setShowDecline(false);
    } catch (err) {
      setDeclineError(err.message || 'Could not submit. Please try again.');
    }
  }

  return (
    <div className="alert alert-amber" style={{ padding: '10px 12px', fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        🏁 <strong>{accepted_count} accepted</strong> · {declined_count} declined · {pending_count} awaiting response
        {' '}({total_passengers} passenger{total_passengers === 1 ? '' : 's'} total)
        {seconds_remaining != null && <> — {formatSecondsRemaining(seconds_remaining)}</>}
      </div>

      {typeof onAccept === 'function' && (
        caller_response === 'accepted' ? (
          <span className="badge badge-teal" style={{ alignSelf: 'flex-start' }}>✓ You confirmed this trip is complete</span>
        ) : caller_response === 'declined' ? (
          <span className="badge badge-danger" style={{ alignSelf: 'flex-start' }}>
            ✕ You declined — {REASON_LABEL[caller_decline_reason] || caller_decline_reason}
          </span>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Did you complete this journey?</span>
            <button className="btn btn-sm btn-primary" disabled={responding} onClick={onAccept}>
              {responding ? <span className="spinner" /> : '✅ Accept & Mark Completed'}
            </button>
            <button className="btn btn-sm btn-outline" disabled={responding} onClick={() => setShowDecline(true)}>
              ❌ Decline
            </button>
          </div>
        )
      )}

      {showDecline && (
        <DeclineCompletionModal
          onClose={() => setShowDecline(false)}
          onSubmit={handleDeclineSubmit}
          submitting={responding}
          error={declineError}
        />
      )}
    </div>
  );
}
