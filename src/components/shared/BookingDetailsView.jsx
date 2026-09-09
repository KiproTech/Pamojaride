import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fetchPassengerBookingDetail, fetchDriverBookingDetail } from '../../lib/bookingDetails';
import { buildBookingReceiptPdf } from '../../lib/reports/receiptPdf';
import { fetchSupportContacts } from '../../lib/support/supportContacts';
import PdfPreviewModal from './PdfPreviewModal';

const BOOKING_STATUS_BADGE = {
  pending: 'badge-amber', confirmed: 'badge-teal', completed: 'badge-green',
  cancelled: 'badge-danger', no_show: 'badge-danger',
};
const BOOKING_STATUS_LABEL = {
  pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed',
  cancelled: 'Cancelled', no_show: 'No-show',
};
const TRIP_STATUS_BADGE = {
  scheduled: 'badge-teal', ongoing: 'badge-amber', completion_pending: 'badge-amber',
  completed: 'badge-green', cancelled: 'badge-danger', expired: 'badge-gray',
};
const TRIP_STATUS_LABEL = {
  scheduled: 'Scheduled', ongoing: 'Ongoing', completion_pending: 'Awaiting confirmation',
  completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired',
};

// A receipt is only meaningful once a fare was actually committed. Bookings
// that never got past 'pending' (or that were cancelled before ever being
// confirmed) have a total_price snapshot but no real trip behind them yet;
// everything else genuinely happened and its fare record is real.
const RECEIPT_ELIGIBLE_STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'];

function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Shared trip/booking detail + receipt view, used by both portals:
 *   - pages/passenger/BookingDetails.jsx (portal="passenger")
 *   - pages/driver/BookingDetails.jsx    (portal="driver")
 *
 * Loads by :bookingId from the URL via an ownership-checked RPC (see
 * database/booking_history_receipts.sql) that only ever returns a row when
 * the signed-in user owns that booking (as passenger) or that trip (as
 * driver). Editing the id in the URL to someone else's booking returns
 * nothing — rendered here as the same "not found" state as a genuinely
 * invalid id, so there is nothing to distinguish.
 */
