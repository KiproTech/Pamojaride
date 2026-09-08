import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TERMS_VERSION } from '../../lib/legal/termsContent';
import TermsPrivacyModal from './TermsPrivacyModal';

// Shown on both passenger and driver Profile pages (Requirement 4: Terms &
// Privacy accessible later from the app, not just at registration).
//
// Also doubles as the visible half of Requirement 5 ("consent... can be
// audited later") — this reads the exact same profiles.terms_accepted /
// terms_accepted_at / terms_version columns an admin would query directly,
// so what the user sees here always matches what's recorded server-side.
//
// For an account created BEFORE this feature existed, terms_accepted is
// simply false/null (see terms_privacy_consent.sql — ADD COLUMN ... DEFAULT
// false is non-destructive). This card never blocks or interrupts that
// user's use of the app (Requirement 6) — it only offers a one-click,
// entirely optional way to record consent going forward, using the exact
// same own-row profiles.update() every other profile edit already uses.
export default function LegalConsentCard({ profile, updateProfile }) {
  const [showTerms, setShowTerms] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState('');

  const accepted = !!profile?.terms_accepted;

  async function handleAcceptNow() {
    setAccepting(true);
    setAcceptError('');
    const { error } = await updateProfile({ terms_accepted: true, terms_version: TERMS_VERSION });
    if (error) setAcceptError(error.message);
    setAccepting(false);
  }

  return (
    <div className="card card-pad">
      <div className="flex-between" style={{ marginBottom: 8 }}>
        <h3 style={{ fontSize: 16 }}>Terms & Privacy</h3>
        {accepted ? (
          <span className="badge badge-green">✓ Agreed</span>
        ) : (
          <span className="badge badge-amber">Not yet recorded</span>
        )}
      </div>

      {accepted ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          You agreed to the PamojaRide Terms & Conditions and Privacy Policy
          {profile?.terms_version ? ` (version ${profile.terms_version})` : ''}
          {profile?.terms_accepted_at ? ` on ${new Date(profile.terms_accepted_at).toLocaleString()}` : ''}.
        </p>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          Your account was created before we started recording this. Your access isn't affected either way —
          you're welcome to review and record your agreement whenever you'd like.
        </p>
      )}

      {acceptError && (
        <p style={{ fontSize: 12, color: '#DC2626', margin: '0 0 12px' }}>{acceptError}</p>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" onClick={() => setShowTerms(true)}>
          Read Terms & Privacy Policy
        </button>
        <Link to="/legal/terms" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
          Open full page ↗
        </Link>
        {!accepted && (
          <button type="button" className="btn btn-primary" onClick={handleAcceptNow} disabled={accepting}>
            {accepting ? 'Saving…' : 'I agree — record my acceptance'}
          </button>
        )}
      </div>

      {showTerms && <TermsPrivacyModal onClose={() => setShowTerms(false)} />}
    </div>
  );
}
