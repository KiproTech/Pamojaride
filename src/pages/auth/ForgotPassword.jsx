import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getSupabaseClient } from '../../lib/supabaseClients';
import { validateEmail } from '../../lib/validation';

// ============================================================================
// Forgot Password — step 1 of Supabase's official password recovery flow.
//
// This page ONLY ever calls supabase.auth.resetPasswordForEmail(). It never
// stores, logs, or transmits a password anywhere, and it never writes to
// any table — Supabase Auth remains the sole source of truth, exactly as
// with sign-in/sign-up elsewhere in this app.
//
// `portal` ('passenger' | 'driver') decides which isolated Supabase client
// sends the email (see src/lib/supabaseClients.js) and which portal's
// /reset-password route the recovery link sends the user back to. It also
// only drives copy/branding here — no auth/session logic depends on it
// beyond picking the right client and redirect target.
// ============================================================================
const THEME = {
  passenger: {
    badge: '🚌 Passenger',
    badgeBg: '#EFF6FF', badgeColor: '#1D4ED8',
    accent: '#0E7490', accentDark: '#155E75',
    btnGradient: 'linear-gradient(135deg, #0E7490, #155E75)',
    btnShadow: '0 4px 16px rgba(14,116,144,0.3)',
    loginPath: '/passenger/login',
  },
  driver: {
    badge: '🚗 Driver',
    badgeBg: '#FFF7ED', badgeColor: '#C2410C',
    accent: '#EA580C', accentDark: '#C2410C',
    btnGradient: 'linear-gradient(135deg, #EA580C, #C2410C)',
    btnShadow: '0 4px 16px rgba(234,88,12,0.35)',
    loginPath: '/driver/login',
  },
};

export default function ForgotPassword({ portal }) {
  const theme = THEME[portal] || THEME.passenger;

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return; // guards against duplicate submissions (double-click / double-enter)
    setError('');

    const { valid, error: emailError, value: cleanEmail } = validateEmail(email);
    if (!valid) { setError(emailError); return; }

    setLoading(true);
    try {
      const client = getSupabaseClient(portal);

      // Verify the email belongs to an existing, registered account for
      // THIS portal before doing anything else. `email_is_registered` is a
      // SECURITY DEFINER RPC (see database/password_reset_and_trips_completed_fix.sql)
      // that returns only a plain boolean — it never leaks a name, phone,
      // account status, or any other field, and it runs under RLS exactly
      // like every other query here (this app's anon key can't read
      // `profiles` directly). It's scoped to `portal` the same way sign-in
      // already is (see DriverLogin.jsx/PassengerLogin.jsx rejecting a
      // login when the identity has no matching role profile), so a
      // driver-only email correctly reports "no account" on the passenger
      // reset page and vice versa.
      const { data: isRegistered, error: lookupError } = await client.rpc('email_is_registered', {
        p_email: cleanEmail,
        p_portal: portal,
      });
      if (lookupError) throw new Error(lookupError.message || 'Could not verify that email. Please try again.');

      if (!isRegistered) {
        setError(`No ${portal} account exists with that email address.`);
        return;
      }

      const redirectTo = `${window.location.origin}/${portal}/reset-password`;
      const { error: resetError } = await client.auth.resetPasswordForEmail(cleanEmail, { redirectTo });
      if (resetError) throw new Error(resetError.message || 'Could not send the reset email. Please try again.');
      setSent(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-split-page" style={styles.page}>
      <div className="auth-split-card" style={styles.card}>
        <Link to="/" style={styles.logo}>
          <img src="/Vite.svg" alt="logo" style={{ width: 32, height: 32 }} />
          <span style={styles.logoText}>Pamoja<span style={styles.logoAccent}>Ride</span></span>
        </Link>

        <div style={{ ...styles.badge, background: theme.badgeBg, color: theme.badgeColor }}>{theme.badge}</div>

        {sent ? (
          <>
            <h1 style={styles.heading}>Check your email</h1>
            <p style={styles.sub}>
              We've sent a password reset link to <strong>{email.trim()}</strong>.
              It may take a minute to arrive — don't forget to check spam/junk.
            </p>
            <div style={{ ...styles.successBox }}>
              📧 Open the email and click <strong>Reset Password</strong> to choose a new password.
            </div>
            <button
              type="button"
              style={{ ...styles.btnOutline, borderColor: theme.accent, color: theme.accent }}
              onClick={() => { setSent(false); setError(''); }}
            >
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h1 style={styles.heading}>Forgot your password?</h1>
            <p style={styles.sub}>Enter the email you registered with and we'll send you a link to reset it.</p>

            {error && <div style={styles.error}>{error}</div>}

            <form onSubmit={handleSubmit} style={styles.form} noValidate>
              <div style={styles.field}>
                <label style={styles.label} htmlFor="forgot-email">Email Address</label>
                <input
                  id="forgot-email"
                  style={styles.input}
                  type="email"
                  placeholder="jane@example.com"
                  value={email}
                  autoComplete="email"
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
              <button
                type="submit"
                style={loading ? { ...styles.btn, background: theme.btnGradient, boxShadow: theme.btnShadow, opacity: 0.7 } : { ...styles.btn, background: theme.btnGradient, boxShadow: theme.btnShadow }}
                disabled={loading}
              >
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>
          </>
        )}

        <p style={styles.footer}>
          <Link to={theme.loginPath} style={{ color: theme.accent, fontWeight: 600, textDecoration: 'none' }}>← Back to login</Link>
        </p>
      </div>

      <div className="auth-split-panel" style={{ ...styles.panel, background: portal === 'driver'
        ? 'linear-gradient(135deg, #0F172A 0%, #1E293B 60%, #0F172A 100%)'
        : 'linear-gradient(135deg, #0E7490 0%, #155E75 55%, #0F172A 100%)' }}>
        <div style={styles.panelInner}>
          <div style={styles.panelBadge}>🔒 Secure account recovery</div>
          <h2 style={styles.panelHeading}>Forgot it happens.<br />Let's get you<br />back in.</h2>
          <p style={styles.panelSub}>
            We use Supabase's secure password recovery, so your new password is set directly with our
            authentication provider — PamojaRide never sees or stores it.
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
  btn: { marginTop: 6, padding: 14, borderRadius: 10, color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnOutline: { marginTop: 4, padding: 14, borderRadius: 10, background: 'white', fontWeight: 700, fontSize: 15, border: '1.5px solid', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  footer: { marginTop: 20, fontSize: 13, color: '#64748B', textAlign: 'center' },
  panel: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 64, position: 'relative', overflow: 'hidden' },
  panelInner: { maxWidth: 420, position: 'relative', zIndex: 1 },
  panelBadge: { display: 'inline-block', background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA', fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 99, marginBottom: 24 },
  panelHeading: { fontFamily: "'Sora', sans-serif", fontSize: 44, fontWeight: 800, color: 'white', lineHeight: 1.15, margin: '0 0 20px', letterSpacing: '-1px' },
  panelSub: { fontSize: 16, color: 'rgba(255,255,255,0.75)', lineHeight: 1.75, margin: 0 },
};
