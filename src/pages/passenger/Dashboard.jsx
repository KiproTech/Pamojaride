import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';

function formatKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

const QUICK_ACTIONS = [
  { to: '/passenger/search', icon: '🔍', title: 'Find a trip', sub: 'Search intercity routes' },
  { to: '/passenger/bookings', icon: '🎫', title: 'My bookings', sub: 'View & manage bookings' },
  { to: '/passenger/profile', icon: '👤', title: 'Profile', sub: 'Update your details' },
];

export default function Dashboard() {
  const { user, profile } = useAuth();
  const [stats, setStats] = useState({ upcoming: 0, completedTrips: 0, totalSpent: 0 });
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let active = true;
    async function load() {
      const { data } = await supabase
        .from('bookings')
        .select('*, trips(origin, destination, departure_time)')
        .eq('passenger_id', user.id)
        .order('created_at', { ascending: false });
      if (!active) return;

      const rows = data || [];
      const upcomingRows = rows
        .filter(b => ['pending', 'confirmed'].includes(b.status))
        .sort((a, b) => new Date(a.trips?.departure_time) - new Date(b.trips?.departure_time));
      const completed = rows.filter(b => b.status === 'completed');
      const totalSpent = completed.reduce((s, b) => s + Number(b.total_price || 0), 0);

      setStats({ upcoming: upcomingRows.length, completedTrips: completed.length, totalSpent });
      setUpcoming(upcomingRows.slice(0, 3));
      setLoading(false);
    }
    load();
    return () => { active = false; };
  }, [user]);

  return (
    <DashboardLayout title="Dashboard">
      <div className="page-header">
        <h1>Welcome back{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''} 👋</h1>
        <p>Where are you headed next?</p>
      </div>

      <div className="grid-3" style={{ marginBottom: 28 }}>
        <StatCard label="Upcoming trips" value={loading ? '—' : stats.upcoming} />
        <StatCard label="Trips completed" value={loading ? '—' : stats.completedTrips} />
        <StatCard label="Total spent" value={loading ? '—' : formatKES(stats.totalSpent)} />
      </div>

      <div className="grid-3" style={{ marginBottom: 28 }}>
        {QUICK_ACTIONS.map(a => (
          <Link key={a.to} to={a.to} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card card-pad flex-center gap-12">
              <span style={{ fontSize: 24 }}>{a.icon}</span>
              <div>
                <strong style={{ fontSize: 14 }}>{a.title}</strong>
                <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{a.sub}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="card card-pad">
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16 }}>Upcoming trips</h3>
          <Link to="/passenger/bookings" className="btn btn-sm btn-ghost">View all</Link>
        </div>

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center' }}><span className="spinner" /></div>
        ) : upcoming.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🚌</div>
            <h3>No upcoming trips</h3>
            <p>Search for a trip to get moving.</p>
            <Link to="/passenger/search" className="btn btn-primary btn-sm" style={{ marginTop: 12 }}>Find a trip</Link>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {upcoming.map(b => (
              <div key={b.id} className="flex-between" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <strong style={{ fontSize: 13.5 }}>{b.trips?.origin} → {b.trips?.destination}</strong>
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {new Date(b.trips?.departure_time).toLocaleString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <span className="badge badge-teal">{b.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
