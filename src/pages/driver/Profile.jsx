import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import DashboardLayout from '../../components/shared/DashboardLayout';
import ChangePasswordCard from '../../components/shared/ChangePasswordCard';
import PersonalInfoCard from '../../components/shared/PersonalInfoCard';
import LegalConsentCard from '../../components/shared/LegalConsentCard';

export default function Profile() {
  const { profile, driverProfile, verificationStatus, needsVerification, verificationPending, isDriverVerified, updateProfile } = useAuth();

  return (
    <DashboardLayout title="Profile">
      <div className="page-header">
        <h1>Your Profile</h1>
        <p>Manage your personal details and driver verification.</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
        <PersonalInfoCard profile={profile} updateProfile={updateProfile} />
        <ChangePasswordCard />
        <LegalConsentCard profile={profile} updateProfile={updateProfile} />

        {isDriverVerified && <VerifiedVehicleCard driverProfile={driverProfile} />}
        {needsVerification && <VerificationStatusCard status="needed" verificationStatus={verificationStatus} driverProfile={driverProfile} />}
        {verificationPending && <VerificationStatusCard status="pending" verificationStatus={verificationStatus} driverProfile={driverProfile} />}
      </div>
    </DashboardLayout>
  );
}

// ── Verified driver: read-only vehicle + trust summary ───────────────────
function VerifiedVehicleCard({ driverProfile }) {
  return (
    <div className="card card-pad">
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16 }}>Vehicle & Verification</h3>
        <span className="badge badge-green">✓ Verified</span>
      </div>

      <div className="grid-2" style={{ gap: 12, marginBottom: 16 }}>
        <InfoRow label="Vehicle" value={`${driverProfile?.vehicle_make || ''} ${driverProfile?.vehicle_model || ''}`} />
        <InfoRow label="Plate" value={driverProfile?.vehicle_plate} />
        <InfoRow label="Colour" value={driverProfile?.vehicle_color} />
        <InfoRow label="Seats" value={driverProfile?.vehicle_seats} />
        <InfoRow label="Licence No." value={driverProfile?.licence_number} />
        <InfoRow label="Vehicle Type" value={driverProfile?.vehicle_type === 'other' ? (driverProfile?.vehicle_type_other || 'Other') : 'Private Car'} />
      </div>

      <div className="divider" />

      <div className="grid-3" style={{ gap: 12 }}>
        <TrustStat label="Trust level" value={`L${driverProfile?.trust_level || 1}`} />
        <TrustStat label="Max seats/trip" value={driverProfile?.max_seats_per_trip} />
        <TrustStat label="Payout delay" value={`${driverProfile?.payout_delay_hours}h`} />
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
        These limits grow automatically as you complete more trips with a clean record. {driverProfile?.trips_completed || 0} trips completed so far.
      </p>
    </div>
  );
}

// ── Verification status summary — the full form lives at ONE place only:
// /driver/verification (src/pages/driver/Verification.jsx). This card just
// reflects status here and links out, instead of maintaining a second,
// easy-to-drift copy of the same form.
function VerificationStatusCard({ status, verificationStatus, driverProfile }) {
  const navigate = useNavigate();
  const rejected = verificationStatus === 'rejected';

  return (
    <div className="card card-pad">
      <div className="flex-between" style={{ marginBottom: 4 }}>
        <h3 style={{ fontSize: 16 }}>Driver Verification</h3>
        {status === 'pending' ? (
          <span className="badge badge-teal">⏳ Under review</span>
        ) : rejected ? (
          <span className="badge badge-danger">Action needed</span>
        ) : (
          <span className="badge badge-amber">Not started</span>
        )}
      </div>

      {status === 'pending' ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 16px' }}>
          Submitted{driverProfile?.kyc_submitted_at ? ` on ${new Date(driverProfile.kyc_submitted_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''} and currently being reviewed — usually within 24 hours.
        </p>
      ) : rejected && driverProfile?.kyc_rejection_reason ? (
        <div className="alert alert-danger" style={{ margin: '8px 0 16px' }}>
          <strong>Previous application rejected:</strong> {driverProfile.kyc_rejection_reason}
        </div>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 16px' }}>
          Verify your licence and vehicle to unlock posting trips — takes a few minutes.
        </p>
      )}

      {status === 'pending' ? (
        <div className="grid-2" style={{ gap: 12 }}>
          <InfoRow label="Vehicle" value={`${driverProfile?.vehicle_make || ''} ${driverProfile?.vehicle_model || ''}`} />
          <InfoRow label="Plate" value={driverProfile?.vehicle_plate} />
        </div>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/driver/verification')}>
          {rejected ? 'Update & Resubmit →' : 'Start Verification →'}
        </button>
      )}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value || '—'}</div>
    </div>
  );
}

function TrustStat({ label, value }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}