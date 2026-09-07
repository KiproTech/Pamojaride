import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import { fetchMyReportDetail, fetchMyReportStatusHistory } from '../../lib/reports/myReports';
import { STATUS_LABELS, STATUS_BADGE, CATEGORY_LABELS, formatReportDate } from '../../lib/reports/reportLabels';

function counterpartLabel(report) {
  if (!report || report.is_account_appeal) return null;
  if (!report.reported_user_id) return null;
  const roleLabel = report.my_role === 'driver' ? 'Passenger' : report.my_role === 'passenger' ? 'Driver' : 'Other party';
  return `${roleLabel}: ${report.reported_name || 'Unavailable'}`;
}

function cleanDescription(description) {
  if (!description) return '';
  return description.replace(/^\[Account appeal[^\]]*\]\s*/, '').trim();
}

// Shared report detail view, used by both portals:
//   - pages/passenger/ReportDetails.jsx (portal="passenger")
//   - pages/driver/ReportDetails.jsx    (portal="driver")
//
// Loads by :reportId from the URL. get_my_reports(p_report_id) (database/
// my_reports_tracking.sql) only ever returns a row when the SIGNED-IN user
// is that report's reporter — so manually editing the id in the URL to
// another user's report id returns nothing, and this renders the same
// "not found" state as a genuinely invalid id. Nothing here distinguishes
// "doesn't exist" from "isn't yours".
export default function ReportDetailsView({ portal }) {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [{ report: reportData, error: reportErr }, { history: historyData }] = await Promise.all([
      fetchMyReportDetail(reportId),
      fetchMyReportStatusHistory(reportId),
    ]);
    if (reportErr) {
      setError("We couldn't load this report right now. Please try again.");
    } else {
      setReport(reportData);
      setHistory(historyData);
    }
    setLoading(false);
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  // Same live-update convenience as the list view — purely additive, the
  // database stays the source of truth and a manual refresh always works.
  useEffect(() => {
    if (!user || !reportId) return;
    const channel = supabase
      .channel(`report-detail-${portal}-${reportId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'reports', filter: `id=eq.${reportId}` },
        () => { load(); }
      )
      .subscribe();

    return () => { channel.unsubscribe(); };
  }, [user, portal, reportId, load]);

  const backPath = `/${portal}/reports`;

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

  if (!report) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🔍</div>
        <h3>Report not found</h3>
        <p>This report doesn't exist, or isn't one you submitted.</p>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate(backPath)}>Back to My Reports</button>
      </div>
    );
  }

  const person = counterpartLabel(report);

  // Real timeline only: "Report submitted" is always true (created_at is
  // a real, existing column). Every subsequent step comes straight from
  // report_status_history — actual recorded transitions, nothing guessed.
  // Reports whose status changed before this migration existed simply
  // won't have intermediate rows here, and none are invented to fill the
  // gap; the current status badge above still shows the true, current
  // state either way.
  const timeline = [
    { label: 'Report submitted', at: report.created_at, note: null },
    ...history.map(h => ({
      label: `Status changed to ${STATUS_LABELS[h.new_status] || h.new_status}`,
      at: h.changed_at,
      note: h.note || null,
    })),
  ];

  return (
    <div>
      <button className="btn btn-sm btn-ghost" style={{ marginBottom: 16 }} onClick={() => navigate(backPath)}>← Back to My Reports</button>

      <div className="page-header">
        <h1>{report.report_reference}</h1>
        <p>Submitted {formatReportDate(report.created_at)}</p>
      </div>

      {/* Report Information */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Report Information</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span className={`badge ${STATUS_BADGE[report.status] || 'badge-gray'}`}>{STATUS_LABELS[report.status] || report.status}</span>
          <span className="badge badge-gray">{report.is_account_appeal ? 'Account appeal' : (CATEGORY_LABELS[report.category] || report.category)}</span>
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Reference</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{report.report_reference}</p>
          </div>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Date submitted</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{formatReportDate(report.created_at)}</p>
          </div>
          {person && (
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Involving</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{person}</p>
            </div>
          )}
        </div>
      </div>

      {/* Trip Information */}
      {report.trip_id && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Trip Information</h3>
          <div className="grid-2" style={{ gap: 10 }}>
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Origin</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{report.origin || '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Destination</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{report.destination || '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Trip date</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{formatReportDate(report.departure_time)}</p>
            </div>
            {report.booking_reference && (
              <div>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Booking</p>
                <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{report.booking_reference}{report.seats_booked ? ` · ${report.seats_booked} seat(s)` : ''}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Report Details */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Report Details</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', whiteSpace: 'pre-wrap', margin: 0 }}>
          {cleanDescription(report.description)}
        </p>
      </div>

      {/* Status and Updates */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Status and Updates</h3>
        <div className="grid-2" style={{ gap: 10, marginBottom: report.resolution_notes ? 14 : 0 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Current status</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>
              <span className={`badge ${STATUS_BADGE[report.status] || 'badge-gray'}`}>{STATUS_LABELS[report.status] || report.status}</span>
            </p>
          </div>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Last updated</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{formatReportDate(report.updated_at)}</p>
          </div>
        </div>

        {report.resolution_notes && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 4px' }}>Update from our support team</p>
            <p style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', margin: 0 }}>{report.resolution_notes}</p>
          </div>
        )}

        {/* Timeline — real, recorded events only. See the comment above the
            `timeline` array for exactly what this is and isn't. */}
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 10px', fontWeight: 600 }}>Timeline</p>
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
      </div>
    </div>
  );
}
