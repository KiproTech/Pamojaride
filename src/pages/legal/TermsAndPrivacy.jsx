import { Link } from 'react-router-dom';
import { TERMS_SECTIONS, TERMS_VERSION, TERMS_LAST_UPDATED } from '../../lib/legal/termsContent';

// Standalone, permalink-able version of the same content shown in
// TermsPrivacyModal.jsx — same source module (termsContent.js), so the two
// can never drift out of sync. Deliberately NOT wrapped in
// ProtectedRoute/PublicRoute in App.jsx: it must be reachable by anyone,
// logged in or not, on any portal, exactly like reset-password.jsx is for
// the same "must not be gated" reason. Linked from:
//   - PassengerRegister.jsx / DriverRegister.jsx (via the modal's
//     "open in a new tab" link)
//   - Landing.jsx footer
//   - Sidebar.jsx (visible from every logged-in dashboard)
//   - LegalConsentCard.jsx (Profile pages)
export default function TermsAndPrivacy() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <Link to="/" style={styles.logo}>
          <img src="/Vite.svg" alt="" style={{ width: 28, height: 28 }} />
          <span style={styles.logoText}>Pamoja<span style={styles.logoAccent}>Ride</span></span>
        </Link>

        <h1 style={styles.heading}>Terms & Conditions and Privacy Policy</h1>
        <p style={styles.sub}>Version {TERMS_VERSION} · Last updated {TERMS_LAST_UPDATED}</p>
        <p style={styles.intro}>
          One Terms & Conditions and one Privacy Policy apply platform-wide, to both passengers and drivers.
          Section 5 contains additional provisions that apply to driver accounts specifically.
        </p>

        <nav style={styles.toc} aria-label="Sections">
          {TERMS_SECTIONS.map(s => (
            <a key={s.id} href={`#${s.id}`} style={styles.tocLink}>{s.title}</a>
          ))}
        </nav>

        {TERMS_SECTIONS.map(section => (
          <section key={section.id} id={section.id} style={styles.section}>
            <h2 style={styles.sectionTitle}>{section.title}</h2>
            {section.paragraphs.map((p, i) => (
              <p key={i} style={styles.paragraph}>{p}</p>
            ))}
          </section>
        ))}

        <div style={styles.footerLinks}>
          <Link to="/passenger/register" style={styles.link}>Register as a passenger</Link>
          <span style={{ color: '#CBD5E1' }}>·</span>
          <Link to="/driver/register" style={styles.link}>Register as a driver</Link>
          <span style={{ color: '#CBD5E1' }}>·</span>
          <Link to="/" style={styles.link}>Back to PamojaRide</Link>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#F8FAFC', fontFamily: "'DM Sans', sans-serif", padding: '48px 20px' },
  card: { maxWidth: 760, margin: '0 auto', background: 'white', borderRadius: 16, padding: '48px 56px', boxShadow: '0 4px 24px rgba(15,23,42,0.06)' },
  logo: { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', marginBottom: 32 },
  logoText: { fontFamily: "'Sora', sans-serif", fontSize: 20, fontWeight: 800, color: '#0F172A' },
  logoAccent: { color: '#F97316' },
  heading: { fontFamily: "'Sora', sans-serif", fontSize: 32, fontWeight: 800, color: '#0F172A', margin: '0 0 8px', letterSpacing: '-0.5px' },
  sub: { fontSize: 13, color: '#94A3B8', margin: '0 0 20px', fontWeight: 600 },
  intro: { fontSize: 14.5, lineHeight: 1.7, color: '#475569', margin: '0 0 28px' },
  toc: { display: 'flex', flexDirection: 'column', gap: 6, background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 12, padding: 18, marginBottom: 32 },
  tocLink: { fontSize: 13, color: '#0E7490', textDecoration: 'none', fontWeight: 600 },
  section: { marginBottom: 28 },
  sectionTitle: { fontFamily: "'Sora', sans-serif", fontSize: 17, fontWeight: 700, color: '#0F172A', margin: '0 0 10px' },
  paragraph: { fontSize: 14.5, lineHeight: 1.8, color: '#475569', margin: '0 0 12px' },
  footerLinks: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 40, paddingTop: 24, borderTop: '1px solid #E2E8F0' },
  link: { color: '#0E7490', fontWeight: 600, fontSize: 13, textDecoration: 'none' },
};
