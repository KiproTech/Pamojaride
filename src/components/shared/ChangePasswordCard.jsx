import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { validatePassword, validatePasswordConfirmation } from '../../lib/validation';
import PasswordInput from '../auth/PasswordInput';

// ============================================================================
// "Change Password" card for an already-authenticated passenger or driver
// (profile pages). Shared by both portals so the behaviour/validation stays
// identical rather than drifting between two copies.
//
// Uses `supabase` from src/lib/supabase.js — the route-aware proxy that
// resolves to whichever portal's isolated client matches the current path
// (see that file's comment) — so this always updates the SIGNED-IN user's
// own account via supabase.auth.updateUser(), never another user's, and
// never touches `profiles`/`driver_profiles`/`passenger_profiles` directly.
// ============================================================================
export default function ChangePasswordCard() {
  const [form, setForm] = useState({ newPassword: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const submitLockRef = useRef(false);

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitLockRef.current) return; // prevent duplicate submissions (double-click, double-enter)
    setMessage(null);

    const passwordCheck = validatePassword(form.newPassword);
    if (!passwordCheck.valid) { setMessage({ type: 'danger', text: passwordCheck.error }); return; }

    const confirmCheck = validatePasswordConfirmation(form.newPassword, form.confirm);
    if (!confirmCheck.valid) { setMessage({ type: 'danger', text: confirmCheck.error }); return; }

    submitLockRef.current = true;
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: form.newPassword });
      if (error) throw new Error(error.message || 'Could not update your password. Please try again.');
      setMessage({ type: 'success', text: 'Password updated successfully.' });
      setForm({ newPassword: '', confirm: '' });
    } catch (err) {
      setMessage({ type: 'danger', text: err.message || 'Something went wrong. Please check your connection and try again.' });
    } finally {
      submitLockRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="card card-pad">
      <h3 style={{ fontSize: 16, marginBottom: 16 }}>Change Password</h3>
      {message && <div className={`alert alert-${message.type}`} style={{ marginBottom: 14 }}>{message.text}</div>}
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} noValidate>
        <div className="form-group">
          <label className="form-label" htmlFor="change-password-new">New Password</label>
          <PasswordInput
            id="change-password-new"
            className="form-input"
            value={form.newPassword}
            onChange={set('newPassword')}
            placeholder="At least 6 characters"
            autoComplete="new-password"
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="change-password-confirm">Confirm New Password</label>
          <PasswordInput
            id="change-password-confirm"
            className="form-input"
            value={form.confirm}
            onChange={set('confirm')}
            autoComplete="new-password"
          />
        </div>
        <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={saving}>
          {saving ? <span className="spinner" /> : 'Update password'}
        </button>
      </form>
    </div>
  );
}
