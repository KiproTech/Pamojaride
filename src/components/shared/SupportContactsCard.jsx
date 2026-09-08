import { useEffect, useState } from 'react';
import { fetchSupportContacts } from '../../lib/support/supportContacts';
import { toTelHref, toWhatsappHref, toMailtoHref, toSafeUrl, displayValue } from '../../lib/support/contactLinks';

// Reads the ONE centrally-stored, Admin-managed support contacts row
// (database/admin_support_contacts_foundation.sql, lib/support/
// supportContacts.js) and renders it as ready-to-use action buttons. Used
// by both portals:
//   - pages/passenger/Support.jsx (via components/shared/SupportPage.jsx)
//   - pages/driver/Support.jsx    (via components/shared/SupportPage.jsx)
//
// Always reflects whatever Admin currently has saved at
// /admin/settings/support-contacts — nothing here is hardcoded, and a
// channel Admin hasn't filled in simply doesn't render a button for it.
export default function SupportContactsCard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [contacts, setContacts] = useState(null);

  async function load({ cancelled = { current: false } } = {}) {
    setLoading(true);
    setError(false);
    const { contacts: data, error: err } = await fetchSupportContacts();
    if (cancelled.current) return;
    if (err) {
      setError(true);
      setContacts(null);
    } else {
      setContacts(data);
    }
    setLoading(false);
  }

  useEffect(() => {
    const cancelled = { current: false };
    load({ cancelled });
    return () => { cancelled.current = true; };
  }, []);

  if (loading) {
    return (
      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 10 }}>Contact PamojaRide Support</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spinner" /> Loading support contacts…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 10 }}>Contact PamojaRide Support</h3>
        <div className="alert alert-danger" style={{ marginBottom: 12 }}>
          We couldn't load support contacts right now.
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => load()}>
          Try again
        </button>
      </div>
    );
  }

  const channels = [
    {
      key: 'email',
      icon: '✉️',
      label: 'Email',
      value: displayValue(contacts.support_email),
      href: toMailtoHref(contacts.support_email),
    },
    {
      key: 'phone',
      icon: '📞',
      label: 'Call',
      value: displayValue(contacts.support_phone),
      href: toTelHref(contacts.support_phone),
    },
    {
      key: 'whatsapp',
      icon: '💬',
      label: 'WhatsApp',
      value: displayValue(contacts.whatsapp_number),
      href: toWhatsappHref(contacts.whatsapp_number),
    },
    {
      key: 'facebook',
      icon: '📘',
      label: 'Facebook',
      value: 'PamojaRide on Facebook',
      href: toSafeUrl(contacts.facebook_url),
    },
    {
      key: 'twitter',
      icon: '🐦',
      label: 'Twitter / X',
      value: 'PamojaRide on Twitter / X',
      href: toSafeUrl(contacts.twitter_url),
    },
  ].filter(channel => channel.href);

  return (
    <div className="card card-pad">
      <h3 style={{ fontSize: 15, marginBottom: 10 }}>Contact PamojaRide Support</h3>

      {channels.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>
          No support contacts have been set up yet. Please use the form below to reach us.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', margin: '0 0 12px' }}>
            Reach our team directly through any of the channels below:
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {channels.map(channel => (
              <a
                key={channel.key}
                className="btn btn-outline btn-sm"
                href={channel.href}
                target={channel.key === 'facebook' || channel.key === 'twitter' || channel.key === 'whatsapp' ? '_blank' : undefined}
                rel={channel.key === 'facebook' || channel.key === 'twitter' || channel.key === 'whatsapp' ? 'noopener noreferrer' : undefined}
                title={channel.value}
              >
                <span aria-hidden="true">{channel.icon}</span> {channel.label}
              </a>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            For the fastest response, submit a request below instead — it's automatically linked to your
            account and any relevant booking, and you can track its status here.
          </p>
        </>
      )}
    </div>
  );
}
