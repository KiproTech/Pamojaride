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

/**
 * Renders a driver's reviews (star rating, comment, date, privacy-safe
 * reviewer name) as a clean card list.
 *
 * `reviews` is the array returned by fetchDriverReviews() — each row is
 * { id, rating, comment, created_at, reviewer_display_name } from the
 * get_driver_reviews() RPC (database/driver_reviews_display.sql). That RPC
 * already excludes admin-removed reviews and never returns a reviewer's
 * phone, email, or full name — this component just renders what it's given.
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
          <div className="flex-between" style={{ marginBottom: r.comment ? 6 : 2, gap: 8 }}>
            <Stars rating={r.rating} />
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {formatReviewDate(r.created_at)}
            </span>
          </div>
          {r.comment && (
            <p style={{ fontSize: 13, margin: '0 0 6px', color: 'var(--text)', wordBreak: 'break-word' }}>{r.comment}</p>
          )}
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>— {r.reviewer_display_name || 'Passenger'}</span>
        </div>
      ))}
    </div>
  );
}
