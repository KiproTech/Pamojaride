import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/shared/DashboardLayout';
import { fetchAdminReports, fetchAdminReportCounts } from '../../lib/reports/adminReports';
import {
  STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, ROLE_LABELS, formatReportDate,
  CATEGORY_FILTER_OPTIONS, ROLE_FILTER_OPTIONS, REPORTER_ROLE_FILTER_OPTIONS,
} from '../../lib/reports/reportLabels';

const STATUS_TABS = [
  { value: 'open', label: 'Open' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const EMPTY_FILTERS = {
  status: 'open', category: 'all', reporterRole: 'all', reportedRole: 'all',
  dateFrom: '', dateTo: '',
};

function roleTag(report) {
  if (report.is_account_appeal) return 'Account appeal';
  const reporter = ROLE_LABELS[report.reporter_role] || 'User';
  if (!report.reported_user_id) return `${reporter} report`;
  const reported = ROLE_LABELS[report.reported_role] || 'user';
  return `${reporter} → ${reported}`;
}

// Bird's-eye Admin Reports queue: real summary counts, search, filters, and
// a clean, clickable list. Reviewing a report, changing its status, and
// adding resolution notes now all happen on the dedicated detail page
// (admin/ReportDetails.jsx) at /admin/reports/:reportId, which keeps this
// list lean and scannable. Everything here reads from the SAME `reports`
// table used everywhere else in the app (via get_admin_reports() /
// get_admin_report_counts(), database/admin_reports_management.sql) — no
// second report system, no invented data.
export default function Reports() {
  const navigate = useNavigate();
  const [reports, setReports] = useState([]);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const debounceRef = useRef(null);

  // Debounce free-text search so every keystroke doesn't fire a request.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [{ reports: data, error: reportsErr }, { counts: countsData, error: countsErr }] = await Promise.all([
      fetchAdminReports({ ...filters, search }),
      fetchAdminReportCounts(),
    ]);
    if (reportsErr || countsErr) {
      setError((reportsErr || countsErr).message || "We couldn't load reports right now. Please try again.");
    } else {
      setReports(data);
      setCounts(countsData);
    }
    setLoading(false);
  }, [filters, search]);

  useEffect(() => { load(); }, [load]);

  function setFilter(key, value) {
    setFilters(f => ({ ...f, [key]: value }));
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
    setSearch('');
  }

  const filtersActive = filters.category !== 'all' || filters.reporterRole !== 'all'
    || filters.reportedRole !== 'all' || filters.dateFrom || filters.dateTo || search;

  return (
    <DashboardLayout title="Reports & Appeals">
      <div className="page-header">
        <h1>Reports & Appeals</h1>
        <p>Passenger/driver complaints and account-ban appeals, in one queue.</p>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      )}

      {/* Real, database-backed summary counts — never hardcoded. */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <SummaryCard label="Open" value={loading ? '—' : counts?.open} highlight={!loading && counts?.open > 0} />
        <SummaryCard label="Under Review" value={loading ? '—' : counts?.under_review} />
        <SummaryCard label="Resolved" value={loading ? '—' : counts?.resolved} />
        <SummaryCard label="Closed" value={loading ? '—' : counts?.closed} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {STATUS_TABS.map(t => (
          <button
            key={t.value}
            className={`btn btn-sm ${filters.status === t.value ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFilter('status', t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search + filters */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            className="form-input"
            style={{ flex: '1 1 240px', minWidth: 200 }}
            placeholder="Search reference, name, or route…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
          <select className="form-select" style={{ flex: '1 1 160px' }} value={filters.category} onChange={e => setFilter('category', e.target.value)}>
            {CATEGORY_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: '1 1 160px' }}>
            <label className="form-label" style={{ fontSize: 11.5 }}>Reporter role</label>
            <select className="form-select" value={filters.reporterRole} onChange={e => setFilter('reporterRole', e.target.value)}>
              {REPORTER_ROLE_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 160px' }}>
            <label className="form-label" style={{ fontSize: 11.5 }}>Reported user role</label>
            <select className="form-select" value={filters.reportedRole} onChange={e => setFilter('reportedRole', e.target.value)}>
              {ROLE_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 140px' }}>
            <label className="form-label" style={{ fontSize: 11.5 }}>From date</label>
            <input type="date" className="form-input" value={filters.dateFrom} onChange={e => setFilter('dateFrom', e.target.value)} />
          </div>
          <div className="form-group" style={{ flex: '1 1 140px' }}>
            <label className="form-label" style={{ fontSize: 11.5 }}>To date</label>
            <input type="date" className="form-input" value={filters.dateTo} onChange={e => setFilter('dateTo', e.target.value)} />
          </div>
          {filtersActive && (
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
        </div>
      ) : reports.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎉</div>
          <h3>Nothing here</h3>
          <p>No reports match your search and filters.</p>
          {filtersActive && <button className="btn btn-sm btn-outline" style={{ marginTop: 12 }} onClick={clearFilters}>Clear filters</button>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {reports.map(r => (
            <div
              key={r.id}
              className="card card-pad"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/admin/reports/${r.id}`)}
              onKeyDown={e => { if (e.key === 'Enter') navigate(`/admin/reports/${r.id}`); }}
              style={{ cursor: 'pointer' }}
            >
              <div className="flex-between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`badge ${STATUS_BADGE[r.status] || 'badge-gray'}`}>{STATUS_LABELS[r.status] || r.status}</span>
                  <span className="badge badge-teal">{roleTag(r)}</span>
                  <span className="badge badge-gray">{r.is_account_appeal ? 'Account appeal' : CATEGORY_LABELS[r.category] || r.category}</span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {r.report_reference} · Submitted {formatReportDate(r.created_at)}
                </span>
              </div>

              <div style={{ fontSize: 13.5, marginBottom: 6 }}>
                <strong>{r.reporter_name || 'Unknown user'}</strong>
                {r.reported_user_id && (
                  <> → <strong>{r.reported_name || 'Unknown user'}</strong></>
                )}
              </div>

              {r.trip_id && (
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                  Trip: {r.origin} → {r.destination}{r.departure_time ? ` · ${formatReportDate(r.departure_time)}` : ''}
                </p>
              )}

              <div className="flex-between" style={{ marginTop: 10 }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Last updated {formatReportDate(r.updated_at)}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--primary-dark, #1D4ED8)', fontWeight: 600 }}>View details →</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}

function SummaryCard({ label, value, highlight }) {
  return (
    <div className="stat-card" style={highlight ? { borderColor: 'var(--amber, #D97706)' } : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? '—'}</div>
    </div>
  );
}
