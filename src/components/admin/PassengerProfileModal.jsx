import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Avatar({ picture, name, size = 48 }) {
  return picture ? (
    <img src={picture} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  ) : (
    <span className="topbar-avatar" style={{ width: size, height: size, fontSize: size * 0.35, flexShrink: 0 }}>{initials(name)}</span>
  );
}

function Stars({ rating }) {
  const n = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return <span style={{ color: '#F59E0B', letterSpacing: 1, fontSize: 13 }}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>;
}

function Stat({ label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: 'var(--bg-alt)', borderRadius: 10, textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 19, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 22, marginBottom: 10 }}>
      {children}
    </div>
  );
}

const BOOKING_STATUS_BADGE = {
  pending: 'badge-amber', confirmed: 'badge-teal', completed: 'badge-green',
  cancelled: 'badge-gray', no_show: 'badge-danger',
};

const REPORT_STATUS_BADGE = {
  open: 'badge-amber', under_review: 'badge-teal', resolved: 'badge-green', dismissed: 'badge-gray',
};

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'activity', label: 'Trip Activity' },
  { value: 'ratings', label: 'Ratings & Reviews' },
  { value: 'reports', label: 'Reports' },
];

/**
 * Admin — Complete Passenger Profile.
 *
 * Fetched via four admin-only SECURITY DEFINER RPCs, in
 * database/admin_trip_oversight_detail_rpcs.sql: get_admin_passenger_profile,
 * get_admin_passenger_bookings, get_admin_passenger_ratings,
 * get_admin_passenger_reports. This is the same pattern already used by
 * get_admin_reports()/get_trip_passenger_manifest() elsewhere in the
 * project — a direct embedded client query against bookings/ratings/reports
 * returns 403 for the admin role, so every one of these goes through a
 * function instead. Booking statistics and upcoming/ongoing/past
 * classification are derived on read from the rows get_admin_passenger_bookings
 * already returns, never stored separately, so they can never drift out of
 * sync with the real booking data. No new passenger-history table, no
 * duplicate profile structure.
 */
