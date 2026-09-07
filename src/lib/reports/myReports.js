import { supabase } from '../supabase';

// Data-fetching helpers for the "My Reports" feature (Passenger + Driver).
// Every call goes through the RPCs added in
// database/my_reports_tracking.sql (get_my_reports / get_my_report_status_history)
// rather than a raw `.select()` — those RPCs already scope everything to
// `reporter_id = auth.uid()` server-side and resolve trip/booking/counterpart
// context safely (the same reason get_admin_reports() and
// get_driver_trip_bookings() exist elsewhere in this project: a client-side
// embed on `profiles` silently returns null because profiles' RLS only
// allows reading your own row). Nothing here reads or writes a second
// "reports" table — this is the same `public.reports` table used
// everywhere else in the app.

// Fetches the signed-in user's own reports. Returns [] (never throws) so a
// failed fetch degrades to an empty/error state instead of crashing the
// page — the caller decides how to surface `error`.
export async function fetchMyReports() {
  const { data, error } = await supabase.rpc('get_my_reports');
  if (error) {
    console.error('fetchMyReports error:', error);
    return { reports: [], error };
  }
  return { reports: data || [], error: null };
}

// Fetches a single report the signed-in user submitted. Returns null (not
// an error) if the RPC comes back empty — that happens both when the id
// doesn't exist and when it belongs to someone else, and the two cases are
// deliberately indistinguishable to the caller (no "this report exists but
// isn't yours" leak).
export async function fetchMyReportDetail(reportId) {
  const { data, error } = await supabase.rpc('get_my_reports', { p_report_id: reportId });
  if (error) {
    console.error('fetchMyReportDetail error:', error);
    return { report: null, error };
  }
  const report = Array.isArray(data) ? data[0] || null : null;
  return { report, error: null };
}

// Fetches the real, recorded status transitions for one report. Returns []
// on any authorization/db error rather than throwing, so the timeline
// section can simply fall back to "submitted + current status" for older
// reports that predate this history table, or if this call fails.
export async function fetchMyReportStatusHistory(reportId) {
  const { data, error } = await supabase.rpc('get_my_report_status_history', { p_report_id: reportId });
  if (error) {
    console.error('fetchMyReportStatusHistory error:', error);
    return { history: [], error };
  }
  return { history: data || [], error: null };
}
