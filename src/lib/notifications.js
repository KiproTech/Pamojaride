import { supabase } from './supabase';

// ============================================================================
// Shared Notifications helpers — used by NotificationBell.jsx (dropdown
// preview) and NotificationsPage.jsx (full "My Notifications" list), so
// both surfaces read, mark-as-read, and navigate identically instead of
// maintaining two copies of this logic.
//
// Every read/write here goes through the `notifications` table directly,
// same as before this audit — the difference is that ownership is now
// ALSO enforced server-side by RLS (see
// database/notifications_center_hardening.sql), so the `.eq('user_id', …)`
// filters below are a query optimization, not the security boundary.
// Even if a caller edited them away or forged a different id, Postgres
// would simply return zero rows for anything that isn't the signed-in
// user's own — RLS ties every row to auth.uid(), not to anything the
// client sends.
// ============================================================================

export const NOTIFICATIONS_PAGE_SIZE = 20;

// A small per-type icon so a passenger scanning the list can tell a
// cancellation apart from an ordinary update at a glance. Purely cosmetic —
// falls back to a generic bell for any type not listed here. Shared so the
// bell dropdown and the full list page always agree.
const TYPE_ICON = {
  booking_created: '🎟️',
  booking_confirmed: '✅',
  booking_cancelled: '❌',
  booking_no_show: '⚠️',
  trip_started: '🚗',
  trip_cancelled: '🚫',
  trip_reminder: '⏰',
  trip_completion_pending: '🏁',
  trip_completed: '🏁',
  kyc_submitted: '🪪',
  kyc_approved: '✅',
  kyc_rejected: '⛔',
  verification_required: '🪪',
  account_suspended: '⛔',
  account_reactivated: '✅',
  account_banned: '⛔',
  rating_received: '⭐',
  complaint_submitted: '🚩',
  dispute_update: '📋',
  support_request_submitted: '🆘',
  support_update: '💬',
  admin_announcement: '📢',
};

export function iconFor(type) {
  return TYPE_ICON[type] || '🔔';
}

export function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Fetches one page of the signed-in user's own notifications, most recent
// first. `userId` narrows the query for efficiency only — RLS is what
// actually stops this from ever returning another user's row.
export async function fetchMyNotifications({ userId, offset = 0, limit = NOTIFICATIONS_PAGE_SIZE, unreadOnly = false }) {
  if (!userId) return { notifications: [], count: 0, error: null };

  let query = supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) query = query.eq('is_read', false);

  const { data, error, count } = await query;
  if (error) {
    console.error('fetchMyNotifications error:', error);
    return { notifications: [], count: 0, error };
  }
  return { notifications: data || [], count: count || 0, error: null };
}

// Marks a single notification read. Only ever affects the row if it's the
// caller's own (enforced by RLS's WITH CHECK, not by this .eq()).
export async function markNotificationRead(notificationId) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('is_read', false);
  if (error) console.error('markNotificationRead error:', error);
  return { error };
}

// Marks every unread notification belonging to the signed-in user as
// read, in one round trip. `userId` again is just a query filter — RLS
// scopes the actual UPDATE to auth.uid() regardless.
export async function markAllNotificationsRead(userId) {
  if (!userId) return { error: null };
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) console.error('markAllNotificationsRead error:', error);
  return { error };
}

// Where clicking a notification should take the user. Centralized here so
// the bell dropdown and the full list page can never disagree about
// routing. Returns null when a notification has no specific destination
// (falls back to just marking it read in place).
//
// 'trip_cancelled' is only ever sent to passengers (see cancel_trip() in
// database/passenger_trip_cancellation_notifications.sql).
//
// 'complaint_submitted' / 'dispute_update' go to admins, the reporter, and
// (on status changes) the reported party — see
// database/report_dispute_system_fix.sql and
// database/report_status_workflow_notifications.sql. Everyone but admins
// lands on their own My Reports detail page; get_my_reports() only ever
// returns a row when the signed-in user is that report's reporter, so a
// reported party simply sees "Report not found" rather than someone
// else's report.
//
// 'support_request_submitted' / 'support_update' are the Customer Support
// equivalent (database/customer_support_system.sql), same "only ever your
// own row" guarantee via get_my_support_requests().
export function notificationHref(notif, { isAdmin, portal }) {
  if (notif.type === 'trip_cancelled') {
    return { pathname: '/passenger/bookings', state: { tab: 'cancelled' } };
  }
  if (notif.type === 'complaint_submitted' || notif.type === 'dispute_update') {
    if (isAdmin) return { pathname: '/admin/reports' };
    const reportId = notif.data?.report_id;
    if (reportId && (portal === 'driver' || portal === 'passenger')) {
      return { pathname: `/${portal}/reports/${reportId}` };
    }
    return null;
  }
  if (notif.type === 'support_request_submitted' || notif.type === 'support_update') {
    if (isAdmin) return { pathname: '/admin/support' };
    const requestId = notif.data?.request_id;
    if (requestId && (portal === 'driver' || portal === 'passenger')) {
      return { pathname: `/${portal}/support/${requestId}` };
    }
    return null;
  }
  if (notif.type?.startsWith('booking_') && notif.data?.booking_id && (portal === 'driver' || portal === 'passenger')) {
    return { pathname: `/${portal}/bookings/${notif.data.booking_id}` };
  }
  if ((notif.type?.startsWith('trip_') || notif.type === 'rating_received') && notif.data?.trip_id && portal === 'passenger') {
    return { pathname: `/passenger/trips/${notif.data.trip_id}` };
  }
  if (notif.type?.startsWith('kyc_') || notif.type === 'verification_required') {
    return portal === 'driver' ? { pathname: '/driver/verification' } : null;
  }
  return null;
}
