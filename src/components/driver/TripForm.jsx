import { useEffect, useRef, useState } from 'react';
import LocationAutocomplete from '../shared/LocationAutocomplete';
import { getRoute, estimateArrival, formatDuration, isSameLocation, LocationServiceError } from '../../lib/location';

function todayLocalMin() {
  const d = new Date(Date.now() + 30 * 60000); // at least 30 min from now
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// route: { status: 'idle' | 'loading' | 'ready' | 'error', distanceKm, durationMinutes, source, arrival, message }
const IDLE_ROUTE = { status: 'idle' };
// availability: { status: 'idle' | 'checking' | 'ok' | 'blocked' | 'error', message }
const IDLE_AVAILABILITY = { status: 'idle' };

// `onCheckAvailability` is optional: a function (departureIso, estimatedArrivalIso)
// => Promise<{ allowed, reason }> that the parent wires up to the
// check_trip_schedule_availability RPC. When both a valid route and a
// departure time are set, this form calls it so the driver sees the
// overlap / buffer verdict (with the exact "earliest start" message) before
// they even try to submit — the same rule the database enforces at insert
// time, just surfaced earlier for a better experience.
export default function TripForm({ profile, initialValues, onSubmit, onCheckAvailability, submitting, submitLabel = 'Post trip', error }) {
  const [originPlace, setOriginPlace] = useState(initialValues?.originPlace || null);
  const [destinationPlace, setDestinationPlace] = useState(initialValues?.destinationPlace || null);
  const [locationError, setLocationError] = useState(''); // same-location / missing-selection errors
  const [route, setRoute] = useState(IDLE_ROUTE);
  const routeRequestId = useRef(0);
  const [availability, setAvailability] = useState(IDLE_AVAILABILITY);
  const availabilityRequestId = useRef(0);

  const [form, setForm] = useState({
    pickup_point: initialValues?.pickup_point || '',
    dropoff_point: initialValues?.dropoff_point || '',
    departure_time: initialValues?.departure_time || '',
    price_per_seat: initialValues?.price_per_seat || '',
    total_seats: initialValues?.total_seats || profile?.vehicle_seats || 1,
    notes: initialValues?.notes || '',
  });

  function set(field) { return e => setForm(f => ({ ...f, [field]: e.target.value })); }

  // Recalculate the route whenever both locations are validly picked and
  // aren't the same place. This keeps the estimate (and the arrival-time
  // preview) in sync with what will actually be saved on submit, rather
  // than only computing it at the last second.
  useEffect(() => {
    if (!originPlace || !destinationPlace) { setRoute(IDLE_ROUTE); return; }
    if (isSameLocation(originPlace, destinationPlace)) { setRoute(IDLE_ROUTE); return; }

    const requestId = ++routeRequestId.current;
    setRoute({ status: 'loading' });
    getRoute(originPlace, destinationPlace)
      .then(result => {
        if (routeRequestId.current !== requestId) return; // a newer request superseded this one
        setRoute({ status: 'ready', ...result });
      })
      .catch(err => {
        if (routeRequestId.current !== requestId) return;
        setRoute({
          status: 'error',
          message: err instanceof LocationServiceError
            ? err.message
            : "Couldn't calculate the route between these locations. Please try again.",
        });
      });
  }, [originPlace?.id, destinationPlace?.id]);

  const sameLocation = originPlace && destinationPlace && isSameLocation(originPlace, destinationPlace);
  const arrival = route.status === 'ready' && form.departure_time
    ? estimateArrival(new Date(form.departure_time), route.durationMinutes)
    : null;

  // Once we have a computed route AND a departure time, ask the backend
  // whether this slot overlaps any of the driver's other open trips
  // (with a 1h30 safety buffer). Debounced so changing the date/time
  // picker doesn't fire a request per keystroke.
  useEffect(() => {
    if (!onCheckAvailability || route.status !== 'ready' || !form.departure_time) {
      setAvailability(IDLE_AVAILABILITY);
      return;
    }
    const departure = new Date(form.departure_time);
    if (Number.isNaN(departure.getTime())) { setAvailability(IDLE_AVAILABILITY); return; }
    const estimatedArrival = estimateArrival(departure, route.durationMinutes);

    const requestId = ++availabilityRequestId.current;
    setAvailability({ status: 'checking' });
    const timer = setTimeout(() => {
      onCheckAvailability(departure.toISOString(), estimatedArrival.toISOString())
        .then(result => {
          if (availabilityRequestId.current !== requestId) return;
          if (!result) { setAvailability(IDLE_AVAILABILITY); return; }
          setAvailability(result.allowed
            ? { status: 'ok' }
            : { status: 'blocked', message: result.reason });
        })
        .catch(() => {
          if (availabilityRequestId.current !== requestId) return;
          setAvailability({ status: 'error', message: "Couldn't check your scheduling limits right now." });
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [route.status, route.durationMinutes, form.departure_time, onCheckAvailability]);

  function handleSubmit(e) {
    e.preventDefault();
    setLocationError('');

    if (!originPlace || !destinationPlace) {
      setLocationError('Please select both a pickup and a destination from the suggestions before posting.');
      return;
    }
    if (sameLocation) {
      setLocationError('Pickup and destination cannot be the same location. Please choose two different places.');
      return;
    }
    if (!form.departure_time) {
      setLocationError('Please choose a departure date & time.');
      return;
    }
    if (route.status === 'loading') {
      setLocationError('Still calculating the route — please wait a moment and try again.');
      return;
    }
    if (route.status !== 'ready') {
      setLocationError(route.message || "Couldn't calculate the route between these locations. Please try again.");
      return;
    }
    if (availability.status === 'checking') {
      setLocationError('Still checking your trip schedule — please wait a moment and try again.');
      return;
    }
    if (availability.status === 'blocked') {
      setLocationError(availability.message);
      return;
    }

    onSubmit({
      ...form,
      origin: originPlace.fullLabel,
      destination: destinationPlace.fullLabel,
      origin_lat: originPlace.lat,
      origin_lng: originPlace.lon,
      destination_lat: destinationPlace.lat,
      destination_lng: destinationPlace.lon,
      route_distance_km: route.distanceKm,
      route_duration_minutes: route.durationMinutes,
      route_source: route.source,
    });
  }

  // Seats offered can never exceed the driver's own registered vehicle
  // capacity — enforced again, as the real source of truth, by
  // enforce_trip_seat_capacity() in the database (see
  // database/driver_trip_and_seat_restrictions.sql). There is no other,
  // arbitrary/trust-level cap: a driver with a 14-seat matatu can offer
  // up to 14 seats, not a fixed platform maximum.
  const maxSeats = profile?.vehicle_seats || 0;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <div className="alert alert-danger">{error}</div>}
      {locationError && <div className="alert alert-danger">{locationError}</div>}

      <div className="grid-2" style={{ gap: 14 }}>
        <LocationAutocomplete
          label="From (pickup)"
          placeholder="e.g. Nairobi"
          value={originPlace}
          onChange={setOriginPlace}
        />
        <LocationAutocomplete
          label="To (destination)"
          placeholder="e.g. Kisumu"
          value={destinationPlace}
          onChange={setDestinationPlace}
        />
      </div>

      {sameLocation && (
        <div className="alert alert-amber" style={{ fontSize: 13 }}>
          ⚠️ Pickup and destination look like the same location. Please choose two different places.
        </div>
      )}

      {!sameLocation && route.status === 'loading' && (
        <div className="alert alert-info" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spinner" /> Calculating route distance and travel time…
        </div>
      )}
      {!sameLocation && route.status === 'error' && (
        <div className="alert alert-danger" style={{ fontSize: 13 }}>⚠️ {route.message}</div>
      )}
      {!sameLocation && route.status === 'ready' && (
        <div className="alert alert-info" style={{ fontSize: 13 }}>
          🛣️ ~{route.distanceKm} km · {formatDuration(route.durationMinutes)} drive
          {route.source === 'estimated' ? ' (approximate — live routing unavailable)' : ''}
          {arrival && (
            <> · Estimated arrival <strong>{arrival.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</strong></>
          )}
        </div>
      )}

      {availability.status === 'checking' && (
        <div className="alert alert-info" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spinner" /> Checking your trip schedule…
        </div>
      )}
      {availability.status === 'blocked' && (
        <div className="alert alert-danger" style={{ fontSize: 13 }}>⛔ {availability.message}</div>
      )}
      {availability.status === 'error' && (
        <div className="alert alert-amber" style={{ fontSize: 13 }}>⚠️ {availability.message}</div>
      )}
      {availability.status === 'ok' && (
        <div className="alert alert-success" style={{ fontSize: 13 }}>
          ✅ This slot fits your schedule.
        </div>
      )}

      <div className="grid-2" style={{ gap: 14 }}>
        <div className="form-group">
          <label className="form-label">Pickup point <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input className="form-input" value={form.pickup_point} onChange={set('pickup_point')} placeholder="e.g. Nyayo Stadium" />
        </div>
        <div className="form-group">
          <label className="form-label">Drop-off point <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input className="form-input" value={form.dropoff_point} onChange={set('dropoff_point')} placeholder="e.g. Kondele" />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Departure date & time</label>
        <input className="form-input" type="datetime-local" min={todayLocalMin()} value={form.departure_time} onChange={set('departure_time')} required />
      </div>

      <div className="grid-2" style={{ gap: 14 }}>
        <div className="form-group">
          <label className="form-label">Price per seat (KES)</label>
          <input className="form-input" type="number" min="1" step="1" value={form.price_per_seat} onChange={set('price_per_seat')} placeholder="e.g. 800" required />
        </div>
        <div className="form-group">
          <label className="form-label">Seats to offer</label>
          {maxSeats > 0 ? (
            <>
              <select className="form-select" value={form.total_seats} onChange={set('total_seats')} required>
                {Array.from({ length: maxSeats }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>{n} seat{n > 1 ? 's' : ''}</option>
                ))}
              </select>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                Limited to your vehicle's capacity ({maxSeats} seat{maxSeats > 1 ? 's' : ''}).
              </p>
            </>
          ) : (
            <p style={{ fontSize: 12.5, color: 'var(--red)' }}>
              Your vehicle's seat capacity isn't set yet — update it in your profile before posting a trip.
            </p>
          )}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Notes <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
        <textarea className="form-input" rows={3} value={form.notes} onChange={set('notes')} placeholder="e.g. AC available, one stop in Nakuru" />
      </div>

      <div className="alert alert-info" style={{ fontSize: 13 }}>
        🚗 Posting as {profile?.vehicle_make} {profile?.vehicle_model} · {profile?.vehicle_plate}
      </div>

      <button className="btn btn-primary" disabled={submitting || maxSeats === 0 || availability.status === 'checking' || availability.status === 'blocked'}>
        {submitting ? <span className="spinner" /> : submitLabel}
      </button>
    </form>
  );
}
