import { useState } from 'react';
import { DECLINE_REASONS } from '../../lib/tripCompletion';

/**
 * Opened from CompletionStatus when a passenger clicks "Decline" on a
 * completion_pending trip. Requires a reason (and a comment when "Other"
 * is picked) before it lets the passenger submit — the real enforcement of
 * both rules is server-side in respond_trip_completion(), this is just UX.
 */
export default function DeclineCompletionModal({ onClose, onSubmit, submitting, error }) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');

  const needsComment = reason === 'other';
  const canSubmit = reason && (!needsComment || comment.trim());

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Decline trip completion</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
          Let us know why this trip wasn't completed for you. This won't mark your booking as
          completed, and your driver and PamojaRide's support team will see the reason.
        </p>

        {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

        <div className="form-group">
          <label className="form-label">Reason</label>
          {DECLINE_REASONS.map(r => (
            <label key={r.value} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', fontSize: 13.5, cursor: 'pointer' }}>
              <input type="radio" name="decline-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
              {r.label}
            </label>
          ))}
        </div>

        {needsComment && (
          <div className="form-group">
            <label className="form-label">Tell us more</label>
            <textarea
              className="form-input"
              rows={3}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Briefly describe what happened…"
            />
          </div>
        )}

        <button className="btn btn-danger btn-full" disabled={!canSubmit || submitting} onClick={() => onSubmit(reason, comment.trim())}>
          {submitting ? <span className="spinner" /> : 'Submit decline'}
        </button>
      </div>
    </div>
  );
}
