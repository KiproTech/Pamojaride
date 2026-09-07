import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';

// This runs under /admin/login, so the portal-aware `supabase` import
// (see lib/supabase.js) automatically resolves to the isolated admin
// client — its session lives under its own storage key and never
// collides with a driver or passenger session open in the same browser.
export default function AdminLogin() {
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

      // is_admin is checked against the profiles table — the
      // server-controlled source of truth — not client-writable metadata.
      const { data: profileRow, error: profileError } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', data.user.id)
        .single();
      if (profileError) throw new Error(profileError.message);

      if (!profileRow.is_admin) {
        await supabase.auth.signOut();
        throw new Error('This account does not have admin access.');
      }

      navigate('/admin/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.badge}>🔒 Admin</div>
        <h1 style={styles.heading}>Admin sign in</h1>
        <p style={styles.sub}>Restricted access. This session is independent of any driver or passenger session open in this browser.</p>

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
            <input style={styles.input} type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input style={styles.input} type="password" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <button type="submit" style={loading ? { ...styles.btn, opacity: 0.7 } : styles.btn} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", background: '#0F172A' },
  card: { width: 420, padding: '48px 40px', background: 'white', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' },
  badge: { display: 'inline-block', background: '#F1F5F9', color: '#334155', fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, marginBottom: 16 },
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 26, fontWeight: 800, color: '#0F172A', margin: '0 0 8px' },
  sub: { fontSize: 13.5, color: '#64748B', margin: '0 0 24px', lineHeight: 1.5 },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  input: { padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', fontSize: 15, outline: 'none', background: '#F8FAFC', width: '100%', boxSizing: 'border-box' },
  btn: { marginTop: 6, padding: 14, borderRadius: 10, background: '#0F172A', color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer' },
};
