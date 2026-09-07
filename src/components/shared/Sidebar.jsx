import { NavLink, useLocation } from 'react-router-dom';

// Which portal is currently being viewed. One identity can have both a
// driver and a passenger profile, so this can't come from a single
// profile.role — it comes from which section of the app you're in.
function activePortal(pathname) {
  if (pathname.startsWith('/driver')) return 'driver';
  if (pathname.startsWith('/passenger')) return 'passenger';
  if (pathname.startsWith('/admin')) return 'admin';
  return null;
}

const NAV_BY_ROLE = {
  driver: [
    { to: '/driver/dashboard', label: 'Dashboard', icon: '🏠' },
    { to: '/driver/create-trip', label: 'Post a Trip', icon: '➕' },
    { to: '/driver/trips', label: 'My Trips', icon: '🗺️' },
    { to: '/driver/bookings', label: 'Bookings', icon: '🎫' },
    { to: '/driver/reports', label: 'My Reports', icon: '🚩' },
    { to: '/driver/support', label: 'Help & Support', icon: '🆘' },
    { to: '/driver/notifications', label: 'Notifications', icon: '🔔' },
    { to: '/driver/profile', label: 'Profile', icon: '👤' },
  ],
  passenger: [
    { to: '/passenger/dashboard', label: 'Dashboard', icon: '🏠' },
    { to: '/passenger/search', label: 'Find a Trip', icon: '🔍' },
    { to: '/passenger/bookings', label: 'My Bookings', icon: '🎫' },
    { to: '/passenger/reports', label: 'My Reports', icon: '🚩' },
    { to: '/passenger/support', label: 'Help & Support', icon: '🆘' },
    { to: '/passenger/notifications', label: 'Notifications', icon: '🔔' },
    { to: '/passenger/profile', label: 'Profile', icon: '👤' },
  ],
  admin: [
    { to: '/admin/dashboard', label: 'Overview', icon: '🏠' },
    { to: '/admin/drivers/review', label: 'Driver Review', icon: '🪪' },
    { to: '/admin/trips', label: 'Trip Oversight', icon: '🗺️' },
    { to: '/admin/users', label: 'User Management', icon: '👥' },
    { to: '/admin/reports', label: 'Reports & Appeals', icon: '🚩' },
    { to: '/admin/support', label: 'Help & Support', icon: '🆘' },
    { to: '/admin/notifications', label: 'Notifications', icon: '🔔' },
    { to: '/admin/audit-log', label: 'Audit Log', icon: '📋' },
  ],
};

export default function Sidebar({ open, onClose }) {
  const location = useLocation();
  const portal = activePortal(location.pathname);
  const items = NAV_BY_ROLE[portal] || [];

  return (
    <>
      <div className={`sidebar-overlay${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <img src="/Vite.svg" alt="" style={{ width: 22, height: 22 }} />
          <span>Pamoja<span className="accent">Ride</span></span>
        </div>

        <nav className="sidebar-nav">
          {items.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <span className="icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            PamojaRide &copy; {new Date().getFullYear()}
          </p>
        </div>
      </aside>
    </>
  );
}