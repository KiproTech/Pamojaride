import { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardLayout from '../../components/shared/DashboardLayout';
import { useAuth } from '../../context/AuthContext';
import { fetchSupportContacts } from '../../lib/support/supportContacts';
import {
  DATE_RANGE_PRESETS, resolveDateRange, describeDateRange,
  fetchPlatformOverview, fetchTripPerformance, fetchBookingPerformance,
  fetchDriverPerformance, fetchTripPerformanceReport, fetchBookingReport,
  fetchDailyActivity,
} from '../../lib/reports/adminAnalytics';
import { downloadCsv } from '../../lib/reports/csvExport';
import {
  buildPlatformSummaryReportPdf, buildDriverPerformanceReportPdf,
  buildTripPerformanceReportPdf, buildBookingReportPdf,
} from '../../lib/reports/adminPerformanceReports';

// ============================================================================
// Admin → Analytics — real, database-backed platform performance reporting.
//
// Deliberately NOT placed at /admin/reports or labeled "Reports": that
// route/name already belongs to the complaints & appeals queue
// (admin/Reports.jsx, database/admin_reports_management.sql). This is a
// separate section at /admin/analytics, labeled "Analytics & Performance"
// in the sidebar, so nothing about the existing Reports & Appeals feature
// changes.
//
// Every number on this page comes from the read-only, admin-only RPCs in
// database/admin_performance_analytics.sql — nothing here is computed
// client-side from a full-table fetch, and nothing is invented. See that
// file's header comment for the security model (SECURITY DEFINER +
// re-checked public.is_admin(auth.uid()) inside every function).
// ============================================================================

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'trips', label: 'Trips' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'performance', label: 'Performance' },
];

function fmtNumber(v) { return v === null || v === undefined ? '—' : String(v); }
function fmtPercent(v) { return v === null || v === undefined ? 'Not enough data' : `${v}%`; }
function fmtKES(v) {
  if (v === null || v === undefined) return '—';
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(v);
}
function fmtDateTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

