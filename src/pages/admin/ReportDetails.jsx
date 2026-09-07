import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import { fetchAdminReportDetail, fetchAdminReportHistory, updateAdminReportStatus } from '../../lib/reports/adminReports';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, ROLE_LABELS, formatReportDate } from '../../lib/reports/reportLabels';

function cleanDescription(description) {
  if (!description) return '';
  return description.replace(/^\[Account appeal[^\]]*\]\s*/, '').trim();
}

// Legitimate next actions per current status. Reuses the exact status
// vocabulary already enforced by reports_status_check (open / under_review
// / resolved / closed, see trip_complaints_admin_alerts_cancellation_
// history.sql) — no new status is introduced anywhere in this file.
const NEXT_ACTIONS = {
  open: [
    { status: 'under_review', label: 'Mark Under Review', tone: 'btn-outline' },
    { status: 'resolved', label: 'Resolve', tone: 'btn-primary' },
    { status: 'closed', label: 'Close', tone: 'btn-ghost' },
  ],
  under_review: [
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

// Admin-only report detail view, at /admin/reports/:reportId. Reads via
// get_admin_reports(p_report_id) / get_my_report_status_history() (see
// database/admin_reports_management.sql and database/
// my_reports_tracking.sql) — both re-check admin authorization
// server-side, so an invalid or someone-else's-report id simply returns no
// rows here (handled as "not found" below), and a non-admin caller is
// refused before any row is touched regardless of what this page does.
// Status changes go through the existing plain `.update()` on `reports`
// (still admin-only via RLS), which is exactly what the existing
// notification triggers already react to — nothing about that pipeline is
// duplicated or bypassed here.
export default function ReportDetails() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [pendingAction, setPendingAction] = useState(null); // { status, label }
  const [busy, setBusy] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotFound(false);
    const [{ report: reportData, error: reportErr }, { history: historyData }] = await Promise.all([
      fetchAdminReportDetail(reportId),
      fetchAdminReportHistory(reportId),
    ]);
    if (reportErr) {
      setError("We couldn't load this report right now. Please try again.");
    } else if (!reportData) {
      setNotFound(true);
    } else {
      setReport(reportData);
      setNoteDraft(reportData.resolution_notes || '');
      setHistory(historyData);
    }
    setLoading(false);
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  // Live updates: reflect another admin's change (or a race with a fresh
  // report the user just submitted) without requiring a manual refresh.
  // Purely a convenience layer — the database stays the source of truth.
  useEffect(() => {
    if (!reportId) return;
    const channel = supabase
      .channel(`admin-report-detail-${reportId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reports', filter: `id=eq.${reportId}` }, () => load())
      .subscribe();
    return () => { channel.unsubscribe(); };
  }, [reportId, load]);

  async function saveNotesOnly() {
    if (!report) return;
    setSavingNotes(true);
    setError('');
    setSuccessMsg('');
    const { error: updateError } = await updateAdminReportStatus(report, { status: report.status, notes: noteDraft });
    setSavingNotes(false);
    if (updateError) { setError(updateError.message); return; }
    setSuccessMsg('Resolution notes saved.');
    load();
  }

  async function confirmStatusChange() {
    if (!pendingAction || !report) return;
    setBusy(true);
    setError('');
    setSuccessMsg('');
    const { error: updateError } = await updateAdminReportStatus(report, { status: pendingAction.status, notes: noteDraft });
    setBusy(false);
    if (updateError) { setError(updateError.message); return; }
    setSuccessMsg(`Report marked as ${STATUS_LABELS[pendingAction.status] || pendingAction.status}. The relevant users have been notified.`);
    setPendingAction(null);
    load();
  }

  if (loading) {
    return (
      <DashboardLayout title="Report Details">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
        </div>
      </DashboardLayout>
    );
  }

  if (error && !report) {
    return (
      <DashboardLayout title="Report Details">
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          {error} <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={load}>Retry</button>
        </div>
      </DashboardLayout>
    );
  }

  if (notFound || !report) {
    return (
      <DashboardLayout title="Report Details">
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <h3>Report not found</h3>
          <p>This report doesn't exist, or the link is invalid.</p>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate('/admin/reports')}>Back to Reports</button>
        </div>
      </DashboardLayout>
    );
  }

  const actions = NEXT_ACTIONS[report.status] || [];
  const notesUnchanged = noteDraft.trim() === (report.resolution_notes || '').trim();
  const timeline = [
    { label: 'Report submitted', at: report.created_at, note: null },
    ...history.map(h => ({
      label: `Status changed to ${STATUS_LABELS[h.new_status] || h.new_status}`,
      at: h.changed_at,
      note: h.note || null,
    })),
  ];

  return (
    <DashboardLayout title="Report Details">
      <button className="btn btn-sm btn-ghost" style={{ marginBottom: 16 }} onClick={() => navigate('/admin/reports')}>← Back to Reports</button>

      <div className="page-header">
        <h1>{report.report_reference}</h1>
        <p>Submitted {formatReportDate(report.created_at)}</p>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}
      {successMsg && <div className="alert alert-success" style={{ marginBottom: 20 }}>{successMsg}</div>}

      {/* Report Information */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Report Information</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span className={`badge ${STATUS_BADGE[report.status] || 'badge-gray'}`}>{STATUS_LABELS[report.status] || report.status}</span>
          <span className="badge badge-gray">{report.is_account_appeal ? 'Account appeal' : (CATEGORY_LABELS[report.category] || report.category)}</span>
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <Field label="Reference" value={report.report_reference} />
          <Field label="Date submitted" value={formatReportDate(report.created_at)} />
        </div>
      </div>

      {/* People Involved */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>People Involved</h3>
        <div className="grid-2" style={{ gap: 10 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>
              Reporter{report.reporter_role ? ` (${ROLE_LABELS[report.reporter_role] || report.reporter_role})` : ''}
            </p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{report.reporter_name || 'Unknown user'}</p>
            {report.reporter_email && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>{report.reporter_email}</p>}
          </div>
          {report.reported_user_id ? (
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>
                Reported user{report.reported_role ? ` (${ROLE_LABELS[report.reported_role] || report.reported_role})` : ''}
              </p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{report.reported_name || 'Unknown user'}</p>
              {report.reported_email && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>{report.reported_email}</p>}
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Reported user</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0', color: 'var(--text-muted)' }}>
                Not applicable — this is an account appeal, not a complaint about another user.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Trip and Booking */}
      {report.trip_id && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Trip and Booking</h3>
          <div className="grid-2" style={{ gap: 10 }}>
            <Field label="Origin" value={report.origin || '—'} />
            <Field label="Destination" value={report.destination || '—'} />
            <Field label="Trip date & departure" value={formatReportDate(report.departure_time)} />
            <Field
              label="Booking reference"
              value={report.booking_reference ? `${report.booking_reference}${report.seats_booked ? ` · ${report.seats_booked} seat(s)` : ''}` : '—'}
            />
            {report.pickup_point && <Field label="Pickup point" value={report.pickup_point} />}
            {report.dropoff_point && <Field label="Drop-off point" value={report.dropoff_point} />}
          </div>
        </div>
      )}

      {/* Incident Details */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Incident Details</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', whiteSpace: 'pre-wrap', margin: 0 }}>
          {cleanDescription(report.description)}
        </p>
      </div>

      {/* Report Status */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Report Status</h3>
        <div className="grid-2" style={{ gap: 10 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Current status</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>
              <span className={`badge ${STATUS_BADGE[report.status] || 'badge-gray'}`}>{STATUS_LABELS[report.status] || report.status}</span>
            </p>
          </div>
          <Field label="Last updated" value={formatReportDate(report.updated_at)} />
        </div>
      </div>

      {/* Admin Resolution */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Admin Resolution</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Shared with the person who submitted the report when the status changes below. Not shown to the reported party.
        </p>
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label className="form-label">Resolution notes / admin comments</label>
          <textarea
            className="form-input"
            rows={3}
            style={{ resize: 'vertical' }}
            value={noteDraft}
            onChange={e => setNoteDraft(e.target.value)}
            placeholder="e.g. Reviewed the incident, contacted both parties, issued a formal warning."
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-outline" disabled={savingNotes || notesUnchanged} onClick={saveNotesOnly}>
            {savingNotes ? <span className="spinner" /> : 'Save notes'}
          </button>
          {actions.map(a => (
            <button key={a.status} className={`btn btn-sm ${a.tone}`} onClick={() => setPendingAction(a)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* Report History */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Report History</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {timeline.map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{
                  width: 9, height: 9, borderRadius: '50%',
                  background: i === timeline.length - 1 ? 'var(--primary, #2563EB)' : 'var(--border-strong, #CBD5E1)',
                  marginTop: 4,
                }} />
                {i < timeline.length - 1 && <span style={{ width: 1, flex: 1, background: 'var(--border)', minHeight: 18 }} />}
              </div>
              <div style={{ paddingBottom: 4 }}>
                <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{step.label}</p>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 0' }}>{formatReportDate(step.at)}</p>
                {step.note && <p style={{ fontSize: 12.5, color: 'var(--text-secondary, #334155)', margin: '4px 0 0' }}>{step.note}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Confirmation modal */}
      {pendingAction && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>{pendingAction.label} this report?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              {report.reporter_name || 'The reporter'} will be notified of this status change
              {report.reported_user_id ? ', and so will the reported user' : ''}.
              {(pendingAction.status === 'resolved' || pendingAction.status === 'closed')
                ? ' Make sure your resolution notes above summarise the outcome before confirming — they are shared with the reporter.'
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
