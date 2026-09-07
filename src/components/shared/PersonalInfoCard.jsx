import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { validateFullName, validatePhone } from '../../lib/validation';
import { uploadProfilePhoto, removeProfilePhoto, pathFromPublicUrl } from '../../lib/profilePhoto';

// ============================================================================
// "Personal Information" card — shared by Passenger and Driver Profile
// pages so the editable-field set, validation, and photo upload stay
// identical rather than drifting between two copies (this replaces what
// used to be two near-identical PersonalInfoCard components, one per file).
//
// EDITABLE (by design, sent to updateProfile): full_name, phone,
// profile_picture.
// NOT EDITABLE here, and deliberately never included in the update payload:
// email (Supabase Auth's, shown read-only), is_admin, national_id (KYC-
// owned), account_source, or anything on driver_profiles/passenger_profiles
// (verification_status, account_status, trust_level, etc.) — those are
// either admin-only or handled by their own dedicated flows (KYC
// submission, admin approval). Even if this component were passed a
// different `profile`, updateProfile() always targets
// `.eq('id', user.id)` from the AUTHENTICATED session in AuthContext, so
// there is no field here, and no id, that could target another user's row.
// ============================================================================
export default function PersonalInfoCard({ profile, updateProfile }) {
  const [form, setForm] = useState({ full_name: profile?.full_name || '', phone: profile?.phone || '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState(profile?.profile_picture || null);
  const submitLockRef = useRef(false);
  const fileInputRef = useRef(null);

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    if (submitLockRef.current) return; // prevent duplicate submissions (double-click, double-enter)
    setMessage(null);

    const nameCheck = validateFullName(form.full_name);
    if (!nameCheck.valid) { setMessage({ type: 'danger', text: nameCheck.error }); return; }

    const phoneCheck = validatePhone(form.phone);
    if (!phoneCheck.valid) { setMessage({ type: 'danger', text: phoneCheck.error }); return; }

    submitLockRef.current = true;
    setSaving(true);
    try {
      const { error } = await updateProfile({ full_name: nameCheck.value, phone: phoneCheck.value });
      if (error) throw new Error(error.message || 'Could not save your changes. Please try again.');
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (err) {
      // Never surface a raw Supabase/Postgres error string — updateProfile
      // only ever sends full_name/phone from here, so any failure at this
      // point is either a network issue or an unexpected server error, not
      // something the user did wrong.
      setMessage({ type: 'danger', text: err.message || 'Something went wrong. Please check your connection and try again.' });
    } finally {
      submitLockRef.current = false;
      setSaving(false);
    }
  }

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file || !supabase) return;

    setMessage(null);
    setPhotoUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You must be signed in to update your photo.');

      const { url, error: uploadError } = await uploadProfilePhoto(supabase, user.id, file);
      if (uploadError) throw new Error(uploadError.message || 'Could not upload that image.');

      const { error: saveError } = await updateProfile({ profile_picture: url });
      if (saveError) throw new Error(saveError.message || 'Uploaded, but could not save your new photo. Please try again.');

      // Clean up the file it's replacing (best-effort — a failure here
      // never blocks or reverts the successful update above).
      const oldPath = pathFromPublicUrl(photoUrl);
      if (oldPath) removeProfilePhoto(supabase, oldPath).catch(() => {});

      setPhotoUrl(url);
      setMessage({ type: 'success', text: 'Profile photo updated.' });
    } catch (err) {
      setMessage({ type: 'danger', text: err.message || 'Something went wrong uploading your photo. Please try again.' });
    } finally {
      setPhotoUploading(false);
    }
  }

  return (
    <div className="card card-pad">
      <h3 style={{ fontSize: 16, marginBottom: 16 }}>Personal Information</h3>
      {message && <div className={`alert alert-${message.type}`} style={{ marginBottom: 14 }}>{message.text}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        {photoUrl ? (
          <img
            src={photoUrl}
            alt=""
            style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border)' }}
          />
        ) : (
          <div
            style={{
              width: 64, height: 64, borderRadius: '50%', flexShrink: 0,
              background: 'var(--primary-xlight)', color: 'var(--primary-dark)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 800,
            }}
          >
            {(profile?.full_name || '?').trim().split(' ').filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?'}
          </div>
        )}
        <div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={photoUploading}
          >
            {photoUploading ? <span className="spinner" /> : (photoUrl ? 'Change photo' : 'Upload photo')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp"
            onChange={handlePhotoChange}
            style={{ display: 'none' }}
          />
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>JPG, PNG, or WEBP. Max 3MB.</p>
        </div>
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} noValidate>
        <div className="form-group">
          <label className="form-label" htmlFor="profile-full-name">Full Name</label>
          <input id="profile-full-name" className="form-input" value={form.full_name} onChange={set('full_name')} autoComplete="name" />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="profile-phone">Phone Number</label>
          <input id="profile-phone" className="form-input" type="tel" value={form.phone} onChange={set('phone')} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="profile-email">Email</label>
          <input id="profile-email" className="form-input" value={profile?.email || ''} disabled style={{ opacity: 0.6, cursor: 'not-allowed' }} />
        </div>
        <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={saving}>
          {saving ? <span className="spinner" /> : 'Save changes'}
        </button>
      </form>
    </div>
  );
}
