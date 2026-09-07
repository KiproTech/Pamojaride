function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

const STATUS_BADGE = {
  pending: 'badge-amber',
  confirmed: 'badge-teal',
  completed: 'badge-green',
  cancelled: 'badge-danger',
  no_show: 'badge-danger',
};

const STATUS_LABEL = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/**
 * Generic booking card, reused by both the driver's "Bookings" page
 * (personName = passenger, personLabel = phone, tripLabel = the trip)
 * and the passenger's "My Bookings" page (personName = the trip route,
 * personLabel = departure time, no tripLabel needed).
 *
 * `extra` is an optional node rendered above the cancellation/refund notes
 * (e.g. the "confirm trip completion" prompt) — omitted entirely for
 * callers that don't pass it.
 *
 * `onClick`, if given, makes the whole card open (e.g. a Trip/Booking
 * Details page) — the `actions` row stops its own clicks from bubbling up
 * to it, so Cancel/Rate/Report buttons still work without also navigating.
 */
export default function BookingCard({ booking, personName, personLabel, tripLabel, actions, extra, onClick }) {
  return (
    <div
      className="card card-pad"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(e); } : undefined}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="flex-between" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
        <div>
          <strong style={{ fontSize: 15 }}>{personName || 'Unknown'}</strong>
          {personLabel && <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{personLabel}</p>}
          {tripLabel && <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{tripLabel}</p>}
        </div>
        <span className={`badge ${STATUS_BADGE[booking.status] || 'badge-gray'}`}>
          {STATUS_LABEL[booking.status] || booking.status}
        </span>
      </div>

      <div className="grid-3" style={{ gap: 8, marginBottom: actions ? 14 : 0 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Reference</div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{booking.booking_reference}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Seats</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{booking.seats_booked}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{formatKES(booking.total_price)}</div>
        </div>
      </div>

      {extra && <div style={{ marginBottom: 10 }} onClick={e => e.stopPropagation()}>{extra}</div>}

      {booking.status === 'cancelled' && booking.cancellation_reason && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>
          Cancelled: {booking.cancellation_reason}
        </p>
      )}

      {booking.status === 'cancelled' && booking.refund_status === 'pending' && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>
          💰 Refund pending review
        </p>
      )}

      {actions && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}
