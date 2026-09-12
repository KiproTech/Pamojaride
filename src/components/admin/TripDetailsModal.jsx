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

function Avatar({ picture, name, size = 40 }) {
  return picture ? (
    <img src={picture} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  ) : (
    <span className="topbar-avatar" style={{ width: size, height: size, fontSize: size * 0.35, flexShrink: 0 }}>{initials(name)}</span>
  );
}

const TRIP_STATUS_BADGE = {
  scheduled: 'badge-teal', ongoing: 'badge-amber', completion_pending: 'badge-amber',
  completed: 'badge-green', cancelled: 'badge-danger', expired: 'badge-gray',
};

const BOOKING_STATUS_BADGE = {
  pending: 'badge-amber', confirmed: 'badge-teal', completed: 'badge-green',
  cancelled: 'badge-gray', no_show: 'badge-danger',
};

const RESPONSE_META = {
  accepted: { label: 'Confirmed by passenger', badge: 'badge-green' },
  declined: { label: 'Declined by passenger', badge: 'badge-danger' },
  pending: { label: 'Awaiting passenger response', badge: 'badge-amber' },
  auto_completed: { label: 'Auto-completed (no response)', badge: 'badge-gray' },
  admin_override: { label: 'Completed by admin override', badge: 'badge-teal' },
};

const COMPLETION_SOURCE_LABEL = {
  driver: 'Driver marked the trip completed',
  admin: 'An administrator marked the trip completed',
  auto_timeout: 'Automatically completed (confirmation window expired)',
};

