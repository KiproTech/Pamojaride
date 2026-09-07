import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSupabaseClient } from '../../lib/supabaseClients';
import { validatePassword, validatePasswordConfirmation } from '../../lib/validation';
import PasswordInput from '../../components/auth/PasswordInput';

// ============================================================================
// Reset Password — step 2 of Supabase's official password recovery flow.
// This is where the link from the recovery email lands.
//
// IMPORTANT (why this page reads the URL itself instead of relying on the
// Supabase client's automatic `detectSessionInUrl`): this app intentionally
// runs THREE separate, portal-isolated Supabase clients in the same browser
// (driver / passenger / admin — see src/lib/supabaseClients.js). If more
// than one of them had `detectSessionInUrl: true`, whichever client
// happened to initialise first would race to consume the one-time recovery
// token/code in the URL — meaning a PASSENGER's recovery link could get
// silently claimed by the DRIVER client instead, leaving the passenger
// "not authenticated" on this exact page. `detectSessionInUrl` is now off
// on all three clients (see supabaseClients.js), and this page explicitly
// hands the token to the ONE client that matches the portal the link was
// sent for (via the `portal` prop, matching the route it was opened on:
// /passenger/reset-password or /driver/reset-password) using
// `setSession` / `verifyOtp` / `exchangeCodeForSession` as appropriate —
// covering every link format Supabase's password-recovery email can send.
//
// Nothing here ever stores, logs, or writes a password anywhere except via
// `supabase.auth.updateUser({ password })` — Supabase Auth is the only
// password store, exactly as elsewhere in this app.
// ============================================================================

const THEME = {
  passenger: {
    badge: '🚌 Passenger',
    badgeBg: '#EFF6FF', badgeColor: '#1D4ED8',
    accent: '#0E7490',
    btnGradient: 'linear-gradient(135deg, #0E7490, #155E75)',
    btnShadow: '0 4px 16px rgba(14,116,144,0.3)',
    loginPath: '/passenger/login',
    forgotPath: '/passenger/forgot-password',
  },
  driver: {
    badge: '🚗 Driver',
    badgeBg: '#FFF7ED', badgeColor: '#C2410C',
    accent: '#EA580C',
    btnGradient: 'linear-gradient(135deg, #EA580C, #C2410C)',
    btnShadow: '0 4px 16px rgba(234,88,12,0.35)',
    loginPath: '/driver/login',
    forgotPath: '/driver/forgot-password',
  },
};

