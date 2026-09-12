function Stars({ rating }) {
  const n = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return (
    <span style={{ color: '#F59E0B', letterSpacing: 1, fontSize: 13, flexShrink: 0 }}>
      {'★'.repeat(n)}{'☆'.repeat(5 - n)}
    </span>
  );
}

function formatReviewDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Small circular avatar with the same photo-or-initials fallback used
 * everywhere else in the app (see Navbar.jsx). */
function ReviewerAvatar({ name, picture, size }) {
  const initials = (name || 'P').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || 'P';
  return (
    <span
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--primary-light, #E0E7FF)', color: 'var(--primary, #4338CA)',
        fontSize: size * 0.4, fontWeight: 600, overflow: 'hidden',
      }}
    >
      {picture
        ? <img src={picture} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initials}
    </span>
  );
}

/**
 * Renders a driver's reviews (reviewer avatar + full name, star rating,
 * comment, date) as a clean card list.
 *
 * `reviews` is the array returned by fetchDriverReviews() — each row is
 * { id, rating, comment, created_at, reviewer_full_name, reviewer_profile_picture }
 * from the get_driver_reviews() RPC (database/driver_reviews_display.sql /
 * trip_lifecycle_hardening_and_reminders.sql). This component just renders
 * whatever identity the RPC hands it, and falls back to the same
 * photo-or-initials avatar used across the rest of the app when there's no
 * profile picture.
 *
 * Pass `compact` for tighter spacing (e.g. inside a driver dashboard rail).
 */
export default function ReviewsList({ reviews, loading, error, compact }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--text-muted)', padding: compact ? '8px 0' : '12px 0' }}>
        <span className="spinner" style={{ width: 14, height: 14 }} /> Loading reviews…
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger" style={{ fontSize: 12.5, marginBottom: 0 }}>
        Couldn't load reviews right now. Please try again shortly.
      </div>
    );
  }

  if (!reviews || reviews.length === 0) {
    return (
      <div className="empty-state" style={{ padding: compact ? '20px 12px' : '32px 12px' }}>
        <div className="empty-icon" style={{ fontSize: compact ? 26 : 34 }}>💬</div>
        <p>No reviews yet.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12 }}>
      {reviews.map(r => (
        <div
          key={r.id}
          className="card"
          style={{ padding: compact ? 10 : 12, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}
        >
          <div className="flex-between" style={{ marginBottom: 6, gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <ReviewerAvatar name={r.reviewer_full_name} picture={r.reviewer_profile_picture} size={compact ? 26 : 30} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.reviewer_full_name || 'Passenger'}
              </span>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {formatReviewDate(r.created_at)}
            </span>
          </div>
          <Stars rating={r.rating} />
          {r.comment && (
            <p style={{ fontSize: 13, margin: '6px 0 0', color: 'var(--text)', wordBreak: 'break-word' }}>{r.comment}</p>
          )}
        </div>
      ))}
    </div>
  );
}
