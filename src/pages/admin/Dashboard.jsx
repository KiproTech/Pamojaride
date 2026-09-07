import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';

export default function Dashboard() {
  const [stats, setStats] = useState({
    pendingKyc: 0, verifiedDrivers: 0, totalDrivers: 0, totalPassengers: 0,
    suspended: 0, banned: 0, openReports: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [
          pendingRes, verifiedRes, driversRes, passengersRes,
          driverSuspendedRes, passengerSuspendedRes,
          driverBannedRes, passengerBannedRes,
          reportsRes,
        ] = await Promise.all([
          supabase.from('driver_profiles').select('profile_id', { count: 'exact', head: true }).in('verification_status', ['pending_verification', 'under_review']),
          supabase.from('driver_profiles').select('profile_id', { count: 'exact', head: true }).eq('verification_status', 'verified'),
          supabase.from('driver_profiles').select('profile_id', { count: 'exact', head: true }),
          supabase.from('passenger_profiles').select('profile_id', { count: 'exact', head: true }),
          supabase.from('driver_profiles').select('profile_id', { count: 'exact', head: true }).eq('account_status', 'suspended'),
          supabase.from('passenger_profiles').select('profile_id', { count: 'exact', head: true }).eq('account_status', 'suspended'),
          supabase.from('driver_profiles').select('profile_id', { count: 'exact', head: true }).eq('account_status', 'banned'),
          supabase.from('passenger_profiles').select('profile_id', { count: 'exact', head: true }).eq('account_status', 'banned'),
          supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        ]);
        if (!active) return;
        setStats({
          pendingKyc: pendingRes.count || 0,
          verifiedDrivers: verifiedRes.count || 0,
          totalDrivers: driversRes.count || 0,
          totalPassengers: passengersRes.count || 0,
          // Suspension/ban is per role now (a driver suspension doesn't
          // imply a passenger suspension for the same identity), so this
          // is a count of role-accounts, not people.
          suspended: (driverSuspendedRes.count || 0) + (passengerSuspendedRes.count || 0),
          banned: (driverBannedRes.count || 0) + (passengerBannedRes.count || 0),
          openReports: reportsRes.count || 0,
        });
      } catch (err) {
        console.error('Admin dashboard load error:', err);
        if (active) setError('Some stats failed to load.');
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, []);

  return (
    <DashboardLayout title="Overview">
      <div className="page-header">
        <h1>Admin Overview</h1>
        <p>Platform health at a glance.</p>
      </div>

      {error && <div className="alert alert-amber" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="grid-4" style={{ marginBottom: 24 }}>
        <StatCard label="Pending KYC" value={loading ? '—' : stats.pendingKyc} highlight={stats.pendingKyc > 0} />
        <StatCard label="Verified drivers" value={loading ? '—' : stats.verifiedDrivers} />
        <StatCard label="Total drivers" value={loading ? '—' : stats.totalDrivers} />
        <StatCard label="Total passengers" value={loading ? '—' : stats.totalPassengers} />
      </div>

      <div className="grid-3" style={{ marginBottom: 32 }}>
        <StatCard label="Suspended accounts" value={loading ? '—' : stats.suspended} />
        <StatCard label="Banned accounts" value={loading ? '—' : stats.banned} />
        <Link to="/admin/reports" style={{ textDecoration: 'none', color: 'inherit' }}>
          <StatCard label="Open reports" value={loading ? '—' : stats.openReports} highlight={stats.openReports > 0} />
        </Link>
      </div>

      <div className="grid-4">
        <Link to="/admin/drivers/review" className="quick-action quick-action-primary" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="quick-action-icon">🪪</span>
          <div><strong>Review drivers</strong><p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>{stats.pendingKyc} awaiting decision</p></div>
        </Link>
        <Link to="/admin/users" className="quick-action" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="quick-action-icon">👥</span>
          <div><strong>Manage users</strong><p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Suspend, ban, or reactivate</p></div>
        </Link>
        <Link to="/admin/trips" className="quick-action" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="quick-action-icon">🗺️</span>
          <div><strong>Trip oversight</strong><p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Monitor active trips</p></div>
        </Link>
        <Link to="/admin/audit-log" className="quick-action" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="quick-action-icon">📋</span>
          <div><strong>Audit log</strong><p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Every admin action, recorded</p></div>
        </Link>
      </div>
    </DashboardLayout>
  );
}

function StatCard({ label, value, highlight }) {
  return (
    <div className="stat-card" style={highlight && value !== 0 && value !== '—' ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={highlight && value !== 0 && value !== '—' ? { color: 'var(--accent)' } : undefined}>{value}</div>
    </div>
  );
}
