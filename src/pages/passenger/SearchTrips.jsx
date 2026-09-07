import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import TripSearchForm from '../../components/passenger/TripSearchForm';
import TripCard from '../../components/shared/TripCard';
import DriverPreviewCard from '../../components/passenger/DriverPreviewCard';
import { fetchTripDriverPreviews } from '../../lib/driverDetails';

export default function SearchTrips() {
  const navigate = useNavigate();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [driverPreviews, setDriverPreviews] = useState({}); // tripId -> get_trip_driver_previews row
  const [driverPreviewsLoading, setDriverPreviewsLoading] = useState(false);

  async function runSearch(filters) {
    setLoading(true); setError(''); setSearched(true);
    // RLS already restricts this to status='scheduled' trips for non-owners.
    let query = supabase
      .from('trips')
      .select('*')
      .eq('status', 'scheduled')
      .gt('available_seats', 0)
      .gt('departure_time', new Date().toISOString())
      .order('departure_time', { ascending: true });

    if (filters.origin) query = query.ilike('origin', `%${filters.origin}%`);
    if (filters.destination) query = query.ilike('destination', `%${filters.destination}%`);
    if (filters.date) {
      const start = `${filters.date}T00:00:00`;
      const end = `${filters.date}T23:59:59`;
      query = query.gte('departure_time', start).lte('departure_time', end);
    }
    if (filters.maxPrice) query = query.lte('price_per_seat', parseFloat(filters.maxPrice));
    if (filters.minSeats) query = query.gte('available_seats', parseInt(filters.minSeats, 10));

    const { data, error: err } = await query;
    setLoading(false);
    if (err) { setError(err.message); return; }

    const results = data || [];
    setTrips(results);

    // One round trip for the whole results page, not one request per card.
    setDriverPreviewsLoading(true);
    fetchTripDriverPreviews(results.map(t => t.id)).then(previews => {
      setDriverPreviews(previews);
      setDriverPreviewsLoading(false);
    });
  }

  // Run an unfiltered search on first load so the page isn't empty.
  useEffect(() => { runSearch({}); }, []);

  return (
    <DashboardLayout title="Find a Trip">
      <div className="page-header">
        <h1>Find a Trip</h1>
        <p>Search intercity trips posted by verified drivers.</p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <TripSearchForm onSearch={runSearch} loading={loading} />
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
      ) : trips.length === 0 && searched ? (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <h3>No trips found</h3>
          <p>Try widening your search — a different date or route.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {trips.map(trip => (
            <TripCard
              key={trip.id}
              trip={trip}
              driverPreview={
                <DriverPreviewCard
                  preview={driverPreviews[trip.id] || null}
                  loading={driverPreviewsLoading && !driverPreviews[trip.id]}
                  compact
                />
              }
              actions={
                <button className="btn btn-sm btn-primary" onClick={() => navigate(`/passenger/trips/${trip.id}`)}>
                  View & Book
                </button>
              }
            />
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
