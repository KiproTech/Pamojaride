import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import { iconFor, markNotificationRead, notificationHref } from '../../lib/notifications';
import { acceptTripCompletion, declineTripCompletion, fetchTripCompletionStatus, formatSecondsRemaining } from '../../lib/tripCompletion';
import DeclineCompletionModal from '../passenger/DeclineCompletionModal';

const TOAST_TTL_MS = 8000;

function currentPortal() {
  const path = window.location.pathname;
  if (path.startsWith('/driver')) return 'driver';
  if (path.startsWith('/passenger')) return 'passenger';
  if (path.startsWith('/admin')) return 'admin';
  return null;
}

/**
 * Mounted once, at the top of <App/> (so it stays alive across every route
 * change instead of remounting per-page like NotificationBell does), for
 * the whole lifetime of a signed-in session.
 *
 * This is what makes notifications actually reach the person "while they
 * are using PamojaRide" rather than only once they open the bell dropdown
 * or the Notifications page:
 *   - Every new row Postgres inserts into `notifications` for this user
 *     (trip reminders, booking updates, completion requests, etc.) pops a
 *     toast in the corner, in addition to still being saved and shown on
 *     the Notifications page exactly as before — this never writes a
 *     second copy of anything, it only listens to the same INSERT already
 *     firing today.
 *   - Specifically for `trip_completion_pending` (a driver just marked the
 *     trip completed), it also opens the Accept/Decline popup immediately,
 *     wherever in the app the passenger currently is — not only when they
 *     happen to be on the My Bookings page (which still also shows the
 *     same card inline, via CompletionStatus, for anyone who missed the
 *     popup or reopens the app later).
 */
