import { Fragment, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';

const PAGE_SIZE = 30;

const ACTION_BADGE = {
  account_banned: 'badge-danger',
  account_suspended: 'badge-amber',
  account_active: 'badge-green',
};

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function actionLabel(action) {
  return (action || '').replace(/_/g, ' ');
}

function badgeClassFor(action) {
  if (ACTION_BADGE[action]) return ACTION_BADGE[action];
  if (action?.includes('ban')) return 'badge-danger';
  if (action?.includes('suspend')) return 'badge-amber';
  if (action?.includes('active') || action?.includes('reactivat')) return 'badge-green';
  return 'badge-gray';
}

// Read-only trail over the existing audit_logs table — UserManagement.jsx
// already writes to it on every suspend/ban/reactivate action. This is
// just the first admin-facing screen to actually read it back.
export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => { setPage(0); }, [search]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');

      let query = supabase
        .from('audit_logs')
        .select('*, admin:admin_id(full_name, email), target:user_id(full_name, email)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      if (search.trim()) {
        query = query.ilike('action', `%${search.trim()}%`);
      }

      const { data, error: fetchError, count } = await query;
      if (cancelled) return;
      if (fetchError) setError(fetchError.message);
      else { setLogs(data || []); setTotal(count || 0); }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [search, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <DashboardLayout title="Audit Log">
      <div className="page-header">
        <h1>Audit Log</h1>
        <p>Every admin action against a user account — {total} recorded.</p>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}

      <div style={{ marginBottom: 20 }}>
        <input
          className="form-input"
          placeholder="Filter by action (e.g. banned, suspended, verified)…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 340 }}
        />
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24 }}>
            <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h3>No audit entries</h3>
            <p>Admin actions will appear here as they happen.</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['When', 'Admin', 'Action', 'Target user', ''].map(h => (
                  <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <Fragment key={log.id}>
                  <tr key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDateTime(log.created_at)}</td>
                    <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{log.admin?.full_name || '—'}</td>
                    <td style={{ padding: '14px 20px' }}>
                      <span className={`badge ${badgeClassFor(log.action)}`}>{actionLabel(log.action)}</span>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{log.table_name}</div>
                    </td>
                    <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{log.target?.full_name || '—'}</td>
                    <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                      {(log.old_value || log.new_value) && (
                        <button className="btn btn-sm btn-ghost" onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}>
                          {expandedId === log.id ? 'Hide' : 'Details'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === log.id && (
                    <tr key={`${log.id}-detail`} style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-alt)' }}>
                      <td colSpan={5} style={{ padding: '12px 20px' }}>
                        <div className="grid-2" style={{ gap: 16, fontSize: 12 }}>
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-muted)' }}>Before</div>
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{JSON.stringify(log.old_value, null, 2)}</pre>
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-muted)' }}>After</div>
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{JSON.stringify(log.new_value, null, 2)}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!loading && totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
          <button className="btn btn-sm btn-outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Previous</button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', alignSelf: 'center' }}>Page {page + 1} of {totalPages}</span>
          <button className="btn btn-sm btn-outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}
    </DashboardLayout>
  );
}
