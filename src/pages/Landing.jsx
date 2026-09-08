import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchSupportContacts } from '../lib/support/supportContacts';
import { toTelHref, toWhatsappHref, toMailtoHref, toSafeUrl, displayValue } from '../lib/support/contactLinks';

// Single logo mark used everywhere in the app (Sidebar.jsx, all auth
// pages) — /Vite.svg is the only logo asset; nothing new is created here.
// `size` controls the glyph box; the wordmark scales alongside it.
function Logo({ size = 32, dark = false }) {
  // Vite.svg has a transparent background, so it sits directly on a plain
  // white box here — no colored container behind it. Sized up slightly
  // (1.6x the wordmark size) so it stays clearly visible without a
  // background to set it off.
  const glyphSize = Math.round(size * 1.6);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{
        width: glyphSize + 10, height: glyphSize + 10,
        background: '#FFFFFF',
        borderRadius: '10px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <img
          src="/Vite.svg"
          alt="PamojaRide logo"
          width={glyphSize}
          height={glyphSize}
          style={{ objectFit: 'contain' }}
        />
      </div>
      <span style={{
        fontFamily: 'var(--font-display)',
        fontSize: size,
        fontWeight: 800,
        color: dark ? 'white' : 'var(--text)',
        letterSpacing: '-0.5px',
        lineHeight: 1,
      }}>
        Pamoja<span style={{ color: 'var(--accent)' }}>Ride</span>
      </span>
    </div>
  );
}

function StepCard({ number, title, desc }) {
  return (
    <div className="lp-step">
      <div className="lp-step-num">{number}</div>
      <h4>{title}</h4>
      <p>{desc}</p>
    </div>
  );
}

// Reads the SAME centrally-stored, Admin-managed support contacts row that
// every other portal reads (database/admin_support_contacts_foundation.sql,
// lib/support/supportContacts.js — same fetchSupportContacts() and
// contactLinks helpers used by SupportContactsCard.jsx, receiptPdf.js, and
// driverBookingReport.js). This is not a second contact system: it is a
// public-facing, read-only presentation of the exact same row, so whatever
// Admin saves at /admin/settings/support-contacts changes here too, with
// no separate data source and nothing hardcoded. A channel Admin hasn't
// filled in simply never renders.
function LandingContactSection() {
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { contacts: data } = await fetchSupportContacts();
      if (!cancelled) {
        setContacts(data);
        setLoading(false);
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
    <section className="lp-section" style={{ background: 'var(--bg-alt)' }}>
      <div className="lp-section-inner">
        <div className="lp-section-head">
          <h2>Need help?</h2>
          <p>Our support team is reachable through any of the channels below.</p>
        </div>

        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>Loading contact details…</p>
        ) : channels.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>
            Support contacts will be published here shortly. Passengers and drivers can also reach us
            from the in-app Help &amp; Support page.
          </p>
        ) : (
          <div className="lp-contact-channels">
            {channels.map(c => (
              <a
                key={c.key}
                className="btn btn-outline"
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
    </section>
  );
}

export default function Landing() {
  return (
    <div className="landing-page">

      {/* Navbar */}
      <nav className="landing-nav">
        <Logo size={26} />
        <div className="landing-nav-actions">
          <Link to="/passenger/login"><button className="btn btn-ghost btn-sm">Passenger Login</button></Link>
          <Link to="/driver/login"><button className="btn btn-outline btn-sm">Driver Login</button></Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-hero-glow" />
        <div className="landing-hero-inner">
          <div style={{
            display: 'inline-block', background: 'rgba(249,115,22,0.2)',
            border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA',
            padding: '4px 14px', borderRadius: '99px',
            fontSize: '13px', fontWeight: 600, marginBottom: '20px',
          }}>
            🇰🇪 Kenya's Intercity Ride-Sharing Marketplace
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontWeight: 800, color: 'white',
            lineHeight: 1.1, marginBottom: '16px',
          }}>
            Share the road. Split the cost.
          </h1>
          <p className="lp-subtext" style={{
            color: 'rgba(255,255,255,0.82)', lineHeight: 1.7, marginBottom: '8px',
            maxWidth: '560px', marginLeft: 'auto', marginRight: 'auto',
          }}>
            PamojaRide connects passengers with verified drivers on scheduled intercity
            routes across Kenya — book a seat, pay via M-Pesa, and travel with confidence.
          </p>
          <div className="lp-cta-row">
            <Link to="/passenger/register" style={{ flex: '1 1 220px', maxWidth: '280px' }}>
              <button className="btn btn-lg btn-full" style={{ background: 'var(--accent)', color: 'white', boxShadow: '0 4px 16px rgba(249,115,22,0.4)' }}>
                🚌 I'm a Passenger
              </button>
            </Link>
            <Link to="/driver/register" style={{ flex: '1 1 220px', maxWidth: '280px' }}>
              <button className="btn btn-lg btn-full" style={{ background: 'rgba(255,255,255,0.14)', color: 'white', border: '1.5px solid rgba(255,255,255,0.35)' }}>
                🚗 I'm a Driver
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="lp-section">
        <div className="lp-section-inner">
          <div className="lp-section-head">
            <h2>How it works</h2>
            <p>Three simple steps, whether you're riding or driving.</p>
          </div>
          <div className="lp-steps">
            <StepCard number="1" title="Create your account" desc="Sign up as a passenger or a verified driver in just a few minutes." />
            <StepCard number="2" title="Search or post a trip" desc="Passengers book available seats. Drivers post routes, dates, and pricing." />
            <StepCard number="3" title="Travel & pay via M-Pesa" desc="Confirm seats, pay securely, and get notified the moment your trip starts." />
          </div>
        </div>
      </section>

      {/* Contact / Support — centralized Support Contacts, not hardcoded */}
      <LandingContactSection />

      {/* Footer */}
      <footer className="landing-footer">
        <Logo size={20} />
        <div className="landing-footer-links">
          <Link to="/passenger/register">Passenger Sign Up</Link>
          <Link to="/driver/register">Driver Sign Up</Link>
          <Link to="/passenger/login">Login</Link>
        </div>
        <span className="landing-footer-copy">© 2026 PamojaRide · Built for Kenya 🇰🇪</span>
      </footer>

    </div>
  );
}
