import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Shown on the driver dashboard based on verification_status:
//   'unverified' / 'rejected'  -> dismissible modal (reappears next visit)
//   'pending_verification'     -> lighter banner, no modal
//   'verified'                 -> renders nothing
//
// The dashboard underneath always renders normally — this only overlays it.
export default function VerificationPopup({ status, rejectionReason }) {
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();

  if (status === 'verified') return null;

  if (status === 'pending_verification') {
    return (
      <div style={styles.banner}>
        <span style={styles.bannerIcon}>⏳</span>
        <div style={{ flex: 1 }}>
          <strong style={styles.bannerTitle}>Verification under review</strong>
          <p style={styles.bannerText}>Our team is checking your documents — usually within 24 hours. You'll be able to post trips as soon as you're approved.</p>
        </div>
      </div>
    );
  }

  if (dismissed) return null;

  const rejected = status === 'rejected';

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <button style={styles.closeBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">✕</button>
        <div style={styles.icon}>{rejected ? '⚠️' : '🪪'}</div>
        <h2 style={styles.title}>{rejected ? 'Verification needs another look' : 'Complete your verification'}</h2>
        <p style={styles.text}>
          {rejected
            ? <>Your last submission wasn't approved{rejectionReason ? <>: <strong>{rejectionReason}</strong></> : '.'} You can fix the details and resubmit.</>
            : "You're all set to explore the app — but you'll need to verify your licence and vehicle before you can post your first trip."}
        </p>
        <button style={styles.primaryBtn} onClick={() => navigate('/driver/verification')}>
          {rejected ? 'Resubmit documents →' : 'Complete verification →'}
        </button>
        <button style={styles.secondaryBtn} onClick={() => setDismissed(true)}>Remind me later</button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
  },
  modal: {
    position: 'relative', background: 'white', borderRadius: 16, padding: '40px 36px',
    maxWidth: 420, width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    fontFamily: "'DM Sans', sans-serif",
  },
  closeBtn: {
    position: 'absolute', top: 16, right: 16, background: 'none', border: 'none',
    fontSize: 16, color: '#94A3B8', cursor: 'pointer', padding: 4,
  },
  icon: { fontSize: 44, marginBottom: 12 },
  title: { fontFamily: "'Sora', sans-serif", fontSize: 22, fontWeight: 800, color: '#0F172A', margin: '0 0 10px' },
  text: { fontSize: 14, color: '#64748B', lineHeight: 1.7, margin: '0 0 24px' },
  primaryBtn: {
    width: '100%', padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, #EA580C, #C2410C)',
    color: 'white', fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif", boxShadow: '0 4px 16px rgba(234,88,12,0.3)', marginBottom: 10,
  },
  secondaryBtn: {
    width: '100%', padding: 12, borderRadius: 10, background: 'transparent', color: '#64748B',
    fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
  },
  banner: {
    display: 'flex', alignItems: 'flex-start', gap: 14, background: '#FFFBEB', border: '1px solid #FDE68A',
    borderRadius: 12, padding: '16px 20px', margin: '0 0 24px', fontFamily: "'DM Sans', sans-serif",
  },
  bannerIcon: { fontSize: 20, lineHeight: 1 },
  bannerTitle: { display: 'block', fontSize: 14, color: '#92400E', marginBottom: 4 },
  bannerText: { margin: 0, fontSize: 13, color: '#92400E', lineHeight: 1.6 },
};