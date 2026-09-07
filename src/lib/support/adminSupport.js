import { supabase } from '../supabase';

// Data-fetching helpers for Admin Support Management. Every read goes
// through get_admin_support_requests() / get_admin_support_counts() (see
// database/customer_support_system.sql) — both re-check admin
// authorization server-side and resolve the requester's name/email and
// trip/booking context safely. This is the same `public.support_requests`
// table used by the user-facing Contact Support / My Requests feature —
// nothing here is a second table or a second system.

function cleanFilters(filters = {}) {
  const { status, category, search, dateFrom, dateTo } = filters;
  const norm = v => (v === undefined || v === null || v === '' ? null : v);
  return {
    p_status: norm(status),
    p_category: norm(category),
    p_search: norm(search),
    p_date_from: norm(dateFrom),
    p_date_to: norm(dateTo),
  };
}

export async function fetchAdminSupportRequests(filters = {}) {
  const { data, error } = await supabase.rpc('get_admin_support_requests', cleanFilters(filters));
  if (error) {
    console.error('fetchAdminSupportRequests error:', error);
    return { requests: [], error };
  }
  return { requests: data || [], error: null };
}

export async function fetchAdminSupportRequestDetail(requestId) {
  const { data, error } = await supabase.rpc('get_admin_support_requests', { p_request_id: requestId });
  if (error) {
    console.error('fetchAdminSupportRequestDetail error:', error);
    return { request: null, error };
  }
  const request = Array.isArray(data) ? data[0] || null : null;
  return { request, error: null };
}

// Real, live counts per status — never hardcoded on the frontend.
export async function fetchAdminSupportCounts() {
  const { data, error } = await supabase.rpc('get_admin_support_counts');
  if (error) {
    console.error('fetchAdminSupportCounts error:', error);
    return { counts: null, error };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    counts: {
      open: Number(row?.open_count || 0),
      in_progress: Number(row?.in_progress_count || 0),
      resolved: Number(row?.resolved_count || 0),
      closed: Number(row?.closed_count || 0),
      total: Number(row?.total_count || 0),
    },
    error: null,
  };
}

// Moves a support request to a new status and/or updates the admin
// response. Plain `.update()` on `support_requests`, still gated by the
// existing "admin can update support requests" RLS policy (admin-only),
// and still the same UPDATE that trg_notify_support_request_update reacts
// to (database/customer_support_system.sql) — which only ever fires when
// status or admin_response actually changed, so saving neither leaves the
// user un-notified, exactly the "no meaningful change, no notification"
// behaviour used elsewhere in this app.
export async function updateAdminSupportRequest(request, { status, adminResponse }) {
  const { data: userData } = await supabase.auth.getUser();
  const adminId = userData?.user?.id;
  const trimmedResponse = typeof adminResponse === 'string' ? adminResponse.trim() : '';
  const isTransition = status !== request.status;
  const isClosingNow = isTransition && (status === 'resolved' || status === 'closed');

  const payload = {
    status,
    admin_response: trimmedResponse.length > 0 ? trimmedResponse : null,
    resolved_by: isClosingNow ? adminId : request.resolved_by,
    resolved_at: isClosingNow ? new Date().toISOString() : request.resolved_at,
  };

  const { error } = await supabase.from('support_requests').update(payload).eq('id', request.id);
  if (error) {
    console.error('updateAdminSupportRequest error:', error);
    return { error: { message: "We couldn't save this update right now. Please try again." } };
  }
  return { error: null };
}
