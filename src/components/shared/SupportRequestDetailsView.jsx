import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import { fetchMySupportRequestDetail } from '../../lib/support/support';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, formatSupportDate } from '../../lib/support/supportLabels';

// Shared support request detail view, used by both portals:
//   - pages/passenger/SupportDetails.jsx (portal="passenger")
//   - pages/driver/SupportDetails.jsx    (portal="driver")
//
// Loads by :requestId from the URL. get_my_support_requests(p_request_id)
// only ever returns a row when the SIGNED-IN user is that request's
// owner — manually editing the id in the URL to another user's request
// returns nothing, rendered the same as a genuinely invalid id.
export default function SupportRequestDetailsView({ portal }) {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { request: data, error: err } = await fetchMySupportRequestDetail(requestId);
    if (err) setError("We couldn't load this request right now. Please try again.");
    else setRequest(data);
    setLoading(false);
  }, [requestId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!user || !requestId) return;
    const channel = supabase
      .channel(`support-request-detail-${portal}-${requestId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'support_requests', filter: `id=eq.${requestId}` },
        () => { load(); }
      )
      .subscribe();

    return () => { channel.unsubscribe(); };
  }, [user, portal, requestId, load]);

  const backPath = `/${portal}/support`;

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger" style={{ marginBottom: 20 }}>
        {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🔍</div>
        <h3>Request not found</h3>
        <p>This support request doesn't exist, or isn't one you submitted.</p>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate(backPath)}>Back to Help &amp; Support</button>
      </div>
    );
  }

  return (
    <div>
      <button className="btn btn-sm btn-ghost" style={{ marginBottom: 16 }} onClick={() => navigate(backPath)}>← Back to Help &amp; Support</button>

      <div className="page-header">
        <h1>{request.request_reference}</h1>
        <p>Submitted {formatSupportDate(request.created_at)}</p>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Request Information</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span className={`badge ${STATUS_BADGE[request.status] || 'badge-gray'}`}>{STATUS_LABELS[request.status] || request.status}</span>
          <span className="badge badge-gray">{CATEGORY_LABELS[request.category] || request.category}</span>
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <Field label="Reference" value={request.request_reference} />
          <Field label="Date submitted" value={formatSupportDate(request.created_at)} />
        </div>
      </div>

      {request.trip_id && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Related Trip</h3>
          <div className="grid-2" style={{ gap: 10 }}>
            <Field label="Origin" value={request.origin || '—'} />
            <Field label="Destination" value={request.destination || '—'} />
            <Field label="Trip date" value={formatSupportDate(request.departure_time)} />
            {request.booking_reference && <Field label="Booking" value={request.booking_reference} />}
          </div>
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>{request.subject}</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', whiteSpace: 'pre-wrap', margin: '10px 0 0' }}>
          {request.message}
        </p>
      </div>

      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Status and Updates</h3>
        <div className="grid-2" style={{ gap: 10, marginBottom: request.admin_response ? 14 : 0 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Current status</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>
              <span className={`badge ${STATUS_BADGE[request.status] || 'badge-gray'}`}>{STATUS_LABELS[request.status] || request.status}</span>
            </p>
          </div>
          <Field label="Last updated" value={formatSupportDate(request.updated_at)} />
        </div>

        {request.admin_response && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 4px' }}>Response from our support team</p>
            <p style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', margin: 0 }}>{request.admin_response}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>{label}</p>
      <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{value}</p>
    </div>
  );
}
