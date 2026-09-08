import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';

function PasswordInput({ placeholder = '••••••••', value, onChange, inputStyle }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        style={{ ...inputStyle, paddingRight: 44 }}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        style={eyeBtn}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        )}
      </button>
    </div>
  );
}

const eyeBtn = {
  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
  background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8',
  display: 'flex', alignItems: 'center', padding: 0, lineHeight: 1,
};

export default function DriverLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { kickedMessage, clearKickedMessage } = useAuth();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Please fill in all fields.'); return; }
    setLoading(true);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(signInError.message);

      // Whether this identity has a driver account is checked against
      // driver_profiles — the server-controlled source of truth — never
      // against user.user_metadata, which is client-writable. This is
      // scoped ONLY to "does a driver profile exist for this identity";
      // it says nothing about whether a passenger profile also exists,
      // and it must never redirect based on one.
      const { data: driverRow, error: driverError } = await supabase
        .from('driver_profiles')
        .select('profile_id')
        .eq('profile_id', data.user.id)
        .maybeSingle();

      if (driverError) {
        throw new Error(driverError.message);
      }

      if (!driverRow) {
        await supabase.auth.signOut();
        throw new Error('This email has no driver account. Please use the passenger login, or register as a driver.');
      }

      // Verification status is intentionally NOT checked here — sign-in
      // itself always succeeds for any existing driver account. What
      // happens next is decided by App.jsx's ProtectedRoute: unverified/
      // pending/rejected drivers land on the PendingApproval status page
      // instead of the dashboard, verified drivers see the real thing.
      navigate('/driver/dashboard');
    } catch (err) {
      console.error("Login error:", err);
      setError(err.message);
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

        <div style={styles.badge}>🚗 Driver</div>
        <h1 style={styles.heading}>Welcome back</h1>
        <p style={styles.sub}>Sign in to manage your trips and earnings.</p>

        {kickedMessage && (
          <div style={{ ...styles.error, background: '#FFF7ED', border: '1px solid #FED7AA', color: '#C2410C' }}>
            {kickedMessage}
            <button type="button" onClick={clearKickedMessage} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>Dismiss</button>
          </div>
        )}
        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Email Address</label>
            <input style={styles.input} type="email" placeholder="james@example.com"
              value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div style={styles.field}>
            <div style={styles.labelRow}>
              <label style={styles.label}>Password</label>
              <Link to="/driver/forgot-password" style={styles.forgotLink}>Forgot Password?</Link>
            </div>
            <PasswordInput value={password} onChange={e => setPassword(e.target.value)} inputStyle={styles.input} />
          </div>
          <button type="submit" style={loading ? { ...styles.btn, opacity: 0.7 } : styles.btn} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={styles.footer}>Not registered yet?{' '}<Link to="/driver/register" style={styles.link}>Apply as a driver</Link></p>
        <p style={styles.footer}><Link to="/passenger/login" style={styles.linkMuted}>Sign in as a passenger instead</Link></p>
      </div>

      <div className="auth-split-panel" style={styles.panel}>
        <div style={styles.panelInner}>
          <div style={styles.glow} />
          <div style={styles.panelBadge}>💰 Earn on every trip</div>
          <h2 style={styles.panelHeading}>Your car.<br />Your schedule.<br />Your earnings.</h2>
          <p style={styles.panelSub}>Post your trip, fill your empty seats, and earn while you travel routes you already drive. Payments land in M-Pesa automatically.</p>
          <div style={styles.statsRow}>
            {[{ v: '24h', l: 'Verification' }, { v: 'L1–L5', l: 'Trust Levels' }, { v: 'M-Pesa', l: 'Auto Payout' }].map(({ v, l }) => (
              <div key={l} style={styles.stat}>
                <span style={styles.statVal}>{v}</span>
                <span style={styles.statLabel}>{l}</span>
              </div>
            ))}
          </div>
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
  badge: { display: 'inline-block', background: '#FFF7ED', color: '#C2410C', fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, marginBottom: 16, letterSpacing: '0.03em' },
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 30, fontWeight: 800, color: '#0F172A', margin: '0 0 8px', letterSpacing: '-0.5px' },
  sub: { fontSize: 15, color: '#64748B', margin: '0 0 28px' },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 18 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  labelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  forgotLink: { fontSize: 12.5, fontWeight: 600, color: '#EA580C', textDecoration: 'none' },
  input: { padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', fontSize: 15, outline: 'none', background: '#F8FAFC', fontFamily: "'DM Sans', sans-serif", width: '100%', boxSizing: 'border-box' },
  btn: { marginTop: 6, padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, #EA580C, #C2410C)', color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", boxShadow: '0 4px 16px rgba(234,88,12,0.35)' },
  footer: { marginTop: 16, fontSize: 13, color: '#64748B', textAlign: 'center' },
  link: { color: '#EA580C', fontWeight: 600, textDecoration: 'none' },
  linkMuted: { color: '#94A3B8', textDecoration: 'none' },
  panel: { flex: 1, background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 60%, #0F172A 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 64, position: 'relative', overflow: 'hidden' },
  panelInner: { maxWidth: 420, position: 'relative', zIndex: 1 },
  glow: { position: 'absolute', top: -100, right: -100, width: 400, height: 400, background: 'radial-gradient(circle, rgba(249,115,22,0.18) 0%, transparent 70%)', borderRadius: '50%' },
  panelBadge: { display: 'inline-block', background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA', fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 99, marginBottom: 24 },
  panelHeading: { fontFamily: "'Sora', sans-serif", fontSize: 48, fontWeight: 800, color: 'white', lineHeight: 1.1, margin: '0 0 20px', letterSpacing: '-1px' },
  panelSub: { fontSize: 16, color: 'rgba(255,255,255,0.65)', lineHeight: 1.75, margin: '0 0 40px' },
  statsRow: { display: 'flex', gap: 16 },
  stat: { display: 'flex', flexDirection: 'column', gap: 4, padding: '16px 20px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, minWidth: 90 },
  statVal: { fontFamily: "'Sora', sans-serif", fontSize: 22, fontWeight: 800, color: '#FB923C' },
  statLabel: { fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
};