function SectionHeading({ children, action }) {
  return (
    <div className="flex-between" style={{ marginBottom: 10, marginTop: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</div>
      {action}
    </div>
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

/**
 * Admin — Complete Trip Details.
 *
 * Fetched via two admin-only SECURITY DEFINER RPCs —
 * get_admin_trip_details() and get_admin_trip_passenger_roster(), in
 * database/admin_trip_oversight_detail_rpcs.sql — the same pattern already
 * used by get_trip_passenger_manifest()/get_admin_reports() elsewhere in
 * this project. (An earlier version of this fetched bookings/confirmations
 * directly via embedded client queries; that hit 403s because admin's
 * direct-REST access doesn't extend to `bookings`/`trip_completion_confirmations`,
 * only the RPC path does.) Nothing here duplicates an existing table, and
 * PassengerManifestModal / TripPassengerCompletionsModal stay untouched.
 *
 * Navigation: this modal never fetches the driver's full profile itself —
 * "View Driver Profile" delegates to the existing DriverDetailsModal via
 * onViewDriver. "View Passenger Profile" / "View Booking" push onto the
 * shared navigation stack in TripOversight.jsx (onViewPassenger /
 * onViewBooking) so Trip -> Passenger -> Booking -> Trip preserves context
 * with a real Back button, per the brief's navigation requirement.
 */
export default function TripDetailsModal({ tripId, onClose, onBack, onViewDriver, onViewPassenger, onViewBooking, onChanged }) {
  const [trip, setTrip] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [completeOpen, setCompleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [{ data: tripRows, error: tripErr }, { data: bookingRows, error: bookErr }] = await Promise.all([
        supabase.rpc('get_admin_trip_details', { p_trip_id: tripId }),
        supabase.rpc('get_admin_trip_passenger_roster', { p_trip_id: tripId }),
      ]);
      if (tripErr) throw tripErr;
      if (bookErr) throw bookErr;
      setTrip((tripRows || [])[0] || null);
      setBookings(bookingRows || []);
    } catch (err) {
      setError(err.message || 'Could not load this trip.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tripId]);

  async function confirmCancel() {
    if (!cancelReason.trim()) return;
    setBusy(true);
    setActionError('');
    const { error: rpcError } = await supabase.rpc('cancel_trip', { p_trip_id: tripId, p_reason: cancelReason.trim() });
    setBusy(false);
    if (rpcError) { setActionError(rpcError.message); return; }
    setCancelOpen(false);
    setCancelReason('');
    load();
    onChanged?.();
  }

  async function confirmComplete() {
    setBusy(true);
    setActionError('');
    const { error: rpcError } = await supabase.rpc('admin_complete_trip', { p_trip_id: tripId });
    setBusy(false);
    if (rpcError) { setActionError(rpcError.message); return; }
    setCompleteOpen(false);
    load();
    onChanged?.();
  }

  // Trip activity timeline — built client-side from the timestamped fields
  // already returned by the two RPCs above. No new history table; nothing
  // here is stored anywhere, it's assembled on read.
  const timeline = [];
  if (trip) {
    timeline.push({ at: trip.created_at, label: 'Trip created by driver', who: trip.driver_name, icon: '🚗' });
    bookings.forEach(b => {
      timeline.push({ at: b.booking_created_at, label: `${b.passenger_name || 'Passenger'} booked ${b.seats_booked} seat${b.seats_booked === 1 ? '' : 's'}`, who: `Ref ${b.booking_reference}`, icon: '🎫' });
      if (b.cancelled_at) {
        timeline.push({ at: b.cancelled_at, label: `Booking for ${b.passenger_name || 'passenger'} cancelled`, who: b.cancelled_by_name ? `By ${b.cancelled_by_name}` : undefined, detail: b.cancellation_reason, icon: '❌' });
      }
      if (b.responded_at) {
        const meta = RESPONSE_META[b.completion_response] || RESPONSE_META.pending;
        timeline.push({ at: b.responded_at, label: `${b.passenger_name || 'Passenger'} — ${meta.label}`, detail: b.completion_response === 'declined' ? (REASON_LABEL[b.decline_reason] || b.decline_reason) : undefined, icon: b.completion_response === 'declined' ? '⚠️' : '✅' });
      } else if (b.requested_at) {
        timeline.push({ at: b.requested_at, label: `Completion confirmation requested from ${b.passenger_name || 'passenger'}`, icon: '⏳' });
      }
    });
    if (trip.cancelled_at) {
      timeline.push({ at: trip.cancelled_at, label: 'Trip cancelled', detail: trip.cancellation_reason, icon: '🚫' });
    }
    if (trip.completed_at) {
      timeline.push({ at: trip.completed_at, label: COMPLETION_SOURCE_LABEL[trip.completion_source] || 'Trip marked completed', who: trip.completed_by_name, icon: '🏁' });
    }
  }
  timeline.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  const vehicleLabel = trip ? [trip.vehicle_make, trip.vehicle_model].filter(Boolean).join(' ') : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {onBack && <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>}
            <h3 style={{ fontSize: 17 }}>Trip Details</h3>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 24 }}><div className="skeleton-row" /><div className="skeleton-row" /></div>
          ) : error ? (
            <div className="alert alert-danger">{error}</div>
          ) : !trip ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Trip not found.</p>
          ) : (
            <>
              {actionError && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{actionError}</div>}

              {/* ── Trip information ────────────────────────────────── */}
              <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{trip.origin} → {trip.destination}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Trip ID: {trip.trip_id}</div>
                </div>
                <span className={`badge ${TRIP_STATUS_BADGE[trip.status] || 'badge-gray'}`} style={{ fontSize: 12.5 }}>{trip.status.replace(/_/g, ' ')}</span>
              </div>

              <div className="grid-2" style={{ gap: 14, marginTop: 16 }}>
                <Field label="Departure" value={formatDateTime(trip.departure_time)} />
                <Field label="Estimated Arrival" value={formatDateTime(trip.estimated_arrival_time)} />
                <Field label="Created" value={formatDateTime(trip.created_at)} />
                <Field label="Price per seat" value={`KSh ${trip.price_per_seat}`} />
                <Field label="Vehicle capacity" value={trip.total_seats} />
                <Field label="Seats booked" value={trip.total_seats - trip.available_seats} />
                <Field label="Remaining seats" value={trip.available_seats} />
                <Field label="Pickup / Dropoff" value={[trip.pickup_point, trip.dropoff_point].filter(Boolean).join(' → ') || '—'} />
              </div>

              {trip.status === 'cancelled' && (
                <div className="alert alert-danger" style={{ marginTop: 14 }}>
                  <strong>Cancelled</strong> {formatDateTime(trip.cancelled_at)}
                  {trip.cancellation_reason && <div style={{ marginTop: 4 }}>{trip.cancellation_reason}</div>}
                </div>
              )}

              <div className="grid-2" style={{ gap: 14, marginTop: 14 }}>
                <Field label="Trip completion status" value={trip.status === 'completed' ? 'Completed' : trip.status === 'completion_pending' ? 'Awaiting passenger confirmations' : '—'} />
                <Field
                  label="Driver completion date/time"
                  value={trip.completion_source === 'driver' ? formatDateTime(trip.completion_requested_at) : '—'}
                />
                <Field
                  label="Marked completed by"
                  value={trip.completed_at ? `${COMPLETION_SOURCE_LABEL[trip.completion_source] || trip.completion_source || 'Unknown source'}${trip.completed_by_name ? ` — ${trip.completed_by_name}` : ''}` : '—'}
                />
                <Field label="Completed at" value={formatDateTime(trip.completed_at)} />
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                {(trip.status === 'scheduled' || trip.status === 'ongoing') && (
                  <button className="btn btn-sm btn-danger" onClick={() => { setCancelOpen(true); setActionError(''); }}>Cancel Trip</button>
                )}
                {(trip.status === 'ongoing' || trip.status === 'completion_pending') && (
                  <button className="btn btn-sm btn-primary" onClick={() => { setCompleteOpen(true); setActionError(''); }}>Mark Trip as Completed</button>
                )}
              </div>

              {/* ── Driver information ──────────────────────────────── */}
              <SectionHeading
                action={<button className="btn btn-sm btn-outline" onClick={() => onViewDriver(trip.driver_id)}>View Driver Profile</button>}
              >
                Driver
              </SectionHeading>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <Avatar picture={trip.driver_profile_picture} name={trip.driver_name} size={52} />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>{trip.driver_name || '—'}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{trip.driver_email} · {trip.driver_phone}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className={`badge ${trip.driver_verification_status === 'verified' ? 'badge-green' : 'badge-gray'}`}>
                      {trip.driver_verification_status || 'pending'}
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {trip.driver_rating_avg != null ? `★ ${trip.driver_rating_avg} (${trip.driver_rating_count} rating${trip.driver_rating_count === 1 ? '' : 's'})` : 'No ratings yet'}
                    </span>
                  </div>
                </div>
                <div style={{ minWidth: 180 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Vehicle</div>
                  <div style={{ fontSize: 13, marginTop: 2 }}>{vehicleLabel || '—'}{trip.vehicle_color ? ` · ${trip.vehicle_color}` : ''}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{trip.vehicle_plate || '—'}</div>
                </div>
              </div>

              {/* ── Passengers on this trip ─────────────────────────── */}
              <SectionHeading>Passengers on This Trip ({bookings.length})</SectionHeading>
              {bookings.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No bookings on this trip.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {bookings.map(b => {
                    const respMeta = b.confirmation_id ? (RESPONSE_META[b.completion_response] || RESPONSE_META.pending) : null;
                    return (
                      <div key={b.booking_id} className="card" style={{ padding: 12, border: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                          <Avatar picture={b.passenger_picture} name={b.passenger_name} />
                          <div style={{ flex: 1, minWidth: 200 }}>
                            <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                              <strong style={{ fontSize: 13.5 }}>{b.passenger_name || 'Passenger'}</strong>
                              <span className={`badge ${BOOKING_STATUS_BADGE[b.booking_status] || 'badge-gray'}`}>{b.booking_status.replace(/_/g, ' ')}</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{b.passenger_email} · {b.passenger_phone}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                              Ref {b.booking_reference} · {b.seats_booked} seat{b.seats_booked === 1 ? '' : 's'} · Booked {formatDateTime(b.booking_created_at)}
                            </div>
                            {respMeta && (
                              <div style={{ marginTop: 6 }}>
                                <span className={`badge ${respMeta.badge}`}>{respMeta.label}</span>
                                {b.completion_response === 'declined' && (
                                  <div style={{ fontSize: 12, marginTop: 4 }}>
                                    <strong>Reason:</strong> {REASON_LABEL[b.decline_reason] || b.decline_reason || '—'}
                                    {b.decline_comment && <div style={{ color: 'var(--text-muted)' }}>"{b.decline_comment}"</div>}
                                  </div>
                                )}
                              </div>
                            )}
                            {b.booking_status === 'cancelled' && b.cancellation_reason && (
                              <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>
                                Cancelled by {b.cancelled_by_name || 'system'}: {b.cancellation_reason}
                              </div>
                            )}
                            {b.reports_count > 0 && (
                              <div style={{ fontSize: 11.5, marginTop: 4 }}>
                                <span className="badge badge-danger">{b.reports_count} report{b.reports_count === 1 ? '' : 's'}</span>
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button className="btn btn-sm btn-outline" onClick={() => onViewPassenger(b.passenger_id)}>View Passenger Profile</button>
                            <button className="btn btn-sm btn-outline" onClick={() => onViewBooking(b.booking_id)}>View Booking</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Trip activity timeline ──────────────────────────── */}
              <SectionHeading>Trip Activity Timeline</SectionHeading>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {timeline.map((ev, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
                    <span style={{ fontSize: 15 }}>{ev.icon}</span>
                    <div>
                      <div>{ev.label}{ev.who ? ` — ${ev.who}` : ''}</div>
                      {ev.detail && <div style={{ color: 'var(--text-muted)' }}>{ev.detail}</div>}
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{formatDateTime(ev.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {cancelOpen && (
          <div style={overlayStyle} onClick={() => !busy && setCancelOpen(false)}>
            <div style={modalStyle} onClick={e => e.stopPropagation()}>
              <h3 style={{ marginBottom: 8 }}>Cancel {trip?.origin} → {trip?.destination}?</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                Every confirmed booking will be cancelled too, and passengers and the driver will be notified. This can't be undone.
              </p>
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">Reason</label>
                <textarea className="form-input" rows={3} value={cancelReason} onChange={e => setCancelReason(e.target.value)} style={{ resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCancelOpen(false)}>Back</button>
                <button className="btn btn-danger btn-sm" disabled={busy || !cancelReason.trim()} onClick={confirmCancel}>
                  {busy ? <span className="spinner" /> : 'Confirm cancellation'}
                </button>
              </div>
            </div>
          </div>
        )}

        {completeOpen && (
          <div style={overlayStyle} onClick={() => !busy && setCompleteOpen(false)}>
            <div style={modalStyle} onClick={e => e.stopPropagation()}>
              <h3 style={{ marginBottom: 8 }}>Mark trip as complete?</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                This immediately completes the trip. Existing individual passenger confirmations (accepted/declined) are preserved
                — only still-pending ones are closed out as admin-completed. Passengers are notified but not asked to approve this.
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCompleteOpen(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={confirmComplete}>
                  {busy ? <span className="spinner" /> : 'Confirm Completion'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20,
};
const modalStyle = {
  background: 'white', borderRadius: 16, padding: '28px 30px', maxWidth: 420, width: '100%',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', fontFamily: "'DM Sans', sans-serif",
};