export default function BookingDetailsView({ portal }) {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [generatingReceipt, setGeneratingReceipt] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const [preview, setPreview] = useState(null); // { url, filename }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const fetcher = portal === 'driver' ? fetchDriverBookingDetail : fetchPassengerBookingDetail;
    const { booking: data, error: err } = await fetcher(bookingId);
    if (err) {
      setError("We couldn't load this booking right now. Please try again.");
    } else {
      setBooking(data);
    }
    setLoading(false);
  }, [portal, bookingId]);

  useEffect(() => { load(); }, [load]);

  // Release the preview's blob URL on unmount / when a new one is generated.
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const backPath = `/${portal}/bookings`;

  async function handleGenerateReceipt() {
    if (!booking) return;
    setGeneratingReceipt(true);
    setReceiptError('');
    try {
      // fetchSupportContacts() never throws and falls back to an all-blank
      // row on error (see lib/support/supportContacts.js), so a support-
      // contacts fetch failure never blocks receipt generation — the
      // footer just falls back to the generic "visit the Support page"
      // message instead of showing a channel.
      const { contacts: supportContacts } = await fetchSupportContacts();
      const bytes = await buildBookingReceiptPdf({
        portal,
        booking,
        viewerName: profile?.full_name || '',
        supportContacts,
      });
      const filename = `pamojaride-receipt-${booking.booking_reference || booking.booking_id}.pdf`;
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      if (preview?.url) URL.revokeObjectURL(preview.url);
      setPreview({ url, filename });
    } catch (err) {
      console.error('Receipt generation failed:', err);
      setReceiptError('Could not generate the receipt. Please try again.');
    } finally {
      setGeneratingReceipt(false);
    }
  }

  function handleDownloadFromPreview() {
    if (!preview) return;
    const a = document.createElement('a');
    a.href = preview.url;
    a.download = preview.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function closePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

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

  if (!booking) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🔍</div>
        <h3>Booking not found</h3>
        <p>This booking doesn't exist, or isn't one you have access to.</p>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate(backPath)}>
          Back to {portal === 'driver' ? 'Bookings' : 'My Bookings'}
        </button>
      </div>
    );
  }

  const counterpartLabel = portal === 'passenger' ? 'Driver Information' : 'Passenger Information';
  const counterpartName = portal === 'passenger' ? booking.driver_name : booking.passenger_name;
  const counterpartPhone = portal === 'passenger' ? booking.driver_phone : booking.passenger_phone;
  const counterpartPicture = portal === 'passenger' ? booking.driver_profile_picture : booking.passenger_picture;
  const pickup = booking.booking_pickup_point || booking.trip_pickup_point;
  const dropoff = booking.booking_dropoff_point || booking.trip_dropoff_point;
  const receiptEligible = RECEIPT_ELIGIBLE_STATUSES.includes(booking.booking_status);

  return (
    <div>
      <button className="btn btn-sm btn-ghost no-print" style={{ marginBottom: 16 }} onClick={() => navigate(backPath)}>
        ← Back to {portal === 'driver' ? 'Bookings' : 'My Bookings'}
      </button>

      <div className="page-header">
        <h1>{booking.booking_reference}</h1>
        <p>Booked {formatDateTime(booking.booking_created_at)}</p>
      </div>

      {/* Trip Information */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="flex-between" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <h3 style={{ fontSize: 15 }}>Trip Information</h3>
          <span className={`badge ${TRIP_STATUS_BADGE[booking.trip_status] || 'badge-gray'}`}>
            {TRIP_STATUS_LABEL[booking.trip_status] || booking.trip_status}
          </span>
        </div>
        <p style={{ fontSize: 17, fontWeight: 700, margin: '0 0 12px' }}>{booking.origin} → {booking.destination}</p>
        <div className="grid-2" style={{ gap: 10 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Trip date &amp; departure time</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{formatDateTime(booking.departure_time)}</p>
          </div>
          {booking.estimated_arrival_time && (
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Estimated arrival</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{formatDateTime(booking.estimated_arrival_time)}</p>
            </div>
          )}
          {(pickup || dropoff) && (
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Pickup / Drop-off</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{pickup || '—'} → {dropoff || '—'}</p>
            </div>
          )}
          {(booking.vehicle_make || booking.vehicle_model) && (
            <div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Vehicle</p>
              <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>
                {[booking.vehicle_make, booking.vehicle_model].filter(Boolean).join(' ')}
                {booking.vehicle_plate ? ` · ${booking.vehicle_plate}` : ''}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Booking Information */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="flex-between" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <h3 style={{ fontSize: 15 }}>Booking Information</h3>
          <span className={`badge ${BOOKING_STATUS_BADGE[booking.booking_status] || 'badge-gray'}`}>
            {BOOKING_STATUS_LABEL[booking.booking_status] || booking.booking_status}
          </span>
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Booking reference</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{booking.booking_reference}</p>
          </div>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Booking date</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{formatDateTime(booking.booking_created_at)}</p>
          </div>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Seats booked</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{booking.seats_booked}</p>
          </div>
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Total fare</p>
            <p style={{ fontSize: 13.5, margin: '2px 0 0', fontWeight: 700 }}>{formatKES(booking.total_price)}</p>
          </div>
        </div>

        {booking.booking_status === 'cancelled' && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12 }}>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>
              Cancelled {formatDateTime(booking.cancelled_at)}
              {booking.cancellation_reason ? ` — ${booking.cancellation_reason}` : ''}
            </p>
            {booking.refund_status === 'pending' && (
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>💰 Refund pending review</p>
            )}
            {booking.refund_status === 'processed' && (
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>💰 Refund processed</p>
            )}
          </div>
        )}
      </div>

      {/* Driver Information (passenger view) / Passenger Information (driver view) */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>{counterpartLabel}</h3>
        {counterpartName ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              {counterpartPicture ? (
                <img src={counterpartPicture} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <span className="topbar-avatar" style={{ width: 44, height: 44, fontSize: 15, flexShrink: 0 }}>
                  {counterpartName.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                </span>
              )}
            </div>
            <div className="grid-2" style={{ gap: 10 }}>
              <div>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Name</p>
                <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{counterpartName}</p>
              </div>
              <div>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Phone</p>
                <p style={{ fontSize: 13.5, margin: '2px 0 0' }}>{counterpartPhone || '—'}</p>
              </div>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Not available for this booking.</p>
        )}
      </div>

      {/* Receipt */}
      <div className="card card-pad">
        <div className="flex-between" style={{ marginBottom: 12, alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h3 style={{ fontSize: 15 }}>Receipt</h3>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              A record of this booking's fare and status — generated on demand.
            </p>
          </div>
          {receiptEligible && (
            <button className="btn btn-sm btn-outline" disabled={generatingReceipt} onClick={handleGenerateReceipt}>
              {generatingReceipt ? <span className="spinner" /> : '🧾 View / Download Receipt'}
            </button>
          )}
        </div>
        {receiptError && <div className="alert alert-danger">{receiptError}</div>}
        {!receiptEligible && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            A receipt isn't available for a booking that's still pending.
          </p>
        )}
      </div>

      {preview && (
        <PdfPreviewModal
          title="Receipt preview"
          previewUrl={preview.url}
          onDownload={handleDownloadFromPreview}
          onClose={closePreview}
        />
      )}
    </div>
  );
}
