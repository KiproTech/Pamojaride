// Shared label/badge lookups for report status + category, reused by both
// My Reports (passenger/driver) and, where useful, admin/Reports.jsx.
// These mirror the vocab already enforced by the database check
// constraints (reports_status_check / reports_category_check — see
// database/trip_complaints_admin_alerts_cancellation_history.sql and
// database/report_dispute_system_fix.sql) rather than inventing new
// statuses or categories.

export const STATUS_LABELS = {
  open: 'Open',
  under_review: 'Under Review',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_BADGE = {
  open: 'badge-amber',
  under_review: 'badge-teal',
  resolved: 'badge-green',
  closed: 'badge-gray',
};

export const CATEGORY_LABELS = {
  safety: 'Safety',
  harassment: 'Harassment',
  no_show: 'No-show',
  payment_dispute: 'Payment dispute',
  fake_profile: 'Fake profile',
  vehicle_mismatch: 'Vehicle issue',
  reckless_driving: 'Unsafe driving / safety',
  driver_no_show: 'Driver did not arrive',
  passenger_no_show: 'Passenger did not show up',
  trip_dispute: 'Trip-related dispute',
  communication_problem: 'Communication problem',
  inappropriate_behaviour: 'Inappropriate behaviour',
  booking_issue: 'Booking-related problem',
  other: 'Other',
};

// The full, real status workflow, in order — used to render a simple
// progress timeline. 'closed' is shown as an alternate end-state to
// 'resolved', never as a step every report must pass through.
export const STATUS_ORDER = ['open', 'under_review', 'resolved'];

// Role labels reused by the Admin Reports page (list + detail) for the
// `reporter_role` / `reported_role` values computed server-side by
// get_admin_reports() (database/admin_reports_management.sql).
export const ROLE_LABELS = {
  driver: 'Driver',
  passenger: 'Passenger',
  appellant: 'Appellant',
};

// Dropdown option lists, generated from the same canonical maps above so
// the Admin Reports filters can never drift from the real, database-backed
// status/category vocabulary.
export const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

export const CATEGORY_FILTER_OPTIONS = [
  { value: 'all', label: 'All categories' },
  ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
];

export const ROLE_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'driver', label: 'Driver' },
  { value: 'passenger', label: 'Passenger' },
];

export const REPORTER_ROLE_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'driver', label: 'Driver' },
  { value: 'passenger', label: 'Passenger' },
  { value: 'appellant', label: 'Appellant (account appeal)' },
];

export function formatReportDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
