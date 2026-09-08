import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { validateRegistrationForm } from '../../lib/validation';

function PasswordInput({ value, onChange, inputStyle }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={visible ? 'text' : 'password'}
        placeholder="••••••••"
        value={value}
        onChange={onChange}
        style={{ ...inputStyle, paddingRight: 44 }}
      />
      <button type="button" onClick={() => setVisible(v => !v)} style={eyeBtn} aria-label={visible ? 'Hide' : 'Show'}>
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
  display: 'flex', alignItems: 'center', padding: 0,
};

export default function DriverRegister() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);
  const navigate = useNavigate();

  function set(field) { return e => setForm(f => ({ ...f, [field]: e.target.value })); }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Client-side validation (full name shape, email format, required
    // fields, password confirmation, existing password requirements) — a
    // fast-fail UX layer only. Supabase Auth remains the source of truth:
    // it still independently enforces its own password policy and email
    // uniqueness server-side exactly as before: this only adds an earlier,
    // clearer message for the same failures plus the new two-name check.
    const validation = validateRegistrationForm(form);
    if (!validation.valid) { setError(validation.firstError); return; }
    // Send the trimmed/normalized values (collapsed whitespace, lowercased
    // email) on to Supabase rather than the raw form state.
    const { name, email, phone, password } = validation.values;

    setLoading(true);
    try {
      // Only identity fields are sent here. The server-side handle_new_user()
      // trigger is what actually sets role='driver' and, regardless of
      // anything the client sends, always starts verification_status at
      // 'unverified' — no documents, licence, or vehicle info required to
      // create an account. Verification happens later, from the dashboard,
      // and is only needed before creating a trip.
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: name,
            phone,
            role: 'driver',
          },
        },
      });

      if (signUpError) {
        const alreadyRegistered = signUpError.message?.toLowerCase().includes('already registered');
        if (!alreadyRegistered) throw new Error(signUpError.message);

        // This email already has an identity (e.g. a passenger account).
        // Don't create a second one — sign in with the password they just
        // typed and attach a driver profile to the existing identity.
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) {
          throw new Error(
            'An account already exists for this email. Enter the password for that account to add a driver profile to it.'
          );
        }

        const { data: { user: existingUser } } = await supabase.auth.getUser();
        const { data: existingDriver } = await supabase
          .from('driver_profiles')
          .select('profile_id')
          .eq('profile_id', existingUser.id)
          .maybeSingle();

        if (existingDriver) {
          throw new Error('This account already has a driver profile. Please use the driver login instead.');
        }

        const { error: insertError } = await supabase
          .from('driver_profiles')
          .insert({ profile_id: existingUser.id });
        if (insertError) throw new Error(insertError.message);

        setDone(true);
        return;
      }

      if (!data.session) {
        // Email confirmation required — no profile actions needed yet,
        // the trigger already created their profile on signup.
        setNeedsEmailConfirmation(true);
      }
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="auth-split-page" style={styles.page}>
        <div className="auth-split-card" style={styles.card}>
          <div style={styles.success}>
            <div style={styles.successIcon}>{needsEmailConfirmation ? '📧' : '🎉'}</div>
            <h1 style={{ ...styles.heading, textAlign: 'center' }}>
              {needsEmailConfirmation ? 'Confirm your email' : "You're in!"}
            </h1>
            <p style={{ ...styles.sub, textAlign: 'center', marginBottom: 24 }}>
              {needsEmailConfirmation
                ? <>We sent a confirmation link to <strong>{form.email}</strong>. Confirm it, then log in to reach your dashboard.</>
                : "Your account is ready. You can explore your dashboard right away — you'll just need to complete verification before you can post your first trip."}
            </p>
            <Link to="/driver/login" style={{ width: '100%' }}>
              <button style={styles.btn}>Go to Driver Login</button>
            </Link>
          </div>
        </div>
        <div className="auth-split-panel" style={styles.panel}>
          <div style={styles.panelInner}>
            <div style={styles.glow} />
            <div style={styles.panelBadge}>💰 Earn on every trip</div>
            <h2 style={styles.panelHeading}>Your car.<br />Your schedule.<br />Your earnings.</h2>
            <p style={styles.panelSub}>Post your trip, fill your empty seats, and earn while you travel routes you already drive.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-split-page" style={styles.page}>
      <div className="auth-split-card" style={styles.card}>
        <Link to="/" style={styles.logo}>
          <img src="/Vite.svg" alt="logo" style={{ width: 32, height: 32 }} />
          <span style={styles.logoText}>Pamoja<span style={styles.logoAccent}>Ride</span></span>
        </Link>

        <div style={styles.badge}>🚗 Driver</div>
        <h1 style={styles.heading}>Create your driver account</h1>
        <p style={styles.sub}>Takes under a minute. You'll verify your licence and vehicle later, before your first trip.</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Full Name</label>
            <input style={styles.input} placeholder="James Otieno" value={form.name} onChange={set('name')} autoComplete="name" />
            <span style={styles.hint}>First and last name, e.g. "James Otieno".</span>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Email Address</label>
            <input style={styles.input} type="email" placeholder="james@example.com" value={form.email} onChange={set('email')} autoComplete="email" />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Phone Number</label>
            <input style={styles.input} type="tel" placeholder="07XX XXX XXX" value={form.phone} onChange={set('phone')} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <PasswordInput value={form.password} onChange={set('password')} inputStyle={styles.input} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Confirm Password</label>
            <PasswordInput value={form.confirm} onChange={set('confirm')} inputStyle={styles.input} />
          </div>
          <div style={styles.infoBox}>🚀 No ID or licence needed to sign up — you'll complete verification from your dashboard whenever you're ready, before posting your first trip.</div>
          <button type="submit" style={loading ? { ...styles.btn, opacity: 0.7 } : styles.btn} disabled={loading}>
            {loading ? 'Creating account…' : 'Create Account →'}
          </button>
        </form>

        <p style={styles.footer}>Already registered?{' '}<Link to="/driver/login" style={styles.link}>Sign in</Link></p>
        <p style={styles.footer}><Link to="/passenger/register" style={styles.linkMuted}>Register as a passenger instead</Link></p>
      </div>

      <div className="auth-split-panel" style={styles.panel}>
        <div style={styles.panelInner}>
          <div style={styles.glow} />
          <div style={styles.panelBadge}>💰 Earn on every trip</div>
          <h2 style={styles.panelHeading}>Your car.<br />Your schedule.<br />Your earnings.</h2>
          <p style={styles.panelSub}>Post your trip, fill your empty seats, and earn while you travel routes you already drive. Payments land in M-Pesa automatically.</p>
          <div style={styles.statsRow}>
            {[{ v: '<1 min', l: 'To sign up' }, { v: '24h', l: 'Verify docs' }, { v: 'M-Pesa', l: 'Auto Payout' }].map(({ v, l }) => (
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
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 28, fontWeight: 800, color: '#0F172A', margin: '0 0 8px', letterSpacing: '-0.5px' },
  sub: { fontSize: 15, color: '#64748B', margin: '0 0 24px' },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  hint: { fontSize: 12, color: '#94A3B8' },
  input: { padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', fontSize: 15, outline: 'none', background: '#F8FAFC', fontFamily: "'DM Sans', sans-serif", width: '100%', boxSizing: 'border-box' },
  infoBox: { padding: '12px 14px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, fontSize: 13, color: '#166534', lineHeight: 1.6 },
  btn: { marginTop: 4, padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, #EA580C, #C2410C)', color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", boxShadow: '0 4px 16px rgba(234,88,12,0.3)', width: '100%' },
  footer: { marginTop: 14, fontSize: 13, color: '#64748B', textAlign: 'center' },
  link: { color: '#EA580C', fontWeight: 600, textDecoration: 'none' },
  linkMuted: { color: '#94A3B8', textDecoration: 'none' },
  success: { display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: 440 },
  successIcon: { fontSize: 56, marginBottom: 16 },
  panel: { flex: 1, background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 60%, #0F172A 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 64, position: 'relative', overflow: 'hidden' },
  panelInner: { maxWidth: 420, position: 'relative', zIndex: 1 },
  glow: { position: 'absolute', top: -100, right: -100, width: 400, height: 400, background: 'radial-gradient(circle, rgba(249,115,22,0.18) 0%, transparent 70%)', borderRadius: '50%' },
  panelBadge: { display: 'inline-block', background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA', fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 99, marginBottom: 24 },
  panelHeading: { fontFamily: "'Sora', sans-serif", fontSize: 44, fontWeight: 800, color: 'white', lineHeight: 1.1, margin: '0 0 20px', letterSpacing: '-1px' },
  panelSub: { fontSize: 15, color: 'rgba(255,255,255,0.65)', lineHeight: 1.75, margin: '0 0 32px' },
  statsRow: { display: 'flex', gap: 16 },
  stat: { display: 'flex', flexDirection: 'column', gap: 4, padding: '16px 20px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, minWidth: 90 },
  statVal: { fontFamily: "'Sora', sans-serif", fontSize: 20, fontWeight: 800, color: '#FB923C' },
  statLabel: { fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
};