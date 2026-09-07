import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import NotificationBell from './NotificationBell';

const ROLE_HOME = { driver: '/driver/profile', passenger: '/passenger/profile', admin: '/admin/dashboard' };

// Which portal is currently being viewed. One identity can have both a
// driver and a passenger profile, so this can't come from a single
// profile.role — it comes from which section of the app you're in.
function activePortal(pathname) {
  if (pathname.startsWith('/driver')) return 'driver';
  if (pathname.startsWith('/passenger')) return 'passenger';
  if (pathname.startsWith('/admin')) return 'admin';
  return null;
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

export default function Navbar({ title, onMenuClick }) {
  const { profile, signOut, isDriverVerified } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();
  const portal = activePortal(location.pathname);

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function handleSignOut() {
    await signOut();
    navigate('/');
  }

  return (
    <header className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="topbar-menu-btn" onClick={onMenuClick} aria-label="Open menu">☰</button>
        {title && <h1 className="topbar-title">{title}</h1>}
      </div>

      <div className="topbar-right">
        <NotificationBell />

        <div className="topbar-user-menu" ref={ref}>
          <button className="topbar-user-btn" onClick={() => setOpen(o => !o)}>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <span className="topbar-avatar">{initials(profile?.full_name)}</span>
              {isDriverVerified && (
                <span
                  title="Verified driver"
                  style={{
                    position: 'absolute', bottom: -2, right: -2, width: 14, height: 14,
                    borderRadius: '50%', background: 'var(--green)', color: 'white',
                    border: '2px solid white', fontSize: 8, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                  }}
                >
                  ✓
                </span>
              )}
            </span>
            <span className="topbar-user-name">{profile?.full_name?.split(' ')[0] || 'Account'}</span>
          </button>

          {open && (
            <div className="topbar-dropdown">
              <div style={{ padding: '8px 10px 10px' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{profile?.full_name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{profile?.email}</div>
              </div>
              <div className="topbar-dropdown-divider" />
              <button className="topbar-dropdown-item" onClick={() => { setOpen(false); navigate(ROLE_HOME[portal] || '/'); }}>
                👤 My Profile
              </button>
              <div className="topbar-dropdown-divider" />
              <button className="topbar-dropdown-item danger" onClick={handleSignOut}>
                🚪 Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}