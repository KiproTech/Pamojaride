import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  NOTIFICATIONS_PAGE_SIZE, iconFor, timeAgo,
  fetchMyNotifications, markNotificationRead, markAllNotificationsRead, notificationHref,
} from '../../lib/notifications';

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];

// Full "My Notifications" list, used by all three portals via
// pages/{driver,passenger,admin}/Notifications.jsx (portal="driver" |
// "passenger" | "admin"). Mirrors SupportRequestsList's structure: same
// card list, filter tabs, and "own rows only" guarantee — except that
// guarantee here comes from RLS on `notifications` directly rather than a
// wrapping RPC, since there's no cross-table data to resolve.
export default function NotificationsList({ portal }) {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('all');
  const [marking, setMarking] = useState(false);

  const load = useCallback(async (currentFilter) => {
    if (!user) return;
    setLoading(true);
    setError(false);
    const { notifications: data, count, error: err } = await fetchMyNotifications({
      userId: user.id, offset: 0, limit: NOTIFICATIONS_PAGE_SIZE, unreadOnly: currentFilter === 'unread',
    });
    if (err) setError(true);
    setNotifications(data);
    setTotal(count);
    setLoading(false);
  }, [user]);

  useEffect(() => { load(filter); }, [load, filter]);

  // Realtime: new notifications and read-state changes (including ones
  // made from the bell dropdown, or from another open tab) show up here
  // live. Guarded against duplicate INSERT delivery by id, same as the
  // bell. Cleans up its subscription on unmount/portal change/filter
  // change so switching tabs never leaves more than one active channel.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const channel = supabase
      .channel(`notifications-list-${portal}-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (cancelled) return;
          // A freshly-inserted notification is always unread, so it belongs
          // in the list regardless of which filter tab is active.
          setNotifications(prev => (prev.some(n => n.id === payload.new.id) ? prev : [payload.new, ...prev]));
          setTotal(t => t + 1);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (cancelled) return;
          setNotifications(prev =>
            filter === 'unread' && payload.new.is_read
              ? prev.filter(n => n.id !== payload.new.id)
              : prev.map(n => (n.id === payload.new.id ? payload.new : n))
          );
        }
      )
      .subscribe();

    return () => { cancelled = true; channel.unsubscribe(); };
  }, [user, portal, filter]);

  async function loadMore() {
    if (!user || loadingMore) return;
    setLoadingMore(true);
    const { notifications: more, error: err } = await fetchMyNotifications({
      userId: user.id, offset: notifications.length, limit: NOTIFICATIONS_PAGE_SIZE, unreadOnly: filter === 'unread',
    });
    if (!err) setNotifications(prev => [...prev, ...more]);
    setLoadingMore(false);
  }

  async function handleMarkAllRead() {
    if (marking || !user) return;
    setMarking(true);
    setNotifications(prev => prev.map(n => (n.is_read ? n : { ...n, is_read: true, read_at: new Date().toISOString() })));
    await markAllNotificationsRead(user.id);
    setMarking(false);
    if (filter === 'unread') load('unread');
  }

  async function handleOpen(notif) {
    if (!notif.is_read) {
      setNotifications(prev => prev.map(n => (n.id === notif.id ? { ...n, is_read: true } : n)));
      await markNotificationRead(notif.id);
    }
    const dest = notificationHref(notif, { isAdmin, portal });
    if (dest) navigate(dest.pathname, dest.state ? { state: dest.state } : undefined);
  }

  const unreadCount = notifications.filter(n => !n.is_read).length;
  const hasMore = notifications.length < total;

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FILTER_TABS.map(t => (
            <button
              key={t.value}
              className={`btn btn-sm ${filter === t.value ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setFilter(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {unreadCount > 0 && (
            <button className="btn btn-sm btn-outline" onClick={handleMarkAllRead} disabled={marking}>
              Mark all as read
            </button>
          )}
          {!loading && !error && (
            <button className="btn btn-sm btn-outline" onClick={() => load(filter)}>Refresh</button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>
          We couldn't load your notifications right now.
          <button className="btn btn-sm btn-outline" style={{ marginLeft: 10 }} onClick={() => load(filter)}>Retry</button>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
        </div>
      ) : !error && notifications.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔔</div>
          <h3>{filter === 'unread' ? "You're all caught up" : 'No notifications yet'}</h3>
          <p>
            {filter === 'unread'
              ? 'No unread notifications right now.'
              : "We'll let you know here when there's something new."}
          </p>
        </div>
      ) : !error && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {notifications.map(n => (
              <div
                key={n.id}
                className="card card-pad"
                role="button"
                tabIndex={0}
                onClick={() => handleOpen(n)}
                onKeyDown={e => { if (e.key === 'Enter') handleOpen(n); }}
                style={{
                  cursor: 'pointer',
                  background: n.is_read ? undefined : '#FFF7ED',
                  borderLeft: !n.is_read ? '3px solid #EA580C' : undefined,
                }}
              >
                <div className="flex-between" style={{ gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>
                    <span style={{ marginRight: 6 }}>{iconFor(n.type)}</span>{n.title}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeAgo(n.created_at)}</span>
                </div>
                {n.body && <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', margin: 0 }}>{n.body}</p>}
                {!n.is_read && <span className="badge badge-amber" style={{ marginTop: 8, display: 'inline-block' }}>Unread</span>}
              </div>
            ))}
          </div>

          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button className="btn btn-outline btn-sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