const VERIFICATION_BADGE = {
  verified: 'badge-green', pending_verification: 'badge-amber', under_review: 'badge-teal', rejected: 'badge-danger',
};
const VERIFICATION_LABEL = {
  verified: 'Verified', pending_verification: 'Pending', under_review: 'Under review', rejected: 'Rejected',
};
const TRIP_STATUS_BADGE = {
  scheduled: 'badge-teal', ongoing: 'badge-teal', completed: 'badge-green', cancelled: 'badge-danger', expired: 'badge-gray',
};
const BOOKING_STATUS_BADGE = {
  pending: 'badge-amber', confirmed: 'badge-teal', completed: 'badge-green', cancelled: 'badge-danger', no_show: 'badge-danger',
};

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Minimal, dependency-free grouped bar chart (trips vs bookings per day). */
function ActivityChart({ days }) {
  if (!days || days.length === 0) return null;
  const width = 760;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 24, left: 34 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const maxVal = Math.max(1, ...days.map(d => Math.max(d.trips_created, d.bookings_created)));
  const n = days.length;
  const groupW = chartW / n;
  const barW = Math.max(2, Math.min(14, groupW * 0.32));

  // Thin out x-axis labels so they don't overlap on wide ranges.
  const labelEvery = Math.max(1, Math.ceil(n / 10));

  return (
    <div className="card card-pad" style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--primary)', display: 'inline-block' }} /> Trips created
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)', display: 'inline-block' }} /> Bookings created
        </div>
      </div>
      <svg width={width} height={height} role="img" aria-label="Daily trips and bookings created">
        {[0, 0.5, 1].map(f => (
          <line key={f} x1={padding.left} x2={width - padding.right}
            y1={padding.top + chartH * (1 - f)} y2={padding.top + chartH * (1 - f)}
            stroke="var(--border)" strokeWidth={1} />
        ))}
        {[0, 0.5, 1].map(f => (
          <text key={f} x={padding.left - 6} y={padding.top + chartH * (1 - f) + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">
            {Math.round(maxVal * f)}
          </text>
        ))}
        {days.map((d, i) => {
          const gx = padding.left + i * groupW;
          const tripsH = (d.trips_created / maxVal) * chartH;
          const bookingsH = (d.bookings_created / maxVal) * chartH;
          return (
            <g key={d.activity_date}>
              <rect x={gx + groupW / 2 - barW - 1} y={padding.top + chartH - tripsH} width={barW} height={tripsH} fill="var(--primary)" rx={1}>
                <title>{`${d.activity_date}: ${d.trips_created} trips created`}</title>
              </rect>
              <rect x={gx + groupW / 2 + 1} y={padding.top + chartH - bookingsH} width={barW} height={bookingsH} fill="var(--accent)" rx={1}>
                <title>{`${d.activity_date}: ${d.bookings_created} bookings created`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={gx + groupW / 2} y={height - 6} textAnchor="middle" fontSize={8.5} fill="var(--text-muted)">
                  {new Date(d.activity_date).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function Analytics() {
  const { profile } = useAuth();
  const [tab, setTab] = useState('overview');
  const [rangeKey, setRangeKey] = useState('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [overview, setOverview] = useState(null);
  const [tripPerf, setTripPerf] = useState(null);
  const [bookingPerf, setBookingPerf] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [trips, setTrips] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [dailyActivity, setDailyActivity] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');

  const range = useMemo(
    () => resolveDateRange(rangeKey, { from: customFrom, to: customTo }),
    [rangeKey, customFrom, customTo]
  );
  const periodLabel = useMemo(
    () => describeDateRange(rangeKey, { from: customFrom, to: customTo }),
    [rangeKey, customFrom, customTo]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [ov, tp, bp, dr, tr, bk, da] = await Promise.all([
      fetchPlatformOverview(),
      fetchTripPerformance(range),
      fetchBookingPerformance(range),
      fetchDriverPerformance(range),
      fetchTripPerformanceReport(range),
      fetchBookingReport(range),
      fetchDailyActivity(range),
    ]);
    const firstError = [ov, tp, bp, dr, tr, bk, da].find(r => r.error)?.error;
    if (firstError) {
      setError(firstError.message || 'Some analytics failed to load. You may not have admin access, or the connection dropped.');
    }
    setOverview(ov.overview);
    setTripPerf(tp.performance);
    setBookingPerf(bp.performance);
    setDrivers(dr.drivers);
    setTrips(tr.trips);
    setBookings(bk.bookings);
    setDailyActivity(da.days);
    setLoading(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  async function withSupportContacts() {
    const { contacts } = await fetchSupportContacts();
    return contacts;
  }

  async function handleDownloadPlatformSummaryPdf() {
    setExporting('platform-pdf');
    try {
      const supportContacts = await withSupportContacts();
      const bytes = await buildPlatformSummaryReportPdf({
        overview, tripPerformance: tripPerf, bookingPerformance: bookingPerf,
        driverCount: drivers.length, periodLabel, adminName: profile?.full_name, supportContacts,
      });
      downloadPdfBytes(bytes, `pamojaride-platform-summary-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      console.error('Platform summary PDF failed:', err);
      setError('Could not generate the Platform Summary PDF. Please try again.');
    } finally {
      setExporting('');
    }
  }

  async function handleDownloadDriverPdf() {
    setExporting('driver-pdf');
    try {
      const supportContacts = await withSupportContacts();
      const bytes = await buildDriverPerformanceReportPdf({ drivers, periodLabel, adminName: profile?.full_name, supportContacts });
      downloadPdfBytes(bytes, `pamojaride-driver-performance-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      console.error('Driver performance PDF failed:', err);
      setError('Could not generate the Driver Performance PDF. Please try again.');
    } finally {
      setExporting('');
    }
  }

  async function handleDownloadTripPdf() {
    setExporting('trip-pdf');
    try {
      const supportContacts = await withSupportContacts();
      const bytes = await buildTripPerformanceReportPdf({ trips, periodLabel, adminName: profile?.full_name, supportContacts });
      downloadPdfBytes(bytes, `pamojaride-trip-performance-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      console.error('Trip performance PDF failed:', err);
      setError('Could not generate the Trip Performance PDF. Please try again.');
    } finally {
      setExporting('');
    }
  }

  async function handleDownloadBookingPdf() {
    setExporting('booking-pdf');
    try {
      const supportContacts = await withSupportContacts();
      const bytes = await buildBookingReportPdf({ bookings, periodLabel, adminName: profile?.full_name, supportContacts });
      downloadPdfBytes(bytes, `pamojaride-booking-report-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      console.error('Booking report PDF failed:', err);
      setError('Could not generate the Booking Report PDF. Please try again.');
    } finally {
      setExporting('');
    }
  }

  function handleDownloadDriverCsv() {
    downloadCsv([
      { label: 'Driver', key: 'driver_name' },
      { label: 'Verification', key: 'verification_status', format: r => VERIFICATION_LABEL[r.verification_status] || r.verification_status },
      { label: 'Account status', key: 'account_status' },
      { label: 'Trips created', key: 'trips_created' },
      { label: 'Trips completed', key: 'trips_completed' },
      { label: 'Trips cancelled', key: 'trips_cancelled' },
      { label: 'Bookings received', key: 'bookings_received' },
      { label: 'Bookings completed', key: 'bookings_completed' },
      { label: 'Avg rating', key: 'avg_rating' },
      { label: 'Rating count', key: 'rating_count' },
    ], drivers, `pamojaride-driver-performance-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function handleDownloadTripCsv() {
    downloadCsv([
      { label: 'Driver', key: 'driver_name' },
      { label: 'Origin', key: 'origin' },
      { label: 'Destination', key: 'destination' },
      { label: 'Departure', key: 'departure_time', format: r => fmtDateTime(r.departure_time) },
      { label: 'Status', key: 'status' },
      { label: 'Total seats', key: 'total_seats' },
      { label: 'Available seats', key: 'available_seats' },
      { label: 'Bookings', key: 'bookings_count' },
      { label: 'Completed bookings', key: 'completed_bookings_count' },
      { label: 'Cancelled bookings', key: 'cancelled_bookings_count' },
      { label: 'Created', key: 'created_at', format: r => fmtDateTime(r.created_at) },
    ], trips, `pamojaride-trip-performance-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function handleDownloadBookingCsv() {
    downloadCsv([
      { label: 'Reference', key: 'booking_reference' },
      { label: 'Origin', key: 'origin' },
      { label: 'Destination', key: 'destination' },
      { label: 'Driver', key: 'driver_name' },
      { label: 'Passenger', key: 'passenger_name' },
      { label: 'Status', key: 'status' },
      { label: 'Seats booked', key: 'seats_booked' },
      { label: 'Total price (KES)', key: 'total_price' },
      { label: 'Refund status', key: 'refund_status' },
      { label: 'Booked at', key: 'created_at', format: r => fmtDateTime(r.created_at) },
    ], bookings, `pamojaride-booking-report-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <DashboardLayout title="Analytics">
      <div className="page-header">
        <h1>Analytics &amp; Performance</h1>
        <p>Real, database-backed platform performance — never estimated or invented.</p>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      )}

      {/* ── date range controls ─────────────────────────────────────────── */}
      <div className="card card-pad" style={{ marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: '1 1 220px', marginBottom: 0 }}>
          <label className="form-label" style={{ fontSize: 11.5 }}>Report period</label>
          <select className="form-select" value={rangeKey} onChange={e => setRangeKey(e.target.value)}>
            {DATE_RANGE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        {rangeKey === 'custom' && (
          <>
            <div className="form-group" style={{ flex: '1 1 160px', marginBottom: 0 }}>
              <label className="form-label" style={{ fontSize: 11.5 }}>From date</label>
              <input type="date" className="form-input" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            </div>
            <div className="form-group" style={{ flex: '1 1 160px', marginBottom: 0 }}>
              <label className="form-label" style={{ fontSize: 11.5 }}>To date</label>
              <input type="date" className="form-input" value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </div>
          </>
        )}
        <button
          className="btn btn-sm btn-primary"
          disabled={exporting === 'platform-pdf' || loading}
          onClick={handleDownloadPlatformSummaryPdf}
          style={{ marginLeft: 'auto' }}
        >
          {exporting === 'platform-pdf' ? 'Generating…' : '⬇ Download Platform Summary PDF'}
        </button>
      </div>

      {/* ── tabs ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`btn btn-sm ${tab === t.key ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
        </div>
      ) : (
        <>
          {tab === 'overview' && (
            <>
              <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 10 }}>
                Platform totals (all-time)
              </h3>
              <div className="grid-4" style={{ marginBottom: 24 }}>
                <StatCard label="Total users" value={fmtNumber(overview?.total_users)} />
                <StatCard label="Passengers" value={fmtNumber(overview?.total_passengers)} />
                <StatCard label="Drivers" value={fmtNumber(overview?.total_drivers)} />
                <StatCard label="Verified drivers" value={fmtNumber(overview?.verified_drivers)} />
              </div>
              <div className="grid-4" style={{ marginBottom: 24 }}>
                <StatCard label="Pending verifications" value={fmtNumber(overview?.pending_driver_verifications)} />
                <StatCard label="Suspended accounts" value={fmtNumber(overview?.suspended_accounts)} />
                <StatCard label="Banned accounts" value={fmtNumber(overview?.banned_accounts)} />
                <StatCard label="Total bookings (all-time)" value={fmtNumber(overview?.total_bookings)} />
              </div>
              <div className="grid-4" style={{ marginBottom: 24 }}>
                <StatCard label="Total trips (all-time)" value={fmtNumber(overview?.total_trips)} />
                <StatCard label="Active trips (now)" value={fmtNumber(overview?.active_trips)} />
                <StatCard label="Completed trips (now)" value={fmtNumber(overview?.completed_trips)} />
                <StatCard label="Cancelled trips (now)" value={fmtNumber(overview?.cancelled_trips)} />
              </div>

              <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 10 }}>
                {periodLabel}
              </h3>
              <div className="grid-4">
                <StatCard label="Trips created" value={fmtNumber(tripPerf?.trips_created)} />
                <StatCard label="Trip completion rate" value={fmtPercent(tripPerf?.completion_rate)} />
                <StatCard label="Bookings created" value={fmtNumber(bookingPerf?.total_bookings)} />
                <StatCard label="Booking completion rate" value={fmtPercent(bookingPerf?.completion_rate)} />
              </div>
            </>
          )}

          {tab === 'drivers' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                <button className="btn btn-sm btn-outline" onClick={handleDownloadDriverCsv} disabled={drivers.length === 0}>⬇ CSV</button>
                <button className="btn btn-sm btn-outline" disabled={exporting === 'driver-pdf'} onClick={handleDownloadDriverPdf}>
                  {exporting === 'driver-pdf' ? 'Generating…' : '⬇ PDF'}
                </button>
              </div>
              {drivers.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🪪</div>
                  <h3>No driver activity</h3>
                  <p>No driver created a trip in {periodLabel.toLowerCase()}. Try a wider date range.</p>
                </div>
              ) : (
                <div className="card" style={{ overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                        {['Driver', 'Verification', 'Trips', 'Completed', 'Cancelled', 'Bookings', 'Bookings completed', 'Rating'].map(h => (
                          <th key={h} style={{ padding: '12px 16px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {drivers.map(d => (
                        <tr key={d.driver_id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.driver_name}</td>
                          <td style={{ padding: '12px 16px' }}><span className={`badge ${VERIFICATION_BADGE[d.verification_status] || 'badge-gray'}`}>{VERIFICATION_LABEL[d.verification_status] || d.verification_status}</span></td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.trips_created}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.trips_completed}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.trips_cancelled}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.bookings_received}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.bookings_completed}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{d.rating_count > 0 ? `${d.avg_rating} ★ (${d.rating_count})` : 'No ratings yet'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'trips' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                <button className="btn btn-sm btn-outline" onClick={handleDownloadTripCsv} disabled={trips.length === 0}>⬇ CSV</button>
                <button className="btn btn-sm btn-outline" disabled={exporting === 'trip-pdf'} onClick={handleDownloadTripPdf}>
                  {exporting === 'trip-pdf' ? 'Generating…' : '⬇ PDF'}
                </button>
              </div>
              {trips.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🗺️</div>
                  <h3>No trips</h3>
                  <p>No trip was created in {periodLabel.toLowerCase()}. Try a wider date range.</p>
                </div>
              ) : (
                <div className="card" style={{ overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                        {['Driver', 'Route', 'Departure', 'Status', 'Bookings', 'Completed', 'Cancelled', 'Created'].map(h => (
                          <th key={h} style={{ padding: '12px 16px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trips.map(t => (
                        <tr key={t.trip_id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{t.driver_name}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{t.origin} → {t.destination}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmtDateTime(t.departure_time)}</td>
                          <td style={{ padding: '12px 16px' }}><span className={`badge ${TRIP_STATUS_BADGE[t.status] || 'badge-gray'}`}>{t.status}</span></td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{t.bookings_count}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{t.completed_bookings_count}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{t.cancelled_bookings_count}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmtDate(t.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'bookings' && (
            <>
              <div className="grid-4" style={{ marginBottom: 16 }}>
                <StatCard label="Total bookings" value={fmtNumber(bookingPerf?.total_bookings)} />
                <StatCard label="Completed" value={fmtNumber(bookingPerf?.completed_bookings)} />
                <StatCard label="Cancelled" value={fmtNumber(bookingPerf?.cancelled_bookings)} />
                <StatCard label="Repeat booking rate" value={fmtPercent(bookingPerf?.repeat_booking_rate)} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                <button className="btn btn-sm btn-outline" onClick={handleDownloadBookingCsv} disabled={bookings.length === 0}>⬇ CSV</button>
                <button className="btn btn-sm btn-outline" disabled={exporting === 'booking-pdf'} onClick={handleDownloadBookingPdf}>
                  {exporting === 'booking-pdf' ? 'Generating…' : '⬇ PDF'}
                </button>
              </div>
              {bookings.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🎟️</div>
                  <h3>No bookings</h3>
                  <p>No booking was made in {periodLabel.toLowerCase()}. Try a wider date range.</p>
                </div>
              ) : (
                <div className="card" style={{ overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                        {['Reference', 'Route', 'Driver', 'Passenger', 'Status', 'Seats', 'Fare', 'Booked'].map(h => (
                          <th key={h} style={{ padding: '12px 16px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bookings.map(b => (
                        <tr key={b.booking_id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{b.booking_reference}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{b.origin} → {b.destination}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{b.driver_name}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{b.passenger_name}</td>
                          <td style={{ padding: '12px 16px' }}><span className={`badge ${BOOKING_STATUS_BADGE[b.status] || 'badge-gray'}`}>{b.status}</span></td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5 }}>{b.seats_booked}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmtKES(b.total_price)}</td>
                          <td style={{ padding: '12px 16px', fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmtDateTime(b.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'performance' && (
            <>
              <div className="grid-4" style={{ marginBottom: 20 }}>
                <StatCard label="Trip completion rate" value={fmtPercent(tripPerf?.completion_rate)} sub={`${fmtNumber(tripPerf?.trips_completed)} of ${fmtNumber(tripPerf?.trips_created)} trips`} />
                <StatCard label="Booking rate" value={fmtPercent(tripPerf?.booking_rate)} sub="Trips that received ≥1 booking" />
                <StatCard label="Avg bookings / trip" value={tripPerf?.avg_bookings_per_trip ?? 'Not enough data'} />
                <StatCard label="Booking completion rate" value={fmtPercent(bookingPerf?.completion_rate)} />
              </div>
              <ActivityChart days={dailyActivity} />
            </>
          )}
        </>
      )}
    </DashboardLayout>
  );
}
