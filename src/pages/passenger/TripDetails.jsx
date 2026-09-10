import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import BookingModal from '../../components/passenger/BookingModal';
import DriverPreviewCard from '../../components/passenger/DriverPreviewCard';
import ReviewsList from '../../components/shared/ReviewsList';
import SecurePaymentNotice from '../../components/shared/SecurePaymentNotice';
import { fetchTripDriverPreviews, fetchDriverReviews } from '../../lib/driverDetails';

function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

export default function TripDetails() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const [trip, setTrip] = useState(null);
  const [driverPreview, setDriverPreview] = useState(null);
  const [driverPreviewLoading, setDriverPreviewLoading] = useState(true);
  const [reviews, setReviews] = useState([]);
  const [reviewsTotal, setReviewsTotal] = useState(0);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewsError, setReviewsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showBooking, setShowBooking] = useState(false);
  const [justBooked, setJustBooked] = useState(false);

  // Re-fetches just the trip row (seats/status can change from this
  // passenger's own booking, or from someone else booking concurrently)
  // without re-running the driver-preview/reviews fetches every time.
  async function reloadTrip() {
    const { data: tripData, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).single();
    if (tripErr) return;
    setTrip(tripData);
  }

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      const { data: tripData, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).single();
      if (!active) return;
      if (tripErr) { setError('This trip could not be found.'); setLoading(false); return; }
      setTrip(tripData);
      setLoading(false);

      // Pre-booking driver trust preview (name, photo, rating, trust level,
      // verification, vehicle) — never exposes phone/KYC/PII. See
      // database/trip_search_driver_preview.sql.
      const previews = await fetchTripDriverPreviews([tripData.id]);
      if (active) {
        setDriverPreview(previews[tripData.id] || null);
        setDriverPreviewLoading(false);
      }

      // Rider reviews for this driver — publicly readable via a narrow RPC
      // that never exposes a reviewer's phone/email/full name. See
      // database/driver_reviews_display.sql.
      if (tripData.driver_id) {
        const { reviews: reviewRows, totalCount, error: reviewsErr } = await fetchDriverReviews(tripData.driver_id, { limit: 10 });
        if (active) {
          setReviews(reviewRows);
          setReviewsTotal(totalCount);
          setReviewsError(reviewsErr || '');
          setReviewsLoading(false);
        }
      } else if (active) {
        setReviewsLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, [tripId]);

  if (loading) {
    return <DashboardLayout title="Trip Details"><div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div></DashboardLayout>;
  }
  if (error || !trip) {
    return <DashboardLayout title="Trip Details"><div className="alert alert-danger">{error}</div></DashboardLayout>;
  }

  return (
    <DashboardLayout title="Trip Details">
      <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: 16 }}>← Back</button>

      {justBooked && (
        <div className="alert alert-success" style={{ marginBottom: 20 }}>
          🎉 Booking confirmed! Find it under <strong>My Bookings</strong>.
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="flex-between" style={{ alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, marginBottom: 4 }}>{trip.origin} → {trip.destination}</h1>
            <p style={{ color: 'var(--text-muted)' }}>
              {new Date(trip.departure_time).toLocaleString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
          <span className="badge badge-teal">{trip.status}</span>
        </div>

        <div className="grid-3" style={{ gap: 16, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Price per seat</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{formatKES(trip.price_per_seat)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Seats available</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{trip.available_seats} / {trip.total_seats}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Vehicle</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{trip.vehicle_make} {trip.vehicle_model}</div>
          </div>
        </div>

        {(trip.pickup_point || trip.dropoff_point) && (
          <div style={{ fontSize: 13.5, color: 'var(--text)', marginBottom: 12 }}>
            {trip.pickup_point && <div>📍 Pickup: {trip.pickup_point}</div>}
            {trip.dropoff_point && <div>🏁 Drop-off: {trip.dropoff_point}</div>}
          </div>
        )}

        {trip.notes && <p style={{ fontSize: 13.5, color: 'var(--text-muted)', marginBottom: 16 }}>{trip.notes}</p>}

        <div style={{ marginBottom: 16 }}>
          <SecurePaymentNotice />
        </div>

        {trip.status === 'scheduled' && trip.available_seats > 0 ? (
          <button className="btn btn-primary" onClick={() => setShowBooking(true)}>Book this trip</button>
        ) : (
          <div className="alert alert-amber">This trip is no longer available for booking.</div>
        )}
      </div>

      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Your driver</h3>
        <DriverPreviewCard preview={driverPreview} loading={driverPreviewLoading} />
        {driverPreview && typeof driverPreview.trips_completed === 'number' && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            {driverPreview.trips_completed} trip{driverPreview.trips_completed === 1 ? '' : 's'} completed on PamojaRide
          </p>
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 20 }}>
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 15 }}>Rider reviews</h3>
          {reviewsTotal > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {reviewsTotal} review{reviewsTotal === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <ReviewsList reviews={reviews} loading={reviewsLoading} error={reviewsError} />
      </div>

      {showBooking && (
        <BookingModal
          trip={trip}
          onClose={() => setShowBooking(false)}
          onSuccess={() => { setShowBooking(false); setJustBooked(true); reloadTrip(); }}
        />
      )}
    </DashboardLayout>
  );
}
