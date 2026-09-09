import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { validatePassword, validatePasswordConfirmation } from '../../lib/validation';

const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  verification_admin: 'Verification Admin',
  support_admin: 'Support Admin',
  reports_admin: 'Reports Admin',
};

// Completes an admin invitation: the invited person sets their OWN
// password here (the inviting super admin never sees or sets one). This
// mirrors the pattern DriverRegister.jsx already uses for "attach a
// second role to an existing identity" -- sign up (or sign in, if this
// email already has an identity elsewhere), then call the invitation's
// grant function, which independently re-verifies the token and email
// match server-side before doing anything privileged. See
// database/admin_management_roles_and_visibility.sql for
// accept_admin_invitation(). Styled to match AdminLogin.jsx (same
// isolated-admin-session page family).
export default function AcceptAdminInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [invite, setInvite] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadInvite() {
      if (!token) { setLoadError('This invitation link is missing its token.'); setChecking(false); return; }
      const { data, error: rpcError } = await supabase.rpc('get_admin_invitation_preview', { p_token: token });
      if (cancelled) return;
      if (rpcError || !data || data.length === 0) {
        setLoadError('This invitation link is invalid, already used, or has expired. Ask a Super Admin to send a new one.');
      } else {
        setInvite(data[0]);
      }
      setChecking(false);
    }
    loadInvite();
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Only "choosing a new password" needs the confirm-match check --
    // signing in with an EXISTING password just needs it to be non-empty.
    if (!invite.identity_exists) {
      const pwCheck = validatePassword(password);
      if (!pwCheck.valid) { setError(pwCheck.error); return; }
      const confirmCheck = validatePasswordConfirmation(password, confirm);
      if (!confirmCheck.valid) { setError(confirmCheck.error); return; }
    } else if (!password) {
      setError('Enter your existing password.');
      return;
    }

    setSubmitting(true);
    try {
      if (invite.identity_exists) {
        // This email already has an identity elsewhere (as a driver
        // and/or passenger) -- attach admin access to that SAME identity
        // rather than creating a second one. Signing in (not signing up)
        // is what keeps it one identity with multiple roles, exactly like
        // driver_profiles/passenger_profiles already coexist today.
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: invite.email, password });
        if (signInError) {
          throw new Error("That password doesn't match your existing PamojaRide account for this email. Enter the password you already use to sign in as a driver/passenger.");
        }
      } else {
        // No existing identity for this email at all -- this is a brand
        // new account, so the invitee picks a password for it here.
        const { error: signUpError } = await supabase.auth.signUp({
          email: invite.email,
          password,
          options: { data: { full_name: invite.full_name, phone: invite.phone, role: 'admin' } },
        });
        if (signUpError) throw new Error(signUpError.message);
      }

      // Grants is_admin + creates the admin_profiles row, server-side,
      // after independently re-checking the token and the caller's own
      // email match -- see accept_admin_invitation() in the SQL migration.
      const { error: acceptError } = await supabase.rpc('accept_admin_invitation', { p_token: token });
      if (acceptError) throw new Error(acceptError.message);

      setDone(true);
      setTimeout(() => navigate('/admin/dashboard', { replace: true }), 1500);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.badge}>🔒 Admin</div>
        <h1 style={styles.heading}>Set up your admin account</h1>

        {checking && <p style={styles.sub}>Checking your invitation…</p>}

        {!checking && loadError && (
          <>
            <div style={styles.error}>{loadError}</div>
            <Link to="/admin/login" style={styles.linkBtn}>Go to admin login</Link>
          </>
        )}

        {!checking && invite && !done && (
          <>
            <p style={styles.sub}>
              You've been invited as <strong>{ROLE_LABELS[invite.admin_role] || invite.admin_role}</strong> for <strong>{invite.email}</strong>.
              {invite.identity_exists ? (
                <> This email already has a PamojaRide account (as a driver and/or passenger) — sign in with that account's
                existing password to add admin access to it too. One email can be a driver, a passenger, and an admin all at once.</>
              ) : (
                <> Choose a password to activate your account — no one else, including whoever invited you, will see it.</>
              )}
            </p>
            {error && <div style={styles.error}>{error}</div>}
            <form onSubmit={handleSubmit} style={styles.form}>
              <div style={styles.field}>
                <label style={styles.label}>{invite.identity_exists ? 'Existing password' : 'Password'}</label>
                <input style={styles.input} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              {!invite.identity_exists && (
                <div style={styles.field}>
                  <label style={styles.label}>Confirm password</label>
                  <input style={styles.input} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••••••" />
                </div>
              )}
              <button type="submit" style={submitting ? { ...styles.btn, opacity: 0.7 } : styles.btn} disabled={submitting}>
                {submitting ? 'Activating…' : invite.identity_exists ? 'Sign in & activate admin access' : 'Activate admin account'}
              </button>
            </form>
          </>
        )}

        {done && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#166534', padding: '12px 14px', borderRadius: 8, fontSize: 13.5 }}>
            Your admin account is ready. Taking you to the dashboard…
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", background: '#0F172A' },
  card: { width: 440, padding: '48px 40px', background: 'white', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' },
  badge: { display: 'inline-block', background: '#F1F5F9', color: '#334155', fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 99, marginBottom: 16 },
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 24, fontWeight: 800, color: '#0F172A', margin: '0 0 8px' },
  sub: { fontSize: 13.5, color: '#64748B', margin: '0 0 20px', lineHeight: 1.5 },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  input: { padding: '12px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', fontSize: 15, outline: 'none', background: '#F8FAFC', width: '100%', boxSizing: 'border-box' },
  btn: { marginTop: 6, padding: 14, borderRadius: 10, background: '#0F172A', color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer' },
  linkBtn: { display: 'inline-block', marginTop: 8, padding: '10px 16px', borderRadius: 8, background: '#0F172A', color: 'white', fontWeight: 600, fontSize: 13, textDecoration: 'none' },
};
