import { supabase } from '../supabase';

// Data-fetching helpers for Admin Analytics (Admin → Analytics). Every read
// goes through the RPCs added by database/admin_performance_analytics.sql —
// never a raw `.select()` against trips/bookings/profiles — because those
// RPCs (a) re-check admin authorization server-side themselves, (b) resolve
// cross-user aggregates that RLS would otherwise block a client-side query
// from ever seeing, and (c) do the counting/averaging in the database
// instead of pulling whole tables into the browser. This mirrors the exact
// pattern already used by lib/reports/adminReports.js for the Reports &
// Appeals queue.
//
// Every function here returns { data, error } and never throws — a failed
// fetch degrades to an error state in the UI instead of crashing the page.

/**
 * Named, non-overlapping date ranges for the period picker. `key: 'all'`
 * means "no filter" (both bounds null) rather than an arbitrarily old
 * start date, so "All time" is actually all time.
 */
export const DATE_RANGE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'ytd', label: 'This year' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom range' },
];

/**
 * Resolves a preset key (or explicit custom bounds) to concrete
 * { dateFrom, dateTo } ISO strings (or null for open-ended), using the
 * caller's local timezone for "Today"/"This year" boundaries.
 *
 * @param {string} presetKey - one of DATE_RANGE_PRESETS' keys
 * @param {{ from?: string, to?: string }} [custom] - yyyy-mm-dd strings,
 *   only read when presetKey === 'custom'
 */
export function resolveDateRange(presetKey, custom = {}) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (presetKey) {
    case 'today':
      return { dateFrom: startOfToday.toISOString(), dateTo: now.toISOString() };
    case '7d': {
      const from = new Date(startOfToday);
      from.setDate(from.getDate() - 6);
      return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
    }
    case '30d': {
      const from = new Date(startOfToday);
      from.setDate(from.getDate() - 29);
      return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
    }
    case '90d': {
      const from = new Date(startOfToday);
      from.setDate(from.getDate() - 89);
      return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
    }
    case 'ytd': {
      const from = new Date(now.getFullYear(), 0, 1);
      return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
    }
    case 'custom': {
      const from = custom.from ? new Date(`${custom.from}T00:00:00`) : null;
      const to = custom.to ? new Date(`${custom.to}T23:59:59.999`) : null;
      return { dateFrom: from ? from.toISOString() : null, dateTo: to ? to.toISOString() : null };
    }
    case 'all':
    default:
      return { dateFrom: null, dateTo: null };
  }
}

/** Human-readable label for the currently-resolved range, for report headers. */
export function describeDateRange(presetKey, custom = {}) {
  const preset = DATE_RANGE_PRESETS.find(p => p.key === presetKey);
  if (presetKey === 'custom') {
    if (!custom.from && !custom.to) return 'All time';
    return `${custom.from || '…'} to ${custom.to || '…'}`;
  }
  return preset ? preset.label : 'All time';
}

async function callRpc(name, params) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) {
    console.error(`${name} error:`, error);
    return { data: null, error };
  }
  return { data, error: null };
}

/** All-time platform totals (Overview tab). Not date-filtered. */
export async function fetchPlatformOverview() {
  const { data, error } = await callRpc('get_admin_platform_overview', {});
  return { overview: data?.[0] || null, error };
}

/** Trip Performance tab. */
export async function fetchTripPerformance({ dateFrom, dateTo }) {
  const { data, error } = await callRpc('get_admin_trip_performance', {
    p_date_from: dateFrom, p_date_to: dateTo,
  });
  return { performance: data?.[0] || null, error };
}

/** Booking/Passenger Performance tab. */
export async function fetchBookingPerformance({ dateFrom, dateTo }) {
  const { data, error } = await callRpc('get_admin_booking_performance', {
    p_date_from: dateFrom, p_date_to: dateTo,
  });
  return { performance: data?.[0] || null, error };
}

/** Driver Performance tab + Driver Performance Report export. */
export async function fetchDriverPerformance({ dateFrom, dateTo }) {
  const { data, error } = await callRpc('get_admin_driver_performance', {
    p_date_from: dateFrom, p_date_to: dateTo,
  });
  return { drivers: data || [], error };
}

/** Trip Performance Report export listing. */
export async function fetchTripPerformanceReport({ dateFrom, dateTo }) {
  const { data, error } = await callRpc('get_admin_trip_performance_report', {
    p_date_from: dateFrom, p_date_to: dateTo,
  });
  return { trips: data || [], error };
}

/** Booking Report export listing. */
export async function fetchBookingReport({ dateFrom, dateTo }) {
  const { data, error } = await callRpc('get_admin_booking_report', {
    p_date_from: dateFrom, p_date_to: dateTo,
  });
  return { bookings: data || [], error };
}

/** Day-bucketed activity counts for the Performance tab's trend charts. */
export async function fetchDailyActivity({ dateFrom, dateTo }) {
  const { data, error } = await callRpc('get_admin_daily_activity', {
    p_date_from: dateFrom, p_date_to: dateTo,
  });
  return { days: data || [], error };
}
