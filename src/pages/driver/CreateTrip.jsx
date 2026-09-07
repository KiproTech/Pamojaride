import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import TripForm from '../../components/driver/TripForm';
import { estimateArrival } from '../../lib/location';

// Maps known failure modes to a friendly message instead of showing a raw
// Postgres/Supabase error string to the driver. Note: the scheduling-limit
// trigger (enforce_trip_scheduling_limits) already raises its own
// human-readable messages ("You already have 2 scheduled trips...",
// "Your next trip can start from ...") — those pass straight through the
// fallback below unchanged, since they're already exactly what we'd want
// to show.
function friendlyInsertError(insertError) {
  const msg = insertError?.message || '';
  if (insertError?.code === '23514' || /check constraint/i.test(msg)) {
    return "Some of the trip details didn't look valid (e.g. price, seats, or route). Please review the form and try again.";
  }
  if (/network|fetch/i.test(msg)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return insertError?.message || 'Something went wrong while posting your trip. Please try again.';
}

export default function CreateTrip() {
  const { user, driverProfile, isDriverVerified } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Passed down to TripForm so it can show the max-2/overlap/buffer verdict
  // live, before the driver even submits. This calls the same
  // check_trip_schedule_availability RPC that mirrors the BEFORE INSERT
  // trigger's logic — it's a read-only pre-check, not the source of truth;
  // the trigger re-checks everything again at actual insert time below.
  const checkAvailability = useCallback(async (departureIso, estimatedArrivalIso) => {
    const { data, error: rpcError } = await supabase.rpc('check_trip_schedule_availability', {
      p_departure_time: departureIso,
      p_estimated_arrival_time: estimatedArrivalIso,
    });
    if (rpcError) throw rpcError;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { allowed: row.allowed, reason: row.reason };
  }, []);

  async function handleSubmit(form) {
    setError('');

    const departure = new Date(form.departure_time);
    if (!form.departure_time || Number.isNaN(departure.getTime())) {
      setError('Please choose a valid departure date & time.');
      return;
    }
    if (departure <= new Date()) {
      setError('Departure time must be in the future.');
      return;
    }

    // Defense-in-depth: TripForm already blocks submission until both
    // locations are picked, distinct, and a route was calculated, but
    // re-check here since this is the actual write path.
    if (!form.origin_lat || !form.destination_lat || !form.route_distance_km || !form.route_duration_minutes) {
      setError('Pickup, destination, and route must be validated before posting a trip.');
      return;
    }

    setSubmitting(true);

    const totalSeats = parseInt(form.total_seats, 10);
    const estimatedArrival = estimateArrival(departure, form.route_duration_minutes);

    // Re-check scheduling availability immediately before saving (on top of
    // TripForm's live check and the database trigger) to catch the common
    // case — another trip changed status, or time passed — with a friendly
    // message before even attempting the write. The trigger below remains
    // the actual, race-condition-proof authority.
    try {
      const availability = await checkAvailability(departure.toISOString(), estimatedArrival.toISOString());
      if (availability && !availability.allowed) {
        setSubmitting(false);
        setError(availability.reason || 'This trip cannot be scheduled right now.');
        return;
      }
    } catch (availabilityError) {
      // Don't hard-block on a failed pre-check (e.g. transient network
      // issue) — the trigger will still enforce the real rule on insert.
      console.warn('Availability pre-check failed, relying on database trigger:', availabilityError);
    }

    const { error: insertError } = await supabase.from('trips').insert({
      driver_id: user.id,
      origin: form.origin.trim(),
      destination: form.destination.trim(),
      origin_lat: form.origin_lat,
      origin_lng: form.origin_lng,
      destination_lat: form.destination_lat,
      destination_lng: form.destination_lng,
      route_distance_km: form.route_distance_km,
      route_duration_minutes: form.route_duration_minutes,
      pickup_point: form.pickup_point.trim() || null,
      dropoff_point: form.dropoff_point.trim() || null,
      departure_time: departure.toISOString(),
      estimated_arrival_time: estimatedArrival.toISOString(),
      price_per_seat: parseFloat(form.price_per_seat),
      total_seats: totalSeats,
      available_seats: totalSeats,
      // Vehicle snapshot, per design: a trip's advertised vehicle doesn't
      // change if the driver edits their profile's vehicle later.
      vehicle_make: driverProfile?.vehicle_make,
      vehicle_model: driverProfile?.vehicle_model,
      vehicle_plate: driverProfile?.vehicle_plate,
      vehicle_color: driverProfile?.vehicle_color,
      notes: form.notes.trim() || null,
    });

    setSubmitting(false);
    if (insertError) {
      console.error('CreateTrip insert error:', insertError);
      setError(friendlyInsertError(insertError));
      return;
    }
    navigate('/driver/trips');
  }

  if (!isDriverVerified) {
    return (
      <DashboardLayout title="Post a Trip">
        <div className="alert alert-amber">
          🔒 You need to complete driver verification before you can post a trip.
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Post a Trip">
      <div className="page-header">
        <h1>Post a Trip</h1>
        <p>Fill your empty seats and start earning.</p>
      </div>
      <div className="card card-pad" style={{ maxWidth: 640 }}>
        <TripForm
          profile={driverProfile}
          onSubmit={handleSubmit}
          onCheckAvailability={checkAvailability}
          submitting={submitting}
          error={error}
        />
      </div>
    </DashboardLayout>
  );
}
