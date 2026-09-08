import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fetchSupportContacts } from '../../lib/support/supportContacts';
import { toTelHref, toWhatsappHref, toMailtoHref, toSafeUrl, displayValue } from '../../lib/support/contactLinks';

// Shown by App.jsx's ProtectedRoute whenever statusFor(role).isSuspended
// is true. Suspensions are meant to be temporary/reversible by an admin
// (see UserManagement.jsx "Reactivate"), so the tone here is lighter than
// Banned — no appeal form needed, just a clear explanation and contact info.
//
// Support contacts shown below come from the SAME centralized,
// Admin-managed row every other portal reads (database/
// admin_support_contacts_foundation.sql, lib/support/supportContacts.js —
// the same fetchSupportContacts()/contactLinks helpers used by
// Landing.jsx's LandingContactSection and SupportContactsCard.jsx).
// Nothing here is hardcoded, and a channel Admin hasn't filled in simply
// never renders.
export default function Suspended({ reason }) {
  const { profile, portal, signOut } = useAuth();
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contacts, setContacts] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { contacts: data } = await fetchSupportContacts();
      if (!cancelled) {
        setContacts(data);
        setContactsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const channels = contacts ? [
    { key: 'email', icon: '✉️', label: 'Email', href: toMailtoHref(contacts.support_email), value: displayValue(contacts.support_email) },
    { key: 'phone', icon: '📞', label: 'Call', href: toTelHref(contacts.support_phone), value: displayValue(contacts.support_phone) },
    { key: 'whatsapp', icon: '💬', label: 'WhatsApp', href: toWhatsappHref(contacts.whatsapp_number), value: displayValue(contacts.whatsapp_number) },
    { key: 'facebook', icon: '📘', label: 'Facebook', href: toSafeUrl(contacts.facebook_url), value: 'Facebook' },
    { key: 'twitter', icon: '🐦', label: 'Twitter / X', href: toSafeUrl(contacts.twitter_url), value: 'Twitter / X' },
  ].filter(c => c.href) : [];

  return (
    <div className="page-layout" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex', minHeight: '100vh', padding: 24 }}>
      <div className="card card-pad" style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⏸️</div>
        <span className="badge badge-amber">Account Suspended</span>
        <h1 style={{ fontSize: 21, margin: '14px 0 8px' }}>Your {portal} account is temporarily suspended</h1>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, margin: '0 0 16px' }}>
          Your {portal} account on PamojaRide is currently suspended and under review by our team.
          This is usually temporary — you'll regain access once it's lifted. If you have questions or
          need clarification, please contact PamojaRide support using the details below.
        </p>

        {reason && (
          <div className="alert alert-amber" style={{ textAlign: 'left', marginBottom: 20 }}>
            <strong>Reason given:</strong> {reason}
          </div>
        )}

        {profile?.email && (
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 20 }}>
            When contacting support, please reference your account email
            {' '}(<strong>{profile.email}</strong>).
          </p>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Contact PamojaRide Support</h3>
          {contactsLoading ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading contact details…</p>
          ) : channels.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Support contacts will be published here shortly.
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {channels.map(c => (
                <a
                  key={c.key}
                  className="btn btn-outline btn-sm"
                  href={c.href}
                  target={c.key === 'facebook' || c.key === 'twitter' || c.key === 'whatsapp' ? '_blank' : undefined}
                  rel={c.key === 'facebook' || c.key === 'twitter' || c.key === 'whatsapp' ? 'noopener noreferrer' : undefined}
                  title={c.value}
                >
                  <span aria-hidden="true">{c.icon}</span> {c.label}
                </a>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn-outline btn-sm" to="/">Return to Landing Page</Link>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Log out</button>
        </div>
      </div>
    </div>
  );
}
