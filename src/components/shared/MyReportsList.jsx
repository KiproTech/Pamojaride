import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import { fetchMyReports } from '../../lib/reports/myReports';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, formatReportDate } from '../../lib/reports/reportLabels';

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

function counterpartLabel(report) {
  if (report.is_account_appeal) return 'Account appeal';
  if (!report.reported_user_id) return null;
  const roleLabel = report.my_role === 'driver' ? 'Passenger' : report.my_role === 'passenger' ? 'Driver' : 'Other party';
  return `${roleLabel}: ${report.reported_name || 'Unavailable'}`;
}

function previewText(description) {
  if (!description) return '';
  const clean = description.replace(/^\[Account appeal[^\]]*\]\s*/, '');
  return clean.length > 140 ? `${clean.slice(0, 140).trim()}…` : clean;
}

// Shared My Reports list, used by both portals:
//   - pages/passenger/MyReports.jsx (portal="passenger")
//   - pages/driver/MyReports.jsx    (portal="driver")
//
// Only ever shows reports the SIGNED-IN user submitted — enforced by
// get_my_reports() (database/my_reports_tracking.sql), which scopes to
// reporter_id = auth.uid() server-side regardless of anything the client
// sends. This is the same `reports` table used everywhere else in the app;
// nothing here is a second reports system.
export default function MyReportsList({ portal }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { reports: data, error: err } = await fetchMyReports();
    if (err) setError("We couldn't load your reports right now. Please try again.");
    else setReports(data);
    setLoading(false);
  }, []);

  useEffect(() => { if (user) load(); }, [user, load]);

  // Live updates: when an admin changes a report's status, reflect it here
  // without requiring a manual refresh. This is a convenience layer only —
  // the database (via load() above) is always the source of truth, and
  // the page works perfectly well without Realtime (e.g. reopening My
  // Reports, or refreshing, always shows the current state anyway).
  // Mirrors the subscription pattern already established in
  // AuthContext.jsx (session-guard-*, account-status-*): one channel per
  // mount, unique name per user+portal, always unsubscribed on cleanup.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`my-reports-${portal}-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'reports', filter: `reporter_id=eq.${user.id}` },
        () => { load(); }
      )
      .subscribe();

    return () => { channel.unsubscribe(); };
  }, [user, portal, load]);

  const visible = filter === 'all' ? reports : reports.filter(r => r.status === filter);

  return (
    <div>
      <div className="page-header">
        <h1>My Reports</h1>
        <p>Track the status of reports you've submitted, from open through resolution.</p>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {FILTER_TABS.map(t => (
          <button
            key={t.value}
            className={`btn btn-sm ${filter === t.value ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFilter(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" /><div className="skeleton-row" />
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🚩</div>
          <h3>{reports.length === 0 ? 'No reports submitted yet' : 'No reports match this filter'}</h3>
          <p>
            {reports.length === 0
              ? "If something goes wrong on a trip, you can report it from your bookings."
              : 'Try a different status filter.'}
          </p>
          {reports.length === 0 && (
            <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate(`/${portal}/bookings`)}>
              Go to {portal === 'driver' ? 'Bookings' : 'My Bookings'}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {visible.map(r => {
            const person = counterpartLabel(r);
            return (
              <div
                key={r.id}
                className="card card-pad"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/${portal}/reports/${r.id}`)}
                onKeyDown={e => { if (e.key === 'Enter') navigate(`/${portal}/reports/${r.id}`); }}
                style={{ cursor: 'pointer' }}
              >
                <div className="flex-between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className={`badge ${STATUS_BADGE[r.status] || 'badge-gray'}`}>{STATUS_LABELS[r.status] || r.status}</span>
                    <span className="badge badge-gray">{r.is_account_appeal ? 'Account appeal' : (CATEGORY_LABELS[r.category] || r.category)}</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {r.report_reference} · Submitted {formatReportDate(r.created_at)}
                  </span>
                </div>

                {r.trip_id && (
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                    Trip: {r.origin} → {r.destination}{r.departure_time ? ` · ${formatReportDate(r.departure_time)}` : ''}
                  </p>
                )}

                {person && (
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>{person}</p>
                )}

                <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', margin: '8px 0 4px' }}>
                  {previewText(r.description)}
                </p>

                <div className="flex-between" style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    Last updated {formatReportDate(r.updated_at)}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--primary-dark, #1D4ED8)', fontWeight: 600 }}>View details →</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
