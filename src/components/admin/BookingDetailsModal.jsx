import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { DECLINE_REASONS } from '../../lib/tripCompletion';

const REASON_LABEL = Object.fromEntries(DECLINE_REASONS.map(r => [r.value, r.label]));

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Avatar({ picture, name, size = 44 }) {
  return picture ? (
    <img src={picture} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  ) : (
    <span className="topbar-avatar" style={{ width: size, height: size, fontSize: size * 0.35, flexShrink: 0 }}>{initials(name)}</span>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 13.5, marginTop: 2 }}>{value ?? '—'}</div>
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 20, marginBottom: 10 }}>
      {children}
    </div>
  );
}

const BOOKING_STATUS_BADGE = {
  pending: 'badge-amber', confirmed: 'badge-teal', completed: 'badge-green',
  cancelled: 'badge-gray', no_show: 'badge-danger',
};

const RESPONSE_META = {
  accepted: { label: 'Confirmed', badge: 'badge-green' },
  declined: { label: 'Declined', badge: 'badge-danger' },
  pending: { label: 'Pending passenger response', badge: 'badge-amber' },
  auto_completed: { label: 'Auto-completed (no response)', badge: 'badge-gray' },
  admin_override: { label: 'Completed by admin override', badge: 'badge-teal' },
};

/**
 * Admin — Booking Details. One booking's complete record: passenger, trip,
 * driver, completion state, and any reports tied to it. Fetched via
 * get_admin_booking_detail() + get_admin_booking_reports(), in
 * database/admin_trip_oversight_detail_rpcs.sql — a superset of
 * get_passenger_booking_detail()/get_driver_booking_detail() (neither
 * returns BOTH driver and passenger identity, which an admin genuinely
 * needs), built the same SECURITY DEFINER way as every other cross-user
 * view in this project. No new table.
 */
export default function BookingDetailsModal({ bookingId, onClose, onBack, onViewTrip, onViewPassenger }) {
  const [booking, setBooking] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [{ data: rows, error: err }, { data: reportRows }] = await Promise.all([
          supabase.rpc('get_admin_booking_detail', { p_booking_id: bookingId }),
          supabase.rpc('get_admin_booking_reports', { p_booking_id: bookingId }),
        ]);
        if (err) throw err;
        if (!active) return;
        setBooking((rows || [])[0] || null);
        setReports(reportRows || []);
      } catch (err) {
        if (active) setError(err.message || 'Could not load this booking.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [bookingId]);

  const respMeta = booking?.completion_response ? (RESPONSE_META[booking.completion_response] || RESPONSE_META.pending) : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 620, maxHeight: '88vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {onBack && <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>}
            <h3 style={{ fontSize: 17 }}>Booking Details</h3>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <div style={{ padding: 24 }}><div className="skeleton-row" /><div className="skeleton-row" /></div>
        ) : error ? (
          <div className="alert alert-danger">{error}</div>
        ) : !booking ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Booking not found.</p>
        ) : (
          <>
            <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Ref {booking.booking_reference}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Booking ID: {booking.booking_id}</div>
              </div>
              <span className={`badge ${BOOKING_STATUS_BADGE[booking.booking_status] || 'badge-gray'}`}>{booking.booking_status.replace(/_/g, ' ')}</span>
            </div>

            <SectionHeading>Passenger</SectionHeading>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Avatar picture={booking.passenger_picture} name={booking.passenger_name} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <strong style={{ fontSize: 14 }}>{booking.passenger_name}</strong>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{booking.passenger_email} · {booking.passenger_phone}</div>
              </div>
              <button className="btn btn-sm btn-outline" onClick={() => onViewPassenger(booking.passenger_id)}>View Passenger Profile</button>
            </div>

            <SectionHeading>Trip</SectionHeading>
            <div className="grid-2" style={{ gap: 14 }}>
              <Field label="Route" value={`${booking.origin} → ${booking.destination}`} />
              <Field label="Departure" value={formatDateTime(booking.departure_time)} />
              <Field label="Driver" value={booking.driver_name} />
              <Field label="Vehicle" value={[booking.vehicle_make, booking.vehicle_model, booking.vehicle_plate].filter(Boolean).join(' · ')} />
            </div>
            <button className="btn btn-sm btn-outline" style={{ marginTop: 10 }} onClick={() => onViewTrip(booking.trip_id)}>View Trip</button>

            <SectionHeading>Booking</SectionHeading>
            <div className="grid-2" style={{ gap: 14 }}>
              <Field label="Seats" value={booking.seats_booked} />
              <Field label="Total price" value={`KSh ${booking.total_price}`} />
              <Field label="Created" value={formatDateTime(booking.booking_created_at)} />
              <Field label="Payment status" value={booking.refund_status === 'not_applicable' ? 'N/A' : booking.refund_status} />
              <Field label="Pickup / Dropoff" value={[booking.pickup_point, booking.dropoff_point].filter(Boolean).join(' → ') || '—'} />
            </div>

            {booking.booking_status === 'cancelled' && (
              <div className="alert alert-danger" style={{ marginTop: 14 }}>
                <strong>Cancelled</strong> {formatDateTime(booking.cancelled_at)} by {booking.cancelled_by_name || 'system'}
                {booking.cancellation_reason && <div style={{ marginTop: 4 }}>{booking.cancellation_reason}</div>}
              </div>
            )}

            <SectionHeading>Completion Status</SectionHeading>
            {respMeta ? (
              <div>
                <span className={`badge ${respMeta.badge}`}>{respMeta.label}</span>
                <div className="grid-2" style={{ gap: 14, marginTop: 10 }}>
                  <Field label="Requested" value={formatDateTime(booking.requested_at)} />
                  <Field label="Responded" value={formatDateTime(booking.responded_at)} />
                </div>
                {booking.completion_response === 'declined' && (
                  <div style={{ fontSize: 13, marginTop: 8 }}>
                    <strong>Decline reason:</strong> {REASON_LABEL[booking.decline_reason] || booking.decline_reason || '—'}
                    {booking.decline_comment && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>"{booking.decline_comment}"</div>}
                  </div>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No completion confirmation has been requested for this booking.</p>
            )}

            <SectionHeading>Related Reports ({reports.length})</SectionHeading>
            {reports.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>None.</p>
            ) : reports.map(r => (
              <div key={r.report_id} className="card" style={{ padding: 10, border: '1px solid var(--border)', marginBottom: 8 }}>
                <div className="flex-between" style={{ gap: 8 }}>
                  <strong style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{(r.category || '').replace(/_/g, ' ')}</strong>
                  <span className="badge badge-gray">{r.status.replace(/_/g, ' ')}</span>
                </div>
                <p style={{ fontSize: 12, marginTop: 4 }}>{r.description}</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
