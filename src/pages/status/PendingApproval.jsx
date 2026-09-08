import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fetchSupportContacts } from '../../lib/support/supportContacts';
import { toMailtoHref } from '../../lib/support/contactLinks';

// Shown by App.jsx's ProtectedRoute for driver routes whenever the
// driver's verification_status isn't 'verified' (and the account isn't
// banned/suspended — those checks run first and take priority). Mirrors
// the existing Suspended.jsx / Banned.jsx pattern so the three "account
// isn't fully active" states look and feel consistent across the app.
//
// Three sub-states, driven purely off driverProfile.verification_status:
//   - not yet submitted ('pending' / legacy 'unverified' / 'active')
//       -> CTA to go complete verification
//   - submitted, awaiting review ('pending_verification' / 'under_review')
//       -> nothing actionable, just a status message
//   - 'rejected'
//       -> shows the admin's reason + CTA to resubmit
//
// /driver/verification and /driver/profile stay reachable even in these
// states (see App.jsx's `allowUnverifiedDriver` route flag) so a driver
// can actually act on what this page tells them, rather than being stuck.
export default function PendingApproval() {
  const { profile, driverProfile, verificationStatus, signOut } = useAuth();
  const navigate = useNavigate();
  // Centralized Support Contacts (src/lib/support/supportContacts.js /
  // database/admin_support_contacts_foundation.sql) instead of a
  // hardcoded address — null until loaded, and stays null (no button
  // rendered below) if no support email is currently configured, rather
  // than ever pointing "Contact Support" at a broken mailto: link.
  const [supportEmailHref, setSupportEmailHref] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { contacts } = await fetchSupportContacts();
      if (!cancelled) setSupportEmailHref(toMailtoHref(contacts?.support_email));
    })();
    return () => { cancelled = true; };
  }, []);

  const awaitingReview = ['pending_verification', 'under_review'].includes(verificationStatus);
  const rejected = verificationStatus === 'rejected';

  const icon = awaitingReview ? '⏳' : rejected ? '⚠️' : '🪪';
  const badge = awaitingReview
    ? { label: 'Awaiting Approval', cls: 'badge-teal' }
    : rejected
      ? { label: 'Verification Rejected', cls: 'badge-danger' }
      : { label: 'Verification Required', cls: 'badge-amber' };

  return (
    <div className="page-layout" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex', minHeight: '100vh', padding: 24 }}>
      <div className="card card-pad" style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>{icon}</div>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>

        {awaitingReview && (
          <>
            <h1 style={{ fontSize: 21, margin: '14px 0 8px' }}>Your driver account is awaiting admin approval</h1>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, margin: '0 0 20px' }}>
              We've received your licence and vehicle documents. Our team is reviewing them — this usually
              takes under 24 hours. You'll get a notification the moment a decision is made, and driver
              features will unlock automatically.
            </p>
          </>
        )}

        {rejected && (
          <>
            <h1 style={{ fontSize: 21, margin: '14px 0 8px' }}>Your verification wasn't approved</h1>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, margin: '0 0 16px' }}>
              You'll need to fix the details below and resubmit before you can access driver features.
            </p>
            {driverProfile?.kyc_rejection_reason && (
              <div className="alert alert-danger" style={{ textAlign: 'left', marginBottom: 20 }}>
                <strong>Reason given:</strong> {driverProfile.kyc_rejection_reason}
              </div>
            )}
          </>
        )}

        {!awaitingReview && !rejected && (
          <>
            <h1 style={{ fontSize: 21, margin: '14px 0 8px' }}>Complete your driver verification</h1>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, margin: '0 0 20px' }}>
              You'll need to verify your licence and vehicle before you can access your driver dashboard
              and post trips. It only takes a few minutes.
            </p>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          {!awaitingReview && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/driver/verification')}>
              {rejected ? 'Resubmit documents →' : 'Complete verification →'}
            </button>
          )}
          {supportEmailHref && (
            <a className="btn btn-outline btn-sm" href={supportEmailHref}>Contact Support</a>
          )}
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Log out</button>
        </div>

        {profile?.email && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 16 }}>
            Signed in as <strong>{profile.email}</strong>
          </p>
        )}
      </div>
    </div>
  );
}
