import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import { fetchMySupportRequests } from '../../lib/support/support';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, formatSupportDate } from '../../lib/support/supportLabels';

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

function previewText(message) {
  if (!message) return '';
  return message.length > 140 ? `${message.slice(0, 140).trim()}…` : message;
}

// Shared My (Support) Requests list, used by both portals via
// SupportPage.jsx. Only ever shows requests the SIGNED-IN user
// submitted — enforced by get_my_support_requests() (database/
// customer_support_system.sql), which scopes to user_id = auth.uid()
// server-side regardless of anything the client sends.
export default function SupportRequestsList({ portal, refreshKey }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { requests: data, error: err } = await fetchMySupportRequests();
    if (err) setError("We couldn't load your support requests right now. Please try again.");
    else setRequests(data);
    setLoading(false);
  }, []);

  useEffect(() => { if (user) load(); }, [user, load, refreshKey]);

  // Live updates: reflect an admin's status/response change without a
  // manual refresh. Purely a convenience layer — the database (via load()
  // above) stays the source of truth.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`my-support-requests-${portal}-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'support_requests', filter: `user_id=eq.${user.id}` },
        () => { load(); }
      )
      .subscribe();

    return () => { channel.unsubscribe(); };
  }, [user, portal, load]);

  const visible = filter === 'all' ? requests : requests.filter(r => r.status === filter);

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>My Requests</h3>
        {!loading && !error && (
          <button className="btn btn-sm btn-outline" onClick={load}>Refresh</button>
        )}
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
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
          <div className="empty-icon">💬</div>
          <h3>{requests.length === 0 ? 'No support requests yet' : 'No requests match this filter'}</h3>
          <p>
            {requests.length === 0
              ? "Need help with your account, a booking, or something technical? Submit a request above."
              : 'Try a different status filter.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {visible.map(r => (
            <div
              key={r.id}
              className="card card-pad"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/${portal}/support/${r.id}`)}
              onKeyDown={e => { if (e.key === 'Enter') navigate(`/${portal}/support/${r.id}`); }}
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

              <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>{r.subject}</p>

              {r.trip_id && (
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                  Trip: {r.origin} → {r.destination}{r.departure_time ? ` · ${formatSupportDate(r.departure_time)}` : ''}
                </p>
              )}

              <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', margin: '8px 0 4px' }}>
                {previewText(r.message)}
              </p>

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
    </div>
  );
}
