import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';

export default function RatingModal({ booking, driverId, onClose, onSuccess }) {
  const { user } = useAuth();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (rating === 0) { setError('Please select a star rating.'); return; }
    setSubmitting(true); setError('');
    // The database is the real guard here, not this client-side code: the
    // rating_relationship_is_valid() function behind the ratings INSERT
    // policy independently confirms this booking is completed, that it
    // actually belongs to this passenger and this trip's driver, and the
    // trg_prevent_duplicate_rating trigger blocks a second rating for the
    // same booking — see database/ratings_security_hardening.sql. Using
    // the signed-in user's own id (not a value passed down from a prop)
    // as rater_id also matches what that policy requires: rater_id must
    // equal auth.uid().
    const { error: err } = await supabase.from('ratings').insert({
      booking_id: booking.id,
      trip_id: booking.trip_id,
      rater_id: user.id,
      ratee_id: driverId,
      rating_type: 'passenger_to_driver',
      rating,
      comment: comment.trim() || null,
    });
    setSubmitting(false);
    if (err) {
      if (err.code === '23505') {
        setError("You've already rated this trip.");
      } else {
        setError(err.message || 'Could not submit your rating. Please try again.');
      }
      return;
    }
    onSuccess();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Rate your driver</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 18 }}>
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => setRating(n)}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              style={{ background: 'none', border: 'none', fontSize: 32, cursor: 'pointer', color: n <= (hover || rating) ? '#F59E0B' : 'var(--border)' }}
            >★</button>
          ))}
        </div>

        <div className="form-group">
          <label className="form-label">Comment <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <textarea className="form-input" rows={3} value={comment} onChange={e => setComment(e.target.value)} placeholder="How was your trip?" />
        </div>

        <button className="btn btn-primary btn-full" disabled={submitting} onClick={handleSubmit}>
          {submitting ? <span className="spinner" /> : 'Submit rating'}
        </button>
      </div>
    </div>
  );
}