export default function GlobalNotificationCenter() {
  const { user, isAdmin } = useAuth();
  const [toasts, setToasts] = useState([]);
  const [completionPopup, setCompletionPopup] = useState(null); // { tripId, body }
  const [declining, setDeclining] = useState(false);
  const [responding, setResponding] = useState(false);
  const [popupError, setPopupError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(null);
  const navigate = useNavigate();
  const timers = useRef({});
  const deadlineRef = useRef(null);

  // Fetch the real server-side deadline as soon as the popup opens (never
  // trust a client-guessed "20 minutes from now" — the popup may have
  // arrived late, or the passenger may have missed an earlier reminder),
  // then tick a local countdown display between refreshes.
  useEffect(() => {
    if (!completionPopup) { setSecondsLeft(null); deadlineRef.current = null; return undefined; }
    let cancelled = false;

    async function loadDeadline() {
      try {
        const status = await fetchTripCompletionStatus(completionPopup.tripId);
        if (cancelled || !status || status.seconds_remaining == null) return;
        deadlineRef.current = Date.now() + status.seconds_remaining * 1000;
        setSecondsLeft(status.seconds_remaining);
      } catch {
        // Non-fatal — the popup still works without a visible countdown.
      }
    }
    loadDeadline();

    const tick = setInterval(() => {
      if (deadlineRef.current == null) return;
      setSecondsLeft(Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000)));
    }, 1000);

    return () => { cancelled = true; clearInterval(tick); };
  }, [completionPopup]);

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    clearTimeout(timers.current[id]);
    delete timers.current[id];
  }, []);

  const pushToast = useCallback((notif) => {
    setToasts(prev => (prev.some(t => t.id === notif.id) ? prev : [...prev, notif].slice(-4)));
    timers.current[notif.id] = setTimeout(() => dismissToast(notif.id), TOAST_TTL_MS);
  }, [dismissToast]);

  useEffect(() => () => {
    Object.values(timers.current).forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;

    const channel = supabase
      .channel(`global-notifications-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (cancelled) return;
          const notif = payload.new;
          pushToast(notif);
          if (notif.type === 'trip_completion_pending' && notif.data?.trip_id) {
            setPopupError('');
            setCompletionPopup({ tripId: notif.data.trip_id, body: notif.body });
          }
        }
      )
      .subscribe();

    return () => { cancelled = true; channel.unsubscribe(); };
  }, [user, pushToast]);

  function handleToastClick(notif) {
    dismissToast(notif.id);
    markNotificationRead(notif.id);
    const dest = notificationHref(notif, { isAdmin, portal: currentPortal() });
    if (dest) navigate(dest.pathname, dest.state ? { state: dest.state } : undefined);
  }

  function closePopup() {
    setCompletionPopup(null);
    setDeclining(false);
    setPopupError('');
  }

  async function handleAccept() {
    if (!completionPopup) return;
    setResponding(true); setPopupError('');
    try {
      await acceptTripCompletion(completionPopup.tripId);
      closePopup();
    } catch (err) {
      setPopupError(err.message);
    } finally {
      setResponding(false);
    }
  }

  async function handleDecline(reason, comment) {
    if (!completionPopup) return;
    setResponding(true); setPopupError('');
    try {
      await declineTripCompletion(completionPopup.tripId, reason, comment);
      closePopup();
    } catch (err) {
      setPopupError(err.message);
      setResponding(false);
    }
  }

  return (
    <>
      <div
        style={{
          position: 'fixed', top: 16, right: 16, zIndex: 1000,
          display: 'flex', flexDirection: 'column', gap: 10, width: 320, maxWidth: 'calc(100vw - 32px)',
        }}
      >
        {toasts.map(t => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => handleToastClick(t)}
            onKeyDown={e => { if (e.key === 'Enter') handleToastClick(t); }}
            className="card"
            style={{
              padding: '12px 14px', cursor: 'pointer', background: 'white',
              border: '1px solid var(--border, #E2E8F0)', boxShadow: '0 12px 28px rgba(15,23,42,0.16)',
            }}
          >
            <div className="flex-between" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text, #0F172A)' }}>
                <span style={{ marginRight: 6 }}>{iconFor(t.type)}</span>{t.title}
              </div>
              <button
                onClick={e => { e.stopPropagation(); dismissToast(t.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1, padding: 2 }}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
            {t.body && (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{t.body}</div>
            )}
          </div>
        ))}
      </div>

      {completionPopup && !declining && (
        <div className="modal-overlay" onClick={closePopup}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontSize: 17 }}>🏁 Confirm trip completion</h3>
              <button className="modal-close" onClick={closePopup}>✕</button>
            </div>
            <p style={{ fontSize: 13.5, color: 'var(--text)', marginBottom: 10, lineHeight: 1.5 }}>
              {completionPopup.body || 'The driver has marked this trip as complete. Please confirm whether the trip was completed successfully. If you do not respond within 20 minutes, the trip will automatically be marked as complete.'}
            </p>
            {secondsLeft != null && (
              <div style={{ fontSize: 12.5, fontWeight: 700, color: secondsLeft <= 60 ? 'var(--danger, #DC2626)' : 'var(--text-muted)', marginBottom: 16 }}>
                ⏱️ {secondsLeft > 0 ? `${formatSecondsRemaining(secondsLeft)} to respond` : 'Finalizing automatically…'}
              </div>
            )}
            {popupError && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{popupError}</div>}
            <button className="btn btn-primary btn-full" disabled={responding || secondsLeft === 0} onClick={handleAccept}>
              {responding ? <span className="spinner" /> : '✅ Yes, Trip Completed'}
            </button>
            <button
              className="btn btn-outline btn-full"
              style={{ marginTop: 10 }}
              disabled={responding || secondsLeft === 0}
              onClick={() => setDeclining(true)}
            >
              ❌ Decline / Report a Problem
            </button>
          </div>
        </div>
      )}

      {completionPopup && declining && (
        <DeclineCompletionModal
          onClose={() => setDeclining(false)}
          onSubmit={handleDecline}
          submitting={responding}
          error={popupError}
        />
      )}
    </>
  );
}
