import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import { fetchAdminSupportRequestDetail, updateAdminSupportRequest } from '../../lib/support/adminSupport';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, formatSupportDate } from '../../lib/support/supportLabels';

// Legitimate next actions per current status. Reuses the exact status
// vocabulary enforced by support_requests_status_check (open /
// in_progress / resolved / closed — database/customer_support_system.sql).
const NEXT_ACTIONS = {
  open: [
    { status: 'in_progress', label: 'Mark In Progress', tone: 'btn-outline' },
    { status: 'resolved', label: 'Resolve', tone: 'btn-primary' },
    { status: 'closed', label: 'Close', tone: 'btn-ghost' },
  ],
  in_progress: [
    { status: 'resolved', label: 'Resolve', tone: 'btn-primary' },
    { status: 'closed', label: 'Close', tone: 'btn-ghost' },
    { status: 'open', label: 'Reopen', tone: 'btn-outline' },
  ],
  resolved: [
    { status: 'closed', label: 'Close', tone: 'btn-ghost' },
    { status: 'open', label: 'Reopen', tone: 'btn-outline' },
  ],
  closed: [
    { status: 'open', label: 'Reopen', tone: 'btn-outline' },
  ],
};

// Admin-only support request detail, at /admin/support/:requestId. Reads
// via get_admin_support_requests(p_request_id) (database/
// customer_support_system.sql), which re-checks admin authorization
// server-side — an invalid or nonexistent id simply returns no rows
// (handled as "not found" below). Status/response changes go through a
// plain `.update()` on `support_requests` (still admin-only via RLS),
// which is exactly what trg_notify_support_request_update already reacts
// to — nothing about that pipeline is duplicated here.
export default function SupportDetails() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [responseDraft, setResponseDraft] = useState('');
  const [pendingAction, setPendingAction] = useState(null); // { status, label }
  const [busy, setBusy] = useState(false);
  const [savingResponse, setSavingResponse] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotFound(false);
    const { request: data, error: err } = await fetchAdminSupportRequestDetail(requestId);
    if (err) {
      setError("We couldn't load this request right now. Please try again.");
    } else if (!data) {
      setNotFound(true);
    } else {
      setRequest(data);
      setResponseDraft(data.admin_response || '');
    }
    setLoading(false);
  }, [requestId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!requestId) return;
    const channel = supabase
      .channel(`admin-support-detail-${requestId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'support_requests', filter: `id=eq.${requestId}` }, () => load())
      .subscribe();
    return () => { channel.unsubscribe(); };
  }, [requestId, load]);

  async function saveResponseOnly() {
    if (!request) return;
    setSavingResponse(true);
    setError('');
    setSuccessMsg('');
    const { error: updateError } = await updateAdminSupportRequest(request, { status: request.status, adminResponse: responseDraft });
    setSavingResponse(false);
    if (updateError) { setError(updateError.message); return; }
    setSuccessMsg('Response saved and shared with the user.');
    load();
  }

  async function confirmStatusChange() {
    if (!pendingAction || !request) return;
    setBusy(true);
    setError('');
    setSuccessMsg('');
    const { error: updateError } = await updateAdminSupportRequest(request, { status: pendingAction.status, adminResponse: responseDraft });
    setBusy(false);
    if (updateError) { setError(updateError.message); return; }
    setSuccessMsg(`Request marked as ${STATUS_LABELS[pendingAction.status] || pendingAction.status}. The user has been notified.`);
    setPendingAction(null);
    load();
  }

  if (loading) {
    return (
      <DashboardLayout title="Support Request">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
        </div>
      </DashboardLayout>
    );
  }

  if (error && !request) {
    return (
      <DashboardLayout title="Support Request">
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      </DashboardLayout>
    );
  }

  if (notFound || !request) {
    return (
      <DashboardLayout title="Support Request">
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <h3>Request not found</h3>
          <p>This support request doesn't exist, or the link is invalid.</p>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate('/admin/support')}>Back to Support</button>
        </div>
      </DashboardLayout>
    );
  }

  const actions = NEXT_ACTIONS[request.status] || [];
  const responseUnchanged = responseDraft.trim() === (request.admin_response || '').trim();

  return (
    <DashboardLayout title="Support Request">
      <button className="btn btn-sm btn-ghost" style={{ marginBottom: 16 }} onClick={() => navigate('/admin/support')}>← Back to Support</button>

      <div className="page-header">
        <h1>{request.request_reference}</h1>
        <p>Submitted {formatSupportDate(request.created_at)}</p>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}
      {successMsg && <div className="alert alert-success" style={{ marginBottom: 20 }}>{successMsg}</div>}

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

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Submitted By</h3>
        <div className="grid-2" style={{ gap: 10 }}>
          <Field label="Name" value={request.user_name || 'Unknown user'} />
          <Field label="Email" value={request.user_email || '—'} />
        </div>
      </div>

      {request.trip_id && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Related Trip / Booking</h3>
          <div className="grid-2" style={{ gap: 10 }}>
            <Field label="Origin" value={request.origin || '—'} />
            <Field label="Destination" value={request.destination || '—'} />
            <Field label="Trip date" value={formatSupportDate(request.departure_time)} />
            <Field label="Booking reference" value={request.booking_reference || '—'} />
          </div>
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>{request.subject}</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', whiteSpace: 'pre-wrap', margin: '10px 0 0' }}>
          {request.message}
        </p>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Response &amp; Status</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Shared with the user when saved, or when the status changes below.
        </p>
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label className="form-label">Response to user</label>
          <textarea
            className="form-input"
            rows={3}
            style={{ resize: 'vertical' }}
            value={responseDraft}
            onChange={e => setResponseDraft(e.target.value)}
            placeholder="e.g. We've processed your refund — it should reflect within 3 business days."
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-outline" disabled={savingResponse || responseUnchanged} onClick={saveResponseOnly}>
            {savingResponse ? <span className="spinner" /> : 'Save response'}
          </button>
          {actions.map(a => (
            <button key={a.status} className={`btn btn-sm ${a.tone}`} onClick={() => setPendingAction(a)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {pendingAction && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>{pendingAction.label} this request?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              {request.user_name || 'The user'} will be notified of this status change.
              {(pendingAction.status === 'resolved' || pendingAction.status === 'closed')
                ? ' Make sure your response above summarises the outcome before confirming.'
                : ''}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingAction(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={confirmStatusChange}>
                {busy ? <span className="spinner" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
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

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
};
const modalStyle = {
  background: 'white', borderRadius: 16, padding: '28px 30px', maxWidth: 440, width: '100%',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', fontFamily: "'DM Sans', sans-serif",
};