export default function PassengerProfileModal({ passengerId, onClose, onBack, onViewBooking }) {
  const [tab, setTab] = useState('overview');
  const [profile, setProfile] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [
          { data: profileRows, error: pErr },
          { data: bookingRows, error: bErr },
          { data: ratingRows },
          { data: reportRows },
        ] = await Promise.all([
          supabase.rpc('get_admin_passenger_profile', { p_passenger_id: passengerId }),
          supabase.rpc('get_admin_passenger_bookings', { p_passenger_id: passengerId }),
          supabase.rpc('get_admin_passenger_ratings', { p_passenger_id: passengerId }),
          supabase.rpc('get_admin_passenger_reports', { p_passenger_id: passengerId }),
        ]);
        if (pErr) throw pErr;
        if (bErr) throw bErr;
        if (!active) return;
        setProfile((profileRows || [])[0] || null);
        setBookings(bookingRows || []);
        setRatings(ratingRows || []);
        setReports(reportRows || []);
      } catch (err) {
        if (active) setError(err.message || "Could not load this passenger's profile.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [passengerId]);

  const now = Date.now();
  const stats = {
    total: bookings.length,
    active: bookings.filter(b => b.booking_status === 'confirmed').length,
    completed: bookings.filter(b => b.booking_status === 'completed').length,
    cancelled: bookings.filter(b => b.booking_status === 'cancelled').length,
    noShow: bookings.filter(b => b.booking_status === 'no_show').length,
    seats: bookings.filter(b => ['confirmed', 'completed'].includes(b.booking_status)).reduce((s, b) => s + (b.seats_booked || 0), 0),
    upcoming: bookings.filter(b => b.booking_status === 'confirmed' && b.trip_status === 'scheduled' && new Date(b.departure_time).getTime() > now).length,
    ongoing: bookings.filter(b => ['ongoing', 'completion_pending'].includes(b.trip_status)).length,
    past: bookings.filter(b => b.trip_status === 'completed' || (b.departure_time && new Date(b.departure_time).getTime() < now)).length,
  };

  const ratingsReceived = ratings.filter(r => r.direction === 'received');
  const ratingsGiven = ratings.filter(r => r.direction === 'given');
  const reportsSubmitted = reports.filter(r => r.direction === 'submitted');
  const reportsAbout = reports.filter(r => r.direction === 'about');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {onBack && <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>}
            <h3 style={{ fontSize: 17 }}>Passenger Profile</h3>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 24 }}><div className="skeleton-row" /><div className="skeleton-row" /></div>
          ) : error ? (
            <div className="alert alert-danger">{error}</div>
          ) : !profile ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Passenger not found.</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <Avatar picture={profile.profile_picture} name={profile.full_name} size={56} />
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{profile.full_name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{profile.email} · {profile.phone}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>Passenger since {formatDate(profile.created_at)}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span className={`badge ${profile.account_status === 'active' ? 'badge-green' : profile.account_status === 'suspended' ? 'badge-amber' : 'badge-danger'}`}>
                    {profile.account_status || 'active'}
                  </span>
                  {profile.flagged_for_review && <span className="badge badge-danger">Flagged</span>}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 20, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                {TABS.map(t => (
                  <button
                    key={t.value}
                    onClick={() => setTab(t.value)}
                    className="btn btn-sm"
                    style={{
                      border: 'none', borderRadius: '8px 8px 0 0', background: tab === t.value ? 'var(--bg-alt)' : 'transparent',
                      fontWeight: tab === t.value ? 700 : 500, color: tab === t.value ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'overview' && (
                <>
                  <SectionHeading>Basic Profile Information</SectionHeading>
                  <div className="grid-2" style={{ gap: 14 }}>
                    <Field label="Profile ID" value={profile.passenger_id} mono />
                    <Field label="Account created" value={formatDateTime(profile.created_at)} />
                    <Field label="Phone verified" value={profile.phone_verified ? 'Yes' : 'No'} />
                    <Field label="Emergency contact" value={profile.emergency_contact_name ? `${profile.emergency_contact_name} · ${profile.emergency_contact_phone || '—'}` : '—'} />
                    <Field label="Trust level" value={profile.trust_level ?? '—'} />
                    <Field label="Dispute count" value={profile.dispute_count ?? 0} />
                  </div>
                  {profile.suspension_reason && (
                    <div className="alert alert-danger" style={{ marginTop: 14 }}>{profile.suspension_reason}</div>
                  )}

                  <SectionHeading>Booking Statistics</SectionHeading>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <Stat label="Total Bookings" value={stats.total} />
                    <Stat label="Active" value={stats.active} />
                    <Stat label="Completed" value={stats.completed} />
                    <Stat label="Cancelled" value={stats.cancelled} />
                    <Stat label="No-show" value={stats.noShow} />
                    <Stat label="Seats Booked" value={stats.seats} />
                    <Stat label="Upcoming" value={stats.upcoming} />
                    <Stat label="Ongoing" value={stats.ongoing} />
                    <Stat label="Past" value={stats.past} />
                  </div>
                </>
              )}

              {tab === 'activity' && (
                <>
                  <SectionHeading>Trip Activity ({bookings.length})</SectionHeading>
                  {bookings.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No bookings yet.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {bookings.map(b => (
                        <div key={b.booking_id} className="card" style={{ padding: 12, border: '1px solid var(--border)' }}>
                          <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: 13.5 }}>{b.origin} → {b.destination}</strong>
                            <span className={`badge ${BOOKING_STATUS_BADGE[b.booking_status] || 'badge-gray'}`}>{b.booking_status.replace(/_/g, ' ')}</span>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                            {formatDateTime(b.departure_time)} · Driver: {b.driver_name || '—'} · Ref {b.booking_reference} · {b.seats_booked} seat{b.seats_booked === 1 ? '' : 's'}
                          </div>
                          {b.completion_response && (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                              Completion: {b.completion_response}{b.completion_response === 'declined' && b.decline_reason ? ` (${b.decline_reason})` : ''}
                            </div>
                          )}
                          <button className="btn btn-sm btn-outline" style={{ marginTop: 8 }} onClick={() => onViewBooking(b.booking_id)}>View Booking</button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab === 'ratings' && (
                <>
                  <SectionHeading>Driver Ratings Received ({ratingsReceived.length})</SectionHeading>
                  {ratingsReceived.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No ratings received yet.</p>
                  ) : ratingsReceived.map(r => (
                    <div key={r.rating_id} className="card" style={{ padding: 12, border: '1px solid var(--border)', marginBottom: 8 }}>
                      <div className="flex-between" style={{ gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Avatar picture={r.counterparty_picture} name={r.counterparty_name} size={28} />
                          <strong style={{ fontSize: 13 }}>{r.counterparty_name || 'Driver'}</strong>
                        </div>
                        <Stars rating={r.rating} />
                      </div>
                      {r.comment && <p style={{ fontSize: 12.5, marginTop: 6 }}>{r.comment}</p>}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{formatDate(r.created_at)}{r.flagged_for_review && ' · Flagged for review'}{r.removed_at && ' · Removed by admin'}</div>
                    </div>
                  ))}

                  <SectionHeading>Ratings Submitted by Passenger ({ratingsGiven.length})</SectionHeading>
                  {ratingsGiven.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No ratings submitted yet.</p>
                  ) : ratingsGiven.map(r => (
                    <div key={r.rating_id} className="card" style={{ padding: 12, border: '1px solid var(--border)', marginBottom: 8 }}>
                      <div className="flex-between" style={{ gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Avatar picture={r.counterparty_picture} name={r.counterparty_name} size={28} />
                          <strong style={{ fontSize: 13 }}>Rated {r.counterparty_name || 'driver'}</strong>
                        </div>
                        <Stars rating={r.rating} />
                      </div>
                      {r.comment && <p style={{ fontSize: 12.5, marginTop: 6 }}>{r.comment}</p>}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{formatDate(r.created_at)}</div>
                    </div>
                  ))}
                </>
              )}

              {tab === 'reports' && (
                <>
                  <SectionHeading>Reports Submitted by This Passenger ({reportsSubmitted.length})</SectionHeading>
                  {reportsSubmitted.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>None.</p>
                  ) : reportsSubmitted.map(r => <ReportRow key={r.report_id} r={r} counterpartLabel="About" />)}

                  <SectionHeading>Reports Concerning This Passenger ({reportsAbout.length})</SectionHeading>
                  {reportsAbout.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>None.</p>
                  ) : reportsAbout.map(r => <ReportRow key={r.report_id} r={r} counterpartLabel="Reported by" />)}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportRow({ r, counterpartLabel }) {
  return (
    <div className="card" style={{ padding: 12, border: '1px solid var(--border)', marginBottom: 8 }}>
      <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, textTransform: 'capitalize' }}>{(r.category || '').replace(/_/g, ' ')}</strong>
        <span className={`badge ${REPORT_STATUS_BADGE[r.status] || 'badge-gray'}`}>{r.status.replace(/_/g, ' ')}</span>
      </div>
      <p style={{ fontSize: 12.5, marginTop: 6 }}>{r.description}</p>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
        {counterpartLabel}: {r.counterparty_name || '—'} · {formatDate(r.created_at)}
      </div>
      {r.resolution_notes && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
          Resolution: {r.resolution_notes} {r.resolved_at && `(${formatDate(r.resolved_at)})`}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 13.5, marginTop: 2, fontFamily: mono ? 'monospace' : undefined, wordBreak: mono ? 'break-all' : undefined }}>{value ?? '—'}</div>
    </div>
  );
}
