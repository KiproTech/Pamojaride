import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

// Shown by App.jsx's ProtectedRoute whenever statusFor(role).isBanned is
// true — before this role's dashboard ever renders. A banned account can
// still sign out and submit an appeal (stored in the existing `reports`
// table, category 'other', so admins can review it without a new table),
// but nothing else.
export default function Banned({ reason }) {
  const { user, profile, portal, supabase, signOut } = useAuth();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function submitAppeal(e) {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    setError('');
    const { error: insertError } = await supabase.from('reports').insert({
      reporter_id: user.id,
      category: 'other',
      description: `[Account appeal — ${portal} account banned]\n\nBan reason on file: ${reason || 'not specified'}\n\nDriver's message:\n${message.trim()}`,
    });
    setSubmitting(false);
    if (insertError) { setError('Could not submit right now — please try again.'); return; }
    setSubmitted(true);
  }

  return (
    <div className="page-layout" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex', minHeight: '100vh', padding: 24 }}>
      <div className="card card-pad" style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🚫</div>
        <span className="badge badge-danger">Account Banned</span>
        <h1 style={{ fontSize: 21, margin: '14px 0 8px' }}>Your {portal} account has been banned</h1>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, margin: '0 0 16px' }}>
          You no longer have access to {portal} features on PamojaRide. If you believe this was a mistake,
          you can submit information below for our team to review.
        </p>

        {reason && (
          <div className="alert alert-danger" style={{ textAlign: 'left', marginBottom: 20 }}>
            <strong>Reason given:</strong> {reason}
          </div>
        )}

        {submitted ? (
          <div className="alert alert-success" style={{ textAlign: 'left', marginBottom: 20 }}>
            Thanks — your appeal has been sent to our team. We'll review it and reach out if we need anything else.
          </div>
        ) : (
          <form onSubmit={submitAppeal} style={{ textAlign: 'left', marginBottom: 20 }}>
            <div className="form-group">
              <label className="form-label">Submit information / appeal</label>
              <textarea
                className="form-input"
                rows={4}
                style={{ resize: 'vertical' }}
                placeholder="Explain your situation — our team will review it."
                value={message}
                onChange={e => setMessage(e.target.value)}
              />
            </div>
            {error && <div className="form-error" style={{ marginBottom: 8 }}>{error}</div>}
            <button className="btn btn-primary btn-sm" disabled={submitting || !message.trim()}>
              {submitting ? <span className="spinner" /> : 'Submit information'}
            </button>
          </form>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a className="btn btn-outline btn-sm" href="mailto:support@pamojaride.co.ke">Contact Support</a>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Log out</button>
        </div>
      </div>
    </div>
  );
}