// status: 'verifying' | 'ready' | 'invalid' | 'success'
export default function ResetPassword({ portal }) {
  const theme = THEME[portal] || THEME.passenger;
  const navigate = useNavigate();

  const [status, setStatus] = useState('verifying');
  const [invalidReason, setInvalidReason] = useState('');

  const [form, setForm] = useState({ password: '', confirm: '' });
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const processedRef = useRef(false);

  // ── consume the recovery link exactly once ──────────────────────────
  useEffect(() => {
    if (processedRef.current) return; // StrictMode-safe: never process twice
    processedRef.current = true;
    let cancelled = false;

    async function processRecoveryLink() {
      const client = getSupabaseClient(portal);
      const rawHash = window.location.hash?.startsWith('#') ? window.location.hash.slice(1) : '';
      const hashParams = new URLSearchParams(rawHash);
      const searchParams = new URLSearchParams(window.location.search);

      const linkError = hashParams.get('error_description') || searchParams.get('error_description')
        || hashParams.get('error') || searchParams.get('error');
      if (linkError) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (!cancelled) { setInvalidReason(decodeURIComponent(linkError.replace(/\+/g, ' '))); setStatus('invalid'); }
        return;
      }

      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      const tokenHash = searchParams.get('token_hash') || hashParams.get('token_hash');
      const otpType = searchParams.get('type') || hashParams.get('type') || 'recovery';
      const code = searchParams.get('code');

      try {
        if (accessToken && refreshToken) {
          const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          window.history.replaceState({}, document.title, window.location.pathname);
          if (error) throw error;
          if (!cancelled) setStatus('ready');
          return;
        }

        if (tokenHash) {
          const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: otpType });
          window.history.replaceState({}, document.title, window.location.pathname);
          if (error) throw error;
          if (!cancelled) setStatus('ready');
          return;
        }

        if (code) {
          const { error } = await client.auth.exchangeCodeForSession(code);
          window.history.replaceState({}, document.title, window.location.pathname);
          if (error) throw error;
          if (!cancelled) setStatus('ready');
          return;
        }

        // No recovery params in the URL at all. This page may have been
        // reloaded after the tokens were already consumed and stripped
        // (see the replaceState calls above) — in that case a valid
        // recovery session is still live, so check for one before giving
        // up and calling the link invalid.
        const { data: { session } } = await client.auth.getSession();
        if (session) { if (!cancelled) setStatus('ready'); return; }
        if (!cancelled) setStatus('invalid');
      } catch (err) {
        if (!cancelled) {
          setInvalidReason(err.message || '');
          setStatus('invalid');
        }
      }
    }

    processRecoveryLink();
    return () => { cancelled = true; };
  }, [portal]);

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitLockRef.current) return; // belt-and-braces duplicate-submit guard
    setFieldError('');

    const passwordCheck = validatePassword(form.password);
    if (!passwordCheck.valid) { setFieldError(passwordCheck.error); return; }

    const confirmCheck = validatePasswordConfirmation(form.password, form.confirm);
    if (!confirmCheck.valid) { setFieldError(confirmCheck.error); return; }

    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const client = getSupabaseClient(portal);
      const { error } = await client.auth.updateUser({ password: form.password });
      if (error) throw new Error(error.message || 'Could not update your password. Please try again.');

      // Don't leave the person signed in on a one-time recovery session —
      // send them back through a normal login with the new password, per
      // the required flow ("after successful password reset, direct the
      // user appropriately to log in").
      await client.auth.signOut();
      setForm({ password: '', confirm: '' });
      setStatus('success');
    } catch (err) {
      setFieldError(err.message || 'Something went wrong. Please check your connection and try again.');
      submitLockRef.current = false;
      setSubmitting(false);
      return;
    }
    submitLockRef.current = false;
    setSubmitting(false);
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <Link to="/" style={styles.logo}>
          <img src="/Vite.svg" alt="logo" style={{ width: 32, height: 32 }} />
          <span style={styles.logoText}>Pamoja<span style={styles.logoAccent}>Ride</span></span>
        </Link>

        <div style={{ ...styles.badge, background: theme.badgeBg, color: theme.badgeColor }}>{theme.badge}</div>

        {status === 'verifying' && (
          <>
            <h1 style={styles.heading}>Verifying your link…</h1>
            <p style={styles.sub}>Hold on a moment while we confirm your password reset link.</p>
            <div style={styles.spinnerRow}><span className="spinner" style={styles.spinnerSize} /></div>
          </>
        )}

        {status === 'invalid' && (
          <>
            <h1 style={styles.heading}>Link expired or invalid</h1>
            <p style={styles.sub}>
              This password reset link is no longer valid — it may have already been used, or more than
              an hour may have passed since it was sent.
              {invalidReason ? ` (${invalidReason})` : ''}
            </p>
            <Link
              to={theme.forgotPath}
              style={{ ...styles.btn, background: theme.btnGradient, boxShadow: theme.btnShadow, textAlign: 'center', textDecoration: 'none', display: 'block', boxSizing: 'border-box' }}
            >
              Request a new link
            </Link>
          </>
        )}

        {status === 'ready' && (
          <>
            <h1 style={styles.heading}>Set a new password</h1>
            <p style={styles.sub}>Choose a new password for your PamojaRide account.</p>

            {fieldError && <div style={styles.error}>{fieldError}</div>}

            <form onSubmit={handleSubmit} style={styles.form} noValidate>
              <div style={styles.field}>
                <label style={styles.label} htmlFor="reset-password">New Password</label>
                <PasswordInput
                  id="reset-password"
                  value={form.password}
                  onChange={set('password')}
                  inputStyle={styles.input}
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label} htmlFor="reset-confirm">Confirm New Password</label>
                <PasswordInput
                  id="reset-confirm"
                  value={form.confirm}
                  onChange={set('confirm')}
                  inputStyle={styles.input}
                  autoComplete="new-password"
                />
              </div>
              <button
                type="submit"
                style={submitting ? { ...styles.btn, background: theme.btnGradient, boxShadow: theme.btnShadow, opacity: 0.7 } : { ...styles.btn, background: theme.btnGradient, boxShadow: theme.btnShadow }}
                disabled={submitting}
              >
                {submitting ? 'Updating…' : 'Update Password'}
              </button>
            </form>
          </>
        )}

        {status === 'success' && (
          <>
            <h1 style={styles.heading}>Password updated 🎉</h1>
            <div style={styles.successBox}>Your password has been changed successfully. You can now log in with your new password.</div>
            <button
              type="button"
              style={{ ...styles.btn, background: theme.btnGradient, boxShadow: theme.btnShadow }}
              onClick={() => navigate(theme.loginPath, { replace: true })}
            >
              Go to Login
            </button>
          </>
        )}

        {(status === 'ready' || status === 'verifying') && (
          <p style={styles.footer}>
            <Link to={theme.loginPath} style={{ color: theme.accent, fontWeight: 600, textDecoration: 'none' }}>← Back to login</Link>
          </p>
        )}
      </div>

      <div style={{ ...styles.panel, background: portal === 'driver'
        ? 'linear-gradient(135deg, #0F172A 0%, #1E293B 60%, #0F172A 100%)'
        : 'linear-gradient(135deg, #0E7490 0%, #155E75 55%, #0F172A 100%)' }}>
        <div style={styles.panelInner}>
          <div style={styles.panelBadge}>🔒 Secure account recovery</div>
          <h2 style={styles.panelHeading}>Almost there.<br />Choose a fresh<br />password.</h2>
          <p style={styles.panelSub}>
            Your password is set directly with Supabase, our authentication provider — PamojaRide never
            sees, stores, or logs it.
          </p>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans', sans-serif", background: '#F8FAFC' },
  card: { width: 480, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '64px 56px', background: 'white', boxShadow: '4px 0 40px rgba(0,0,0,0.06)' },
  logo: { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', marginBottom: 36 },
  logoText: { fontFamily: "'Sora', sans-serif", fontSize: 22, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.5px' },
  logoAccent: { color: '#F97316' },
  badge: { display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, marginBottom: 16, letterSpacing: '0.03em' },
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 28, fontWeight: 800, color: '#0F172A', margin: '0 0 8px', letterSpacing: '-0.5px' },
  sub: { fontSize: 15, color: '#64748B', margin: '0 0 24px', lineHeight: 1.6 },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  successBox: { background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#166534', padding: '12px 14px', borderRadius: 10, fontSize: 13.5, marginBottom: 20, lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column', gap: 18 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  input: { padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', fontSize: 15, outline: 'none', background: '#F8FAFC', fontFamily: "'DM Sans', sans-serif", width: '100%', boxSizing: 'border-box' },
  btn: { marginTop: 6, padding: 14, borderRadius: 10, color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", width: '100%' },
  footer: { marginTop: 20, fontSize: 13, color: '#64748B', textAlign: 'center' },
  spinnerRow: { display: 'flex', justifyContent: 'center', padding: '12px 0 4px' },
  spinnerSize: { width: 28, height: 28, borderWidth: 3 },
  panel: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 64, position: 'relative', overflow: 'hidden' },
  panelInner: { maxWidth: 420, position: 'relative', zIndex: 1 },
  panelBadge: { display: 'inline-block', background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA', fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 99, marginBottom: 24 },
  panelHeading: { fontFamily: "'Sora', sans-serif", fontSize: 44, fontWeight: 800, color: 'white', lineHeight: 1.15, margin: '0 0 20px', letterSpacing: '-1px' },
  panelSub: { fontSize: 16, color: 'rgba(255,255,255,0.75)', lineHeight: 1.75, margin: 0 },
};
