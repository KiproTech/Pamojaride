import { useState } from 'react';
import { supabase } from '../../lib/supabase';

// Shared trip-complaint form used by BOTH portals:
//   - passenger/MyBookings.jsx (passenger reporting a driver/trip issue) —
//     pass reportedRole="driver"
//   - driver/Bookings.jsx (driver reporting a passenger/trip issue) —
//     pass reportedRole="passenger"
//
// Inserts straight into the existing `reports` table (the same table that
// already backs admin/Reports.jsx and the ban/suspension appeal flow in
// status/Banned.jsx) — no new table, no new "complaints" system. The insert
// is only ever allowed by RLS when `reporter_id` is the caller themselves
// and (when a trip is attached) the caller is actually a driver or
// passenger on that trip — see
// database/trip_complaints_admin_alerts_cancellation_history.sql. A new
// complaint always starts life as 'open'; only an admin can move it to
// under_review / resolved / closed, from admin/Reports.jsx.
//
// Submitting also fires TWO notifications automatically (a database
// trigger on `reports`, not anything in this component) — every admin,
// and the reported driver/passenger themselves (generic, reporter-
// anonymous wording) — see database/report_dispute_system_fix.sql.
//
// Category list is role-specific per PamojaRide's report brief: a
// passenger reporting a driver sees driving/arrival/vehicle-flavoured
// categories, a driver reporting a passenger sees no-show/booking-flavoured
// ones. Both lists write into the SAME `category` column/enum — see
// report_dispute_system_fix.sql for the full accepted value list.
const CATEGORIES_FOR_DRIVER_REPORT = [
  { value: 'reckless_driving', label: 'Unsafe driving or safety concern' },
  { value: 'driver_no_show', label: 'Driver did not arrive' },
  { value: 'inappropriate_behaviour', label: 'Inappropriate behaviour' },
  { value: 'trip_dispute', label: 'Trip-related dispute' },
  { value: 'vehicle_mismatch', label: 'Vehicle issue' },
  { value: 'communication_problem', label: 'Driver communication problem' },
  { value: 'other', label: 'Other' },
];

const CATEGORIES_FOR_PASSENGER_REPORT = [
  { value: 'passenger_no_show', label: 'Passenger did not show up' },
  { value: 'inappropriate_behaviour', label: 'Inappropriate behaviour' },
  { value: 'safety', label: 'Safety concern' },
  { value: 'trip_dispute', label: 'Trip-related dispute' },
  { value: 'communication_problem', label: 'Passenger communication problem' },
  { value: 'booking_issue', label: 'Booking-related problem' },
  { value: 'other', label: 'Other' },
];

// Fallback for any caller that doesn't specify a role (keeps this
// component backward-compatible if something else ever imports it).
const GENERIC_CATEGORIES = [
  { value: 'safety', label: 'Safety concern' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'no_show', label: 'No-show' },
  { value: 'payment_dispute', label: 'Payment dispute' },
  { value: 'vehicle_mismatch', label: "Vehicle didn't match listing" },
  { value: 'reckless_driving', label: 'Reckless driving' },
  { value: 'fake_profile', label: 'Suspicious / fake profile' },
  { value: 'other', label: 'Other' },
];

export default function ReportModal({ reporterId, tripId, bookingId, reportedUserId, reportedRole, onClose, onSuccess }) {
  const categories = reportedRole === 'driver' ? CATEGORIES_FOR_DRIVER_REPORT
    : reportedRole === 'passenger' ? CATEGORIES_FOR_PASSENGER_REPORT
    : GENERIC_CATEGORIES;
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!category || !description.trim()) { setError('Please select a category and describe what happened.'); return; }
    if (!reporterId) { setError('You must be signed in to submit a report.'); return; }
    setSubmitting(true); setError('');

    // reporter_id is REQUIRED — the `reports` table's INSERT policy checks
    // `reporter_id = auth.uid()`, and the column itself is NOT NULL with no
    // database default, so omitting it here is exactly what previously
    // caused every submission to be rejected (RLS/not-null violation ->
    // 403 from PostgREST). reporterId is passed down from the caller,
    // which already has the signed-in user's id from useAuth() — same
    // pattern RatingModal.jsx uses for rater_id.
    const { error: err } = await supabase.from('reports').insert({
      reporter_id: reporterId,
      reported_user_id: reportedUserId || null,
      trip_id: tripId || null,
      booking_id: bookingId || null,
      category,
      description: description.trim(),
    });
    setSubmitting(false);
    if (err) {
      // Unique violation from uq_reports_open_reporter_booking (see
      // database/report_relationship_and_duplicate_hardening.sql) — the
      // user already has an open report on this exact booking.
      if (err.code === '23505') {
        setError("You've already submitted a report for this booking and it's still under review. Our team will follow up soon.");
      } else {
        setError(err.message);
      }
      return;
    }
    onSuccess();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Report an issue</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

        <div className="form-group">
          <label className="form-label">What happened?</label>
          <select className="form-select" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Select a category</option>
            {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Details</label>
          <textarea className="form-input" rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="Describe what happened, as specifically as you can." />
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 16 }}>
          Our support team reviews every report. Repeat or serious issues affect a driver's trust level.
        </p>

        <button className="btn btn-primary btn-full" disabled={submitting} onClick={handleSubmit}>
          {submitting ? <span className="spinner" /> : 'Submit report'}
        </button>
      </div>
    </div>
  );
}
