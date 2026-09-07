import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/shared/DashboardLayout';
import { fetchAdminSupportRequests, fetchAdminSupportCounts } from '../../lib/support/adminSupport';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, CATEGORY_FILTER_OPTIONS, formatSupportDate } from '../../lib/support/supportLabels';

const STATUS_TABS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const EMPTY_FILTERS = { status: 'open', category: 'all', dateFrom: '', dateTo: '' };

// Admin Support queue: real summary counts, search, filters, and a clean,
// clickable list. Reading and updating a request happen on the dedicated
// detail page (admin/SupportDetails.jsx) at /admin/support/:requestId.
// Everything here reads from `public.support_requests` via
// get_admin_support_requests() / get_admin_support_counts() (database/
// customer_support_system.sql) — a table completely separate from
// `public.reports`, which keeps its own Reports & Appeals queue untouched.
export default function Support() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [{ requests: data, error: reqErr }, { counts: countsData, error: countsErr }] = await Promise.all([
      fetchAdminSupportRequests({ ...filters, search }),
      fetchAdminSupportCounts(),
    ]);
    if (reqErr || countsErr) {
      setError((reqErr || countsErr).message || "We couldn't load support requests right now. Please try again.");
    } else {
      setRequests(data);
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

  const filtersActive = filters.category !== 'all' || filters.dateFrom || filters.dateTo || search;

  return (
    <DashboardLayout title="Help & Support">
      <div className="page-header">
        <h1>Help &amp; Support</h1>
        <p>Passenger and driver support requests — account, booking, payment, and technical questions.</p>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      )}

      <div className="grid-4" style={{ marginBottom: 20 }}>
        <SummaryCard label="Open" value={loading ? '—' : counts?.open} highlight={!loading && counts?.open > 0} />
        <SummaryCard label="In Progress" value={loading ? '—' : counts?.in_progress} />
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

      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            className="form-input"
            style={{ flex: '1 1 240px', minWidth: 200 }}
            placeholder="Search reference, name, subject, or route…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
          <select className="form-select" style={{ flex: '1 1 160px' }} value={filters.category} onChange={e => setFilter('category', e.target.value)}>
            {CATEGORY_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
      ) : requests.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎉</div>
          <h3>Nothing here</h3>
          <p>No support requests match your search and filters.</p>
          {filtersActive && <button className="btn btn-sm btn-outline" style={{ marginTop: 12 }} onClick={clearFilters}>Clear filters</button>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {requests.map(r => (
            <div
              key={r.id}
              className="card card-pad"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/admin/support/${r.id}`)}
              onKeyDown={e => { if (e.key === 'Enter') navigate(`/admin/support/${r.id}`); }}
              style={{ cursor: 'pointer' }}
            >
              <div className="flex-between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`badge ${STATUS_BADGE[r.status] || 'badge-gray'}`}>{STATUS_LABELS[r.status] || r.status}</span>
                  <span className="badge badge-gray">{CATEGORY_LABELS[r.category] || r.category}</span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {r.request_reference} · Submitted {formatSupportDate(r.created_at)}
                </span>
              </div>

              <div style={{ fontSize: 13.5, marginBottom: 6 }}>
                <strong>{r.user_name || 'Unknown user'}</strong> — {r.subject}
              </div>

              {r.trip_id && (
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                  Trip: {r.origin} → {r.destination}{r.departure_time ? ` · ${formatSupportDate(r.departure_time)}` : ''}
                </p>
              )}

              <div className="flex-between" style={{ marginTop: 10 }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Last updated {formatSupportDate(r.updated_at)}
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
