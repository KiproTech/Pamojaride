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

export default function PassengerRegister() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: name,
            phone,
            role: 'passenger',
            account_source: 'email_password',
          },
        },
      });

      if (signUpError) {
        const alreadyRegistered = signUpError.message?.toLowerCase().includes('already registered');
        if (!alreadyRegistered) throw new Error(signUpError.message);

        // This email already has an identity (e.g. a driver account).
        // Don't create a second one — sign in with the password they just
        // typed and attach a passenger profile to the existing identity.
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) {
          throw new Error(
            'An account already exists for this email. Enter the password for that account to add a passenger profile to it.'
          );
        }

        const { data: { user: existingUser } } = await supabase.auth.getUser();
        const { data: existingPassenger } = await supabase
          .from('passenger_profiles')
          .select('profile_id')
          .eq('profile_id', existingUser.id)
          .maybeSingle();

        if (existingPassenger) {
          throw new Error('This account already has a passenger profile. Please use the passenger login instead.');
        }

        const { error: insertError } = await supabase
          .from('passenger_profiles')
          .insert({ profile_id: existingUser.id });
        if (insertError) throw new Error(insertError.message);

        navigate('/passenger/dashboard');
        return;
      }

      if (!data.session) {
        // Supabase Auth's "email confirmation" project setting is on — the
        // account exists but isn't active yet. The profile-creation trigger
        // has already run, but sending them to the dashboard now would show
        // an unauthenticated/broken state, and would misleadingly imply the
        // account is fully active before it's confirmed. Tell them clearly
        // instead, same as DriverRegister.jsx does for the same case.
        setNeedsEmailConfirmation(true);
        setLoading(false);
        return;
      }

      navigate('/passenger/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (needsEmailConfirmation) {
    return (
      <div className="auth-split-page" style={styles.page}>
        <div className="auth-split-panel" style={styles.panel}>
          <div style={styles.panelInner}>
            <div style={styles.panelBadge}>🇰🇪 Free to join</div>
            <h2 style={styles.panelHeading}>Travel smarter<br />across Kenya.</h2>
            <p style={styles.panelSub}>Verified drivers. Real-time updates. M-Pesa payments. Book your seat before you leave the house.</p>
          </div>
        </div>
        <div className="auth-split-card" style={styles.card}>
          <Link to="/" style={styles.logo}>
            <img src="/Vite.svg" alt="logo" style={{ width: 32, height: 32 }} />
            <span style={styles.logoText}>Pamoja<span style={styles.logoAccent}>Ride</span></span>
          </Link>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📧</div>
          <h1 style={styles.heading}>Confirm your email</h1>
          <p style={styles.sub}>
            We sent a confirmation link to <strong>{form.email}</strong>. Confirm it, then sign in to reach your dashboard.
          </p>
          <Link to="/passenger/login" style={{ width: '100%' }}>
            <button style={styles.btn}>Go to Passenger Login</button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-split-page" style={styles.page}>
      <div className="auth-split-panel" style={styles.panel}>
        <div style={styles.panelInner}>
          <div style={styles.panelBadge}>🇰🇪 Free to join</div>
          <h2 style={styles.panelHeading}>Travel smarter<br />across Kenya.</h2>
          <p style={styles.panelSub}>Verified drivers. Real-time updates. M-Pesa payments. Book your seat before you leave the house.</p>
          <div style={styles.features}>
            {['✓  Verified drivers', '✓  M-Pesa payments', '✓  Real-time updates', '✓  Safe & affordable'].map(f => (
              <div key={f} style={styles.featureItem}>{f}</div>
            ))}
          </div>
        </div>
      </div>

      <div className="auth-split-card" style={styles.card}>
        <Link to="/" style={styles.logo}>
          <img src="/Vite.svg" alt="logo" style={{ width: 32, height: 32 }} />
          <span style={styles.logoText}>Pamoja<span style={styles.logoAccent}>Ride</span></span>
        </Link>
        <div style={styles.badge}>🚌 Passenger</div>
        <h1 style={styles.heading}>Create your account</h1>
        <p style={styles.sub}>No ID required. Takes under a minute.</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Full Name</label>
            <input style={styles.input} placeholder="Jane Mwangi" value={form.name} onChange={set('name')} autoComplete="name" />
            <span style={styles.hint}>First and last name, e.g. "Jane Mwangi".</span>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Email Address</label>
            <input style={styles.input} type="email" placeholder="jane@example.com" value={form.email} onChange={set('email')} autoComplete="email" />
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
          <button type="submit" style={loading ? { ...styles.btn, opacity: 0.7 } : styles.btn} disabled={loading}>
            {loading ? 'Creating account…' : 'Create Account →'}
          </button>
        </form>

        <p style={styles.footer}>Already have an account?{' '}<Link to="/passenger/login" style={styles.link}>Sign in</Link></p>
        <p style={styles.footer}><Link to="/driver/register" style={styles.linkMuted}>Register as a driver instead</Link></p>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans', sans-serif", background: '#F8FAFC' },
  panel: { flex: 1, background: 'linear-gradient(135deg, #0E7490 0%, #155E75 55%, #0F172A 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 64 },
  panelInner: { maxWidth: 400 },
  panelBadge: { display: 'inline-block', background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA', fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 99, marginBottom: 24 },
  panelHeading: { fontFamily: "'Sora', sans-serif", fontSize: 44, fontWeight: 800, color: 'white', lineHeight: 1.1, margin: '0 0 20px', letterSpacing: '-1px' },
  panelSub: { fontSize: 15, color: 'rgba(255,255,255,0.75)', lineHeight: 1.75, margin: '0 0 32px' },
  features: { display: 'flex', flexDirection: 'column', gap: 12 },
  featureItem: { fontSize: 14, color: 'rgba(255,255,255,0.85)', fontWeight: 500 },
  card: { width: 480, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '64px 56px', background: 'white', boxShadow: '-4px 0 40px rgba(0,0,0,0.06)' },
  logo: { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', marginBottom: 36 },
  logoText: { fontFamily: "'Sora', sans-serif", fontSize: 22, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.5px' },
  logoAccent: { color: '#F97316' },
  badge: { display: 'inline-block', background: '#EFF6FF', color: '#1D4ED8', fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, marginBottom: 16, letterSpacing: '0.03em' },
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 28, fontWeight: 800, color: '#0F172A', margin: '0 0 8px', letterSpacing: '-0.5px' },
  sub: { fontSize: 15, color: '#64748B', margin: '0 0 24px' },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  hint: { fontSize: 12, color: '#94A3B8' },
  input: { padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', fontSize: 15, outline: 'none', background: '#F8FAFC', fontFamily: "'DM Sans', sans-serif", width: '100%', boxSizing: 'border-box' },
  btn: { marginTop: 4, padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, #0E7490, #155E75)', color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", boxShadow: '0 4px 16px rgba(14,116,144,0.3)', width: '100%' },
  footer: { marginTop: 14, fontSize: 13, color: '#64748B', textAlign: 'center' },
  link: { color: '#0E7490', fontWeight: 600, textDecoration: 'none' },
  linkMuted: { color: '#94A3B8', textDecoration: 'none' },
};