import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import { iconFor, timeAgo, markNotificationRead, markAllNotificationsRead, notificationHref } from '../../lib/notifications';

const PREVIEW_LIMIT = 20;

// Which portal this bell is currently mounted under. It's rendered inside
// Navbar, which only ever appears inside a portal's own DashboardLayout,
// so this always matches the signed-in identity that `user` below belongs
// to.
function currentPortal() {
  const path = window.location.pathname;
  if (path.startsWith('/driver')) return 'driver';
  if (path.startsWith('/passenger')) return 'passenger';
  if (path.startsWith('/admin')) return 'admin';
  return null;
}

export default function NotificationBell() {
  const { user, isAdmin } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [marking, setMarking] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const portal = currentPortal();

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setError(false);
    try {
      const { data, error: err } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(PREVIEW_LIMIT);

      if (err) throw err;
      setNotifications(data || []);
    } catch (err) {
      console.error('NotificationBell load error:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Realtime: push newly-created notifications into the dropdown, and
  // reflect read-state changes made elsewhere (e.g. the full Notifications
  // page, or another open tab), without a manual refresh. Scoped to
  // user_id=eq.<this user> both by the subscription filter AND by RLS
  // underneath it, so this channel is never sent another user's rows even
  // if the filter were somehow bypassed. Guarded against duplicates by id
  // (a reconnect can, in principle, redeliver an event) and unmounts
  // cleanly so a portal switch or logout doesn't leave a stale
  // subscription running.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const channel = supabase
      .channel(`notifications-bell-${portal}-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (cancelled) return;
          setNotifications(prev =>
            prev.some(n => n.id === payload.new.id) ? prev : [payload.new, ...prev].slice(0, PREVIEW_LIMIT)
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (cancelled) return;
          setNotifications(prev => prev.map(n => (n.id === payload.new.id ? payload.new : n)));
        }
      )
      .subscribe();

    return () => { cancelled = true; channel.unsubscribe(); };
  }, [user, portal]);

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  async function handleMarkRead(notif) {
    if (notif.is_read) return;
    setNotifications(prev => prev.map(n => (n.id === notif.id ? { ...n, is_read: true } : n)));
    await markNotificationRead(notif.id);
  }

  async function handleMarkAllRead(e) {
    e.stopPropagation();
    if (marking || unreadCount === 0 || !user) return;
    setMarking(true);
    setNotifications(prev => prev.map(n => (n.is_read ? n : { ...n, is_read: true, read_at: new Date().toISOString() })));
    await markAllNotificationsRead(user.id);
    setMarking(false);
  }

  function handleOpen(notif) {
    handleMarkRead(notif);
    const dest = notificationHref(notif, { isAdmin, portal });
    if (dest) {
      setOpen(false);
      navigate(dest.pathname, dest.state ? { state: dest.state } : undefined);
    }
  }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Notifications"
        style={{
          position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
          padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 20 }}>🔔</span>
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16,
            borderRadius: 8, background: '#EA580C', color: 'white', fontSize: 10,
            fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8, width: 340,
          maxHeight: 420, display: 'flex', flexDirection: 'column', background: 'white', borderRadius: 12,
          border: '1px solid #E2E8F0', boxShadow: '0 12px 32px rgba(0,0,0,0.12)', zIndex: 200,
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #E2E8F0', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                disabled={marking}
                style={{
                  background: 'none', border: 'none', cursor: marking ? 'default' : 'pointer',
                  color: 'var(--primary-dark, #1D4ED8)', fontSize: 12, fontWeight: 600, padding: 0,
                  opacity: marking ? 0.6 : 1,
                }}
              >
                Mark all as read
              </button>
            )}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && (
              <div style={{ padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>Loading…</div>
            )}

            {!loading && error && (
              <div style={{ padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                Couldn't load notifications.{' '}
                <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--primary-dark, #1D4ED8)', cursor: 'pointer', fontWeight: 600, padding: 0 }}>
                  Retry
                </button>
              </div>
            )}

            {!loading && !error && notifications.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No notifications yet.</div>
            )}

            {!loading && !error && notifications.map(n => (
              <div
                key={n.id}
                onClick={() => handleOpen(n)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter') handleOpen(n); }}
                style={{
                  padding: '12px 16px', borderBottom: '1px solid #F1F5F9', cursor: 'pointer',
                  background: n.is_read ? 'white' : '#FFF7ED',
                  borderLeft: !n.is_read ? '3px solid #EA580C' : '3px solid transparent',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', marginBottom: 2 }}>
                  <span style={{ marginRight: 6 }}>{iconFor(n.type)}</span>{n.title}
                </div>
                {n.body && <div style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.5 }}>{n.body}</div>}
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{timeAgo(n.created_at)}</div>
              </div>
            ))}
          </div>

          {portal && (
            <button
              onClick={() => { setOpen(false); navigate(`/${portal}/notifications`); }}
              style={{
                padding: '10px 16px', border: 'none', borderTop: '1px solid #E2E8F0', background: 'none',
                color: 'var(--primary-dark, #1D4ED8)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              }}
            >
              See all notifications
            </button>
          )}
        </div>
      )}
    </div>
  );
}
