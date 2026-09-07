import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchMySupportBookings, submitSupportRequest } from '../../lib/support/support';
import { CATEGORY_OPTIONS, formatSupportDate } from '../../lib/support/supportLabels';

// Shared Contact Support form, used by both portals:
//   - pages/passenger/Support.jsx (portal="passenger")
//   - pages/driver/Support.jsx    (portal="driver")
//
// Inserts straight into the new `support_requests` table (database/
// customer_support_system.sql) — a general "help with my account/booking/
// payment/technical issue" channel, deliberately separate from
// `public.reports` (misconduct/safety complaints). The identity attached
// to the request always comes from the signed-in session (`userId` prop,
// sourced from useAuth() by the caller) — the user never types their own
// id anywhere. Ownership of any related booking is re-validated
// server-side by that table's INSERT policy regardless of what's
// selected here, so a manipulated booking id in the request simply gets
// rejected rather than silently attached to someone else's booking.
export default function ContactSupportForm({ userId, portal, onSubmitted }) {
  const navigate = useNavigate();
  const [bookings, setBookings] = useState([]);
  const [bookingsLoading, setBookingsLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [relatedId, setRelatedId] = useState(''); // booking_id, or '' for none
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBookingsLoading(true);
      const { bookings: data } = await fetchMySupportBookings();
      if (!cancelled) { setBookings(data); setBookingsLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  function resetForm() {
    setCategory('');
    setSubject('');
    setMessage('');
    setRelatedId('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return; // prevents accidental double-submit (e.g. double click / double Enter)
    setError('');

    if (!category) { setError('Please select a category.'); return; }
    if (!subject.trim()) { setError('Please add a short subject.'); return; }
    if (!message.trim()) { setError('Please describe what you need help with.'); return; }

    const selected = bookings.find(b => b.booking_id === relatedId);

    setSubmitting(true);
    const { error: err } = await submitSupportRequest({
      userId,
      category,
      subject,
      message,
      tripId: selected?.trip_id || null,
      bookingId: selected?.booking_id || null,
    });
    setSubmitting(false);

    if (err) { setError(err.message); return; }

    resetForm();
    setSuccess(true);
    if (onSubmitted) onSubmitted();
  }

  return (
    <div className="card card-pad">
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Submit a request</h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>
        Tell us what's going on and our support team will follow up. For misconduct or safety
        incidents involving another driver or passenger, use{' '}
        <button
          type="button"
          onClick={() => navigate(`/${portal}/bookings`)}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary-dark, #1D4ED8)', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', fontSize: 12.5 }}
        >
          Report an Issue
        </button>{' '}
        from the relevant booking instead — this keeps that report on record and reviewed by our
        trust &amp; safety team.
      </p>

      {success && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>
          Your request was submitted. We'll get back to you — you can track its status under "My Requests" below.
        </div>
      )}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="grid-2" style={{ gap: 14, marginBottom: 4 }}>
          <div className="form-group">
            <label className="form-label">Category <span style={{ color: 'var(--danger)' }}>*</span></label>
            <select className="form-select" value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">Select a category</option>
              {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Related booking/trip (optional)</label>
            <select
              className="form-select"
              value={relatedId}
              onChange={e => setRelatedId(e.target.value)}
              disabled={bookingsLoading || bookings.length === 0}
            >
              <option value="">
                {bookingsLoading ? 'Loading your bookings…' : bookings.length === 0 ? 'No bookings to attach' : 'None — general question'}
              </option>
              {bookings.map(b => (
                <option key={b.booking_id} value={b.booking_id}>
                  {b.booking_reference} · {b.origin} → {b.destination} · {formatSupportDate(b.departure_time)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {category === 'safety_concern' && (
          <div className="alert alert-amber" style={{ margin: '10px 0 4px' }}>
            Safety concerns are handled fastest through <strong>Report an Issue</strong>, which routes
            directly to our trust &amp; safety team. You can still submit this as a general support
            request, but for anything urgent or involving another person, please use Report an Issue
            from the relevant booking instead.
          </div>
        )}

        <div className="form-group" style={{ marginTop: 14 }}>
          <label className="form-label">Subject <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input
            className="form-input"
            value={subject}
            maxLength={120}
            onChange={e => setSubject(e.target.value)}
            placeholder="e.g. Refund not received for cancelled trip"
          />
        </div>

        <div className="form-group" style={{ marginTop: 14 }}>
          <label className="form-label">Message <span style={{ color: 'var(--danger)' }}>*</span></label>
          <textarea
            className="form-input"
            rows={5}
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Describe what you need help with, as specifically as you can."
          />
        </div>

        <button className="btn btn-primary btn-full" style={{ marginTop: 16 }} disabled={submitting} type="submit">
          {submitting ? <span className="spinner" /> : 'Submit request'}
        </button>
      </form>
    </div>
  );
}
