// Shared label/badge lookups for the Customer Support feature, reused by
// My Requests (passenger/driver) and Admin Support. These mirror the
// vocabulary enforced by the database check constraints
// (support_requests_category_check / support_requests_status_check — see
// database/customer_support_system.sql) rather than inventing new values
// on the frontend.

export const CATEGORY_LABELS = {
  booking_issue: 'Booking issue',
  trip_issue: 'Trip issue',
  payment_issue: 'Payment issue',
  account_issue: 'Account issue',
  safety_concern: 'Safety concern',
  technical_issue: 'Technical issue',
  other: 'Other',
};

export const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));

export const CATEGORY_FILTER_OPTIONS = [
  { value: 'all', label: 'All categories' },
  ...CATEGORY_OPTIONS,
];

export const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_BADGE = {
  open: 'badge-amber',
  in_progress: 'badge-teal',
  resolved: 'badge-green',
  closed: 'badge-gray',
};

export const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

export function formatSupportDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
