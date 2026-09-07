function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

function formatWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-KE', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_BADGE = {
  scheduled: 'badge-teal', ongoing: 'badge-amber', completion_pending: 'badge-amber', completed: 'badge-green',
  cancelled: 'badge-danger', expired: 'badge-gray',
};

const STATUS_LABEL = {
  scheduled: 'Scheduled', ongoing: 'In progress', completion_pending: 'Awaiting confirmation', completed: 'Completed',
  cancelled: 'Cancelled', expired: 'Expired',
};

/**
 * Shared trip card, used by both the driver "My Trips" page and the
 * passenger search page.
 *
 * `passengerCount` and `seatsBooked` are optional — when omitted the card
 * renders exactly as it always has (3-column stat row), so existing callers
 * (e.g. passenger/SearchTrips.jsx) are unaffected.
 *
 * `statusExtra` is an optional node rendered in the same slot as the
 * cancellation-reason banner (e.g. the 20-minute completion countdown) —
 * omitted entirely for callers that don't pass it.
 *
 * `driverPreview` is an optional node (typically <DriverPreviewCard />)
 * rendered above the stat row — used by passenger/SearchTrips.jsx to show
 * driver/trust info before booking. Omitted entirely for callers that
 * don't pass it (e.g. driver/ManageTrips.jsx, which doesn't need to show
 * the driver their own trust card), so this stays backward-compatible.
 */
export default function TripCard({ trip, actions, passengerCount, seatsBooked, statusExtra, driverPreview }) {
  const hasBookingStats = typeof passengerCount === 'number';
  const bookedSeats = typeof seatsBooked === 'number' ? seatsBooked : Math.max((trip.total_seats || 0) - (trip.available_seats || 0), 0);
  const isFull = (trip.available_seats ?? 0) <= 0;

  const hasRouteDetail = trip.pickup_point || trip.dropoff_point;

  return (
    <div className="card card-pad">
      <div className="flex-between" style={{ marginBottom: 10, alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 15 }}>{trip.origin} → {trip.destination}</strong>
          <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{formatWhen(trip.departure_time)}</p>
          {hasRouteDetail && (
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              {trip.pickup_point && <>Pickup: {trip.pickup_point}</>}
              {trip.pickup_point && trip.dropoff_point && ' · '}
              {trip.dropoff_point && <>Drop-off: {trip.dropoff_point}</>}
            </p>
          )}
        </div>
        <span className={`badge ${STATUS_BADGE[trip.status] || 'badge-gray'}`}>{STATUS_LABEL[trip.status] || trip.status}</span>
      </div>

      {driverPreview && (
        <div style={{ marginBottom: 12 }}>{driverPreview}</div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
          gap: 8,
          marginBottom: (actions || statusExtra || (trip.status === 'cancelled' && trip.cancellation_reason)) ? 14 : 0,
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Price/seat</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{formatKES(trip.price_per_seat)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Seats</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {isFull ? 'Full' : `${trip.available_seats} open`} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>/ {trip.total_seats}</span>
          </div>
        </div>
        {hasBookingStats && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Passengers</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {passengerCount} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({bookedSeats} seat{bookedSeats === 1 ? '' : 's'})</span>
            </div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Vehicle</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{trip.vehicle_plate || '—'}</div>
        </div>
      </div>

      {trip.status === 'cancelled' && trip.cancellation_reason && (
        <div className="alert alert-danger" style={{ marginBottom: actions ? 14 : 0, padding: '8px 12px', fontSize: 12.5 }}>
          Cancelled: {trip.cancellation_reason}
        </div>
      )}

      {statusExtra && (
        <div style={{ marginBottom: actions ? 14 : 0 }}>{statusExtra}</div>
      )}

      {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}
