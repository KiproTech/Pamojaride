import { useEffect, useState } from 'react';
import DashboardLayout from '../../components/shared/DashboardLayout';
import { fetchSupportContacts, updateSupportContacts } from '../../lib/support/supportContacts';
import { validateEmail } from '../../lib/validation';
import { formatSupportDate } from '../../lib/support/supportLabels';

// Admin → Settings → Support Contacts, at /admin/settings/support-contacts.
// Manages the ONE centrally-stored row of PamojaRide's own support
// contact details (database/admin_support_contacts_foundation.sql) —
// NOT a passenger's or driver's personal contact info, and NOT the
// separate `support_requests` ticket queue at /admin/support.
//
// Foundation only (Prompt 9/20): this page lets Admin view and update the
// values and persists them centrally so a future page can read them
// instead of a hardcoded value. Wiring these contacts into the
// Passenger/Driver Help & Support pages and elsewhere is Prompt 10/20.
export default function SupportContacts() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [supportPhone, setSupportPhone] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [facebookUrl, setFacebookUrl] = useState('');
  const [twitterUrl, setTwitterUrl] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      const { contacts, error: err } = await fetchSupportContacts();
      if (cancelled) return;
      if (err) {
        setLoadError("We couldn't load support contacts right now. Please refresh the page.");
      } else {
        setSupportEmail(contacts.support_email || '');
        setSupportPhone(contacts.support_phone || '');
        setWhatsappNumber(contacts.whatsapp_number || '');
        setFacebookUrl(contacts.facebook_url || '');
        setTwitterUrl(contacts.twitter_url || '');
        setUpdatedAt(contacts.updated_at || null);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setError('');
    setSuccess(false);

    // Support email is the one field the rest of the app already relies
    // on elsewhere (receipts, PDFs, status pages) — keep it required and
    // well-formed. Every other field is optional; PamojaRide may not
    // have all of these set up at once.
    const trimmedEmail = supportEmail.trim();
    if (!trimmedEmail) { setError('Support email is required.'); return; }
    const emailResult = validateEmail(trimmedEmail);
    if (!emailResult.valid) { setError(emailResult.error); return; }

    setSaving(true);
    const { error: updateError } = await updateSupportContacts({
      supportEmail: emailResult.value,
      supportPhone,
      whatsappNumber,
      facebookUrl,
      twitterUrl,
    });
    setSaving(false);

    if (updateError) { setError(updateError.message); return; }

    setSuccess(true);
    const { contacts } = await fetchSupportContacts();
    setUpdatedAt(contacts.updated_at || null);
  }

  return (
    <DashboardLayout title="Settings">
      <div className="page-header">
        <h1>Support Contacts</h1>
        <p>Manage PamojaRide's own support contact details. These are system-wide contacts, shown across the app — not a personal contact for you or any driver/passenger.</p>
      </div>

      <div className="card card-pad" style={{ maxWidth: 560 }}>
        {loading ? (
          <p style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>Loading…</p>
        ) : loadError ? (
          <div className="alert alert-danger">{loadError}</div>
        ) : (
          <form onSubmit={handleSubmit}>
            {success && (
              <div className="alert alert-success" style={{ marginBottom: 16 }}>
                Support contacts updated.
              </div>
            )}
            {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

            <div className="form-group">
              <label className="form-label">Support Email <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                className="form-input"
                type="email"
                value={supportEmail}
                onChange={e => setSupportEmail(e.target.value)}
                placeholder="support@pamojaride.co.ke"
              />
            </div>

            <div className="form-group" style={{ marginTop: 14 }}>
              <label className="form-label">Support Phone Number</label>
              <input
                className="form-input"
                value={supportPhone}
                onChange={e => setSupportPhone(e.target.value)}
                placeholder="e.g. 0700 000 000"
              />
            </div>

            <div className="form-group" style={{ marginTop: 14 }}>
              <label className="form-label">WhatsApp Number</label>
              <input
                className="form-input"
                value={whatsappNumber}
                onChange={e => setWhatsappNumber(e.target.value)}
                placeholder="e.g. +254 700 000 000"
              />
            </div>

            <div className="form-group" style={{ marginTop: 14 }}>
              <label className="form-label">Facebook</label>
              <input
                className="form-input"
                value={facebookUrl}
                onChange={e => setFacebookUrl(e.target.value)}
                placeholder="https://facebook.com/pamojaride"
              />
            </div>

            <div className="form-group" style={{ marginTop: 14 }}>
              <label className="form-label">Twitter/X</label>
              <input
                className="form-input"
                value={twitterUrl}
                onChange={e => setTwitterUrl(e.target.value)}
                placeholder="https://x.com/pamojaride"
              />
            </div>

            <button className="btn btn-primary btn-full" style={{ marginTop: 18 }} disabled={saving} type="submit">
              {saving ? <span className="spinner" /> : 'Save changes'}
            </button>

            {updatedAt && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, textAlign: 'center' }}>
                Last updated {formatSupportDate(updatedAt)}
              </p>
            )}
          </form>
        )}
      </div>
    </DashboardLayout>
  );
}
