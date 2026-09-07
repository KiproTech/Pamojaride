import { supabase } from '../supabase';

// Data-fetching helpers for Admin Reports Management. Every read goes
// through get_admin_reports() / get_admin_report_counts() (see
// database/admin_reports_management.sql, extending the RPC first added by
// database/report_dispute_system_fix.sql) rather than a raw `.select()` —
// those RPCs re-check admin authorization themselves and resolve
// reporter/reported names, trip context, and booking context server-side
// (a client-side embed on `profiles` silently returns null under RLS for
// anyone other than the row's own owner). This is the same `public.reports`
// table used everywhere else in the app — nothing here is a second reports
// system.

function cleanFilters(filters = {}) {
  const {
    status, category, reporterRole, reportedRole, search, dateFrom, dateTo,
  } = filters;
  const norm = v => (v === undefined || v === null || v === '' ? null : v);
  return {
    p_status: norm(status),
    p_category: norm(category),
    p_reporter_role: norm(reporterRole),
    p_reported_role: norm(reportedRole),
    p_search: norm(search),
    p_date_from: norm(dateFrom),
    p_date_to: norm(dateTo),
  };
}

// Fetches the reports list for Admin, with optional search/filters applied
// server-side. Returns [] (never throws) so a failed fetch degrades to an
// empty/error state instead of crashing the page.
export async function fetchAdminReports(filters = {}) {
  const { data, error } = await supabase.rpc('get_admin_reports', cleanFilters(filters));
  if (error) {
    console.error('fetchAdminReports error:', error);
    return { reports: [], error };
  }
  return { reports: data || [], error: null };
}

// Fetches one report for the Admin detail view. Returns null (not an
// error) if the RPC comes back empty — that happens for a genuinely
// invalid id (get_admin_reports still checks admin authorization first and
// raises for a non-admin caller, which surfaces as `error` instead).
export async function fetchAdminReportDetail(reportId) {
  const { data, error } = await supabase.rpc('get_admin_reports', { p_report_id: reportId });
  if (error) {
    console.error('fetchAdminReportDetail error:', error);
    return { report: null, error };
  }
  const report = Array.isArray(data) ? data[0] || null : null;
  return { report, error: null };
}

// Real, live counts per status — never hardcoded on the frontend.
export async function fetchAdminReportCounts() {
  const { data, error } = await supabase.rpc('get_admin_report_counts');
  if (error) {
    console.error('fetchAdminReportCounts error:', error);
    return { counts: null, error };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    counts: {
      open: Number(row?.open_count || 0),
      under_review: Number(row?.under_review_count || 0),
      resolved: Number(row?.resolved_count || 0),
      closed: Number(row?.closed_count || 0),
      total: Number(row?.total_count || 0),
    },
    error: null,
  };
}

// Real, recorded status transitions for one report (database/
// my_reports_tracking.sql). That RPC already authorizes admins as well as
// the report's own reporter, so it's reused as-is here.
export async function fetchAdminReportHistory(reportId) {
  const { data, error } = await supabase.rpc('get_my_report_status_history', { p_report_id: reportId });
  if (error) {
    console.error('fetchAdminReportHistory error:', error);
    return { history: [], error };
  }
  return { history: data || [], error: null };
}

// Moves a report to a new status and/or updates its resolution notes.
// Uses the same plain `.update()` on `reports` the admin page has always
// used — still gated by the existing "admin can update complaints" RLS
// policy (admin-only), and still the same UPDATE that the existing
// trg_notify_report_status_change / trg_log_report_status_change triggers
// react to (see report_status_workflow_notifications.sql and
// my_reports_tracking.sql). Both triggers fire only when `status` actually
// changes (`WHEN (OLD.status IS DISTINCT FROM NEW.status)`), so saving
// notes alone — with the status left the same — updates the record without
// notifying anyone, which is exactly the "no meaningful change, no
// notification" behaviour the brief asks for.
export async function updateAdminReportStatus(report, { status, notes }) {
  const { data: userData } = await supabase.auth.getUser();
  const adminId = userData?.user?.id;
  const trimmedNotes = typeof notes === 'string' ? notes.trim() : '';
  // Only stamp resolved_by/resolved_at at the moment of an actual
  // transition INTO resolved/closed — saving notes on a report that is
  // already resolved/closed (status unchanged) must not silently reset
  // when/who it was resolved by.
  const isTransition = status !== report.status;
  const isClosingNow = isTransition && (status === 'resolved' || status === 'closed');

  const payload = {
    status,
    // Reflects exactly what's in the notes field right now, including an
    // intentional clear (empty field -> null) — the caller always passes
    // the current textarea value, so there's no way to "accidentally"
    // wipe notes the admin didn't touch.
    resolution_notes: trimmedNotes.length > 0 ? trimmedNotes : null,
    resolved_by: isClosingNow ? adminId : report.resolved_by,
    resolved_at: isClosingNow ? new Date().toISOString() : report.resolved_at,
  };

  const { error } = await supabase.from('reports').update(payload).eq('id', report.id);
  if (error) {
    console.error('updateAdminReportStatus error:', error);
    return { error };
  }
  return { error: null, payload };
}
