import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import ReportPreviewModal from '../../components/driver/ReportPreviewModal';
import CancelBookingModal from '../../components/driver/CancelBookingModal';
import ReportModal from '../../components/shared/ReportModal';
import { buildDriverBookingReportPdf } from '../../lib/reports/driverBookingReport';
import { fetchSupportContacts } from '../../lib/support/supportContacts';

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'no_show', label: 'No-shows' },
];

const BOOKING_STATUS_BADGE = {
  pending: 'badge-amber',
  confirmed: 'badge-teal',
  completed: 'badge-green',
  cancelled: 'badge-danger',
  no_show: 'badge-danger',
};

const BOOKING_STATUS_LABEL = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

const TRIP_STATUS_BADGE = {
  scheduled: 'badge-teal',
  ongoing: 'badge-amber',
  completion_pending: 'badge-amber',
  completed: 'badge-green',
  cancelled: 'badge-danger',
  expired: 'badge-gray',
};

const TRIP_STATUS_LABEL = {
  scheduled: 'Scheduled',
  ongoing: 'Ongoing',
  completion_pending: 'Awaiting confirmation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function Bookings() {
  const { user, profile } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tripFilter = searchParams.get('trip');

  const [bookings, setBookings] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [statusTab, setStatusTab] = useState('all');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [reportError, setReportError] = useState('');
  const [generatingReport, setGeneratingReport] = useState(false);
  const [preview, setPreview] = useState(null); // { url, filename } for the currently-open preview modal
  const previewRef = useRef(null);
  previewRef.current = preview;

  // ── Driver cancels an individual passenger's booking ───────────────────
  // cancelTarget is the booking row (from get_driver_trip_bookings) the
  // confirmation dialog is currently open for; null when the dialog is
  // closed. The dialog itself only gates the UI — the real, unbypassable
  // enforcement (mandatory reason, driver must own the trip, a completed
  // trip's bookings can no longer be cancelled) lives in the cancel_booking
  // database function (see
  // src/database/driver_passenger_booking_cancellation.sql).
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelModalError, setCancelModalError] = useState('');

  // ── Driver reports a problem with a passenger/booking ──────────────────
  // reportTarget is the booking row (from get_driver_trip_bookings) the
  // complaint form is open for; null when closed. Inserts into the same
  // `reports` table passenger/MyBookings.jsx already uses — see
  // components/shared/ReportModal.jsx and
  // database/trip_complaints_admin_alerts_cancellation_history.sql for the
  // authorization rules and the admin-notification trigger this fires.
  const [reportTarget, setReportTarget] = useState(null);
  const [reportSuccess, setReportSuccess] = useState('');

  // Revoke whatever blob URL is open when the page itself unmounts (e.g.
  // navigating away with the preview still open) so it isn't left dangling.
  useEffect(() => () => { if (previewRef.current?.url) URL.revokeObjectURL(previewRef.current.url); }, []);

  // ── load this driver's bookings, with real passenger identity ─────────
  // Uses the get_driver_trip_bookings() RPC (see
  // src/database/driver_booking_passenger_visibility.sql) instead of a
  // raw `.select('*, profiles:passenger_id(...))` embed. The embed looked
  // fine and never errored, but public.profiles only allows a user to
  // read their OWN row, so the embedded passenger profile silently came
  // back null for every booking -- which is exactly why every card here
  // was rendering "Unknown" / "Passenger" regardless of who actually
  // booked. The RPC re-checks driver ownership itself and returns only
  // the passenger's name/phone, nothing else.
  async function load() {
    setLoading(true);
    setError('');
    const { data, error: err } = await supabase.rpc('get_driver_trip_bookings', {
      p_trip_id: tripFilter || null,
    });
    if (err) {
      setError(err.message || 'Could not load bookings. Please try again.');
      setBookings([]);
    } else {
      setBookings(data || []);
    }
    setLoading(false);
  }

  useEffect(() => { if (user) load(); }, [user, tripFilter]);

  async function markNoShow(bookingId) {
    if (!confirm('Mark this passenger as a no-show? This cannot be undone.')) return;
    setBusyId(bookingId); setError('');
    const { error: err } = await supabase.rpc('mark_no_show', { p_booking_id: bookingId });
    setBusyId(null);
    if (err) setError(err.message); else load();
  }

  function openCancelModal(booking) {
    setCancelModalError('');
    setCancelTarget(booking);
  }

  async function confirmCancelBooking({ category, details }) {
    if (!cancelTarget) return;
    setCancelBusy(true);
    setCancelModalError('');
    // p_reason_category is the mandatory fixed reason; p_reason only carries
    // free text, and only matters when category is 'other' — cancel_booking
    // validates both server-side regardless of what the UI already checked.
    const { error: err } = await supabase.rpc('cancel_booking', {
      p_booking_id: cancelTarget.id,
      p_reason_category: category,
      p_reason: details,
    });
    setCancelBusy(false);
    if (err) {
      setCancelModalError(err.message);
    } else {
      setCancelTarget(null);
      load();
    }
  }

  const inTab = statusTab === 'all' ? bookings : bookings.filter(b => b.status === statusTab);
  const q = search.trim().toLowerCase();
  const filtered = inTab.filter(b => {
    if (!q) return true;
    const haystack = [b.booking_reference, b.passenger_name, b.origin, b.destination]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
  const counts = STATUS_TABS.reduce((acc, t) => {
    acc[t.key] = t.key === 'all' ? bookings.length : bookings.filter(b => b.status === t.key).length;
    return acc;
  }, {});

  // ── Download Report ────────────────────────────────────────────────
  // Builds a PDF straight from what's currently on screen (`filtered` --
  // respects the active status tab and any ?trip= filter), so the report
  // always matches what the driver is looking at. All of it comes from
  // get_driver_trip_bookings(), which only ever returns this driver's own
  // bookings (see driver_booking_passenger_visibility.sql /
  // driver_booking_report_fields.sql) -- there is no separate query here
  // that could pull in another driver's data, and no price/payment field
  // is passed into the PDF builder at all.
  //
  // Generating a PDF no longer downloads it immediately -- it opens a
  // preview (see ReportPreviewModal) so the driver can check it looks
  // right first; the actual save-to-disk only happens if they click
  // "Download PDF" inside that preview.
  async function handleGenerateReport() {
    if (filtered.length === 0) return;
    setGeneratingReport(true);
    setReportError('');
    try {
      const activeTabLabel = STATUS_TABS.find(t => t.key === statusTab)?.label || 'All';
      const filterLabel = tripFilter
        ? `This trip only${statusTab !== 'all' ? ` — ${activeTabLabel}` : ''}`
        : `${activeTabLabel} bookings`;

      // fetchSupportContacts() never throws and falls back to an all-blank
      // row on error (see lib/support/supportContacts.js), so a support-
      // contacts fetch failure never blocks report generation — the
      // footer just falls back to the generic "visit the Support page"
      // message instead of showing a channel.
      const { contacts: supportContacts } = await fetchSupportContacts();

      const bytes = await buildDriverBookingReportPdf({
        driverName: profile?.full_name || 'Driver',
        driverPhone: profile?.phone || '',
        filterLabel,
        bookings: filtered,
        supportContacts,
      });

      const datePart = new Date().toISOString().slice(0, 10);
      const scopePart = tripFilter ? 'trip' : statusTab;
      const filename = `pamojaride-bookings-report-${scopePart}-${datePart}.pdf`;

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      // Only one preview is ever open at a time -- release the previous
      // blob URL before swapping in the new one so we don't leak memory
      // across repeated "Download Report" clicks in the same visit.
      if (preview?.url) URL.revokeObjectURL(preview.url);
      setPreview({ url, filename });
    } catch (err) {
      console.error('Report generation failed:', err);
      setReportError('Could not generate the report. Please try again.');
    } finally {
      setGeneratingReport(false);
    }
  }

  function handleDownloadFromPreview() {
    if (!preview) return;
    const a = document.createElement('a');
    a.href = preview.url;
    a.download = preview.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function closePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  return (
    <DashboardLayout title="Bookings">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Bookings</h1>
          <p>{tripFilter ? 'Bookings for this trip.' : 'All bookings across your trips.'}</p>
          {tripFilter && <Link to="/driver/bookings" className="btn btn-sm btn-ghost" style={{ marginTop: 8 }}>Clear trip filter</Link>}
        </div>
        <button className="btn btn-sm btn-outline" onClick={handleGenerateReport} disabled={loading || generatingReport || filtered.length === 0}>
          {generatingReport ? <span className="spinner" /> : '⬇ Download Report'}
        </button>
      </div>

      {reportError && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{reportError}</div>}
      {reportSuccess && <div className="alert alert-success" style={{ marginBottom: 16 }}>{reportSuccess}</div>}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error} <button className="btn btn-sm btn-ghost" onClick={load} style={{ marginLeft: 8 }}>Retry</button></div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {STATUS_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setStatusTab(t.key)}
            className={`btn btn-sm ${statusTab === t.key ? 'btn-primary' : 'btn-outline'}`}
          >
            {t.label}{typeof counts[t.key] === 'number' ? ` (${counts[t.key]})` : ''}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 20, maxWidth: 360 }}>
        <input
          type="text"
          className="form-input"
          placeholder="Search by reference, passenger, origin or destination"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎫</div>
          {inTab.length === 0 ? (
            <>
              <h3>No bookings here</h3>
              <p>Once passengers book your trips, they'll show up here.</p>
            </>
          ) : (
            <>
              <h3>No matches</h3>
              <p>No bookings match "{search}" in this tab.</p>
              <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={() => setSearch('')}>
                Clear search
              </button>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filtered.map(b => (
            <div
              className="card card-pad"
              key={b.id}
              onClick={() => navigate(`/driver/bookings/${b.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') navigate(`/driver/bookings/${b.id}`); }}
              style={{ cursor: 'pointer' }}
            >
              <div className="flex-between" style={{ marginBottom: 12, alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <strong style={{ fontSize: 15 }}>{b.passenger_name || 'Unknown passenger'}</strong>
                  <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{b.passenger_phone || 'No phone on file'}</p>
                  <p style={{ margin: '2px 0 0', fontSize: 13, fontWeight: 600 }}>{b.origin} → {b.destination}</p>
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{formatDateTime(b.departure_time)}</p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className={`badge ${BOOKING_STATUS_BADGE[b.status] || 'badge-gray'}`}>
                    {BOOKING_STATUS_LABEL[b.status] || b.status}
                  </span>
                  <span className={`badge ${TRIP_STATUS_BADGE[b.trip_status] || 'badge-gray'}`}>
                    Trip: {TRIP_STATUS_LABEL[b.trip_status] || b.trip_status}
                  </span>
                </div>
              </div>

              <div className="grid-3" style={{ gap: 8, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Reference</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{b.booking_reference}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Seats</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{b.seats_booked}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Total</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{formatKES(b.total_price)}</div>
                </div>
              </div>

              {b.status === 'cancelled' && (
                <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                  Cancelled{b.cancelled_at ? ` on ${formatDateTime(b.cancelled_at)}` : ''}{b.cancellation_reason ? ` — ${b.cancellation_reason}` : ''}
                </p>
              )}
              {b.status === 'cancelled' && b.refund_status === 'pending' && (
                <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                  💰 Refund pending review
                </p>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                {b.status === 'confirmed' && b.departure_time && new Date(b.departure_time) <= new Date() && (
                  <button className="btn btn-sm btn-outline" disabled={busyId === b.id} onClick={() => markNoShow(b.id)}>
                    {busyId === b.id ? <span className="spinner" /> : 'Mark no-show'}
                  </button>
                )}
                {['pending', 'confirmed'].includes(b.status) && !['completed', 'cancelled'].includes(b.trip_status) && (
                  <button className="btn btn-sm btn-danger" onClick={() => openCancelModal(b)}>
                    Cancel booking
                  </button>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => { setReportSuccess(''); setReportTarget(b); }}>
                  🚩 Report
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <ReportPreviewModal
          previewUrl={preview.url}
          onDownload={handleDownloadFromPreview}
          onClose={closePreview}
        />
      )}

      {cancelTarget && (
        <CancelBookingModal
          booking={cancelTarget}
          busy={cancelBusy}
          error={cancelModalError}
          onConfirm={confirmCancelBooking}
          onClose={() => { if (!cancelBusy) setCancelTarget(null); }}
        />
      )}

      {reportTarget && (
        <ReportModal
          reporterId={user.id}
          tripId={reportTarget.trip_id}
          bookingId={reportTarget.id}
          reportedUserId={reportTarget.passenger_id}
          reportedRole="passenger"
          onClose={() => setReportTarget(null)}
          onSuccess={() => { setReportTarget(null); setReportSuccess('Report submitted. Our team will review it shortly.'); }}
        />
      )}
    </DashboardLayout>
  );
}
