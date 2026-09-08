import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import DriverDocumentsGallery from './DriverDocumentsGallery';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// kyc_approved_at/kyc_approved_by are set together (DriverReview.jsx's
// handleApprove()), so if there's an approval timestamp there should
// always be an approving admin. If the identity can't be resolved (e.g.
// a pre-existing row approved before kyc_approved_by started being
// recorded), say so explicitly rather than showing a bare "—", which
// reads as "nothing was ever approved".
function formatApprovedBy(driver) {
  if (!driver?.kyc_approved_at) return null;
  const admin = driver.approved_by_admin;
  const name = admin?.full_name || admin?.email;
  return name ? `Admin — ${name}` : 'Admin (record unavailable)';
}

const VERIFICATION_BADGE = {
  pending: 'badge-gray',
  pending_verification: 'badge-teal',
  under_review: 'badge-teal',
  verified: 'badge-green',
  rejected: 'badge-danger',
};

const FACE_STATUS_BADGE = {
  not_started: { label: 'Not started', cls: 'badge-gray' },
  captured:    { label: 'Captured — awaiting review', cls: 'badge-teal' },
  approved:    { label: 'Approved', cls: 'badge-green' },
  rejected:    { label: 'Rejected', cls: 'badge-danger' },
};

// "View Driver Details" — opened from Admin → Manage Users for any driver
// row, REGARDLESS of verification_status. Unlike KYCReviewer.jsx (which
// only ever renders for the pending-review queue), this is the surface
// that keeps a driver's submitted information and uploaded documents
// reachable for legitimate reference after they've already been approved
// (or rejected, or banned) — nothing here is limited to the review queue.
//
// Reuses the exact same admin-readable data this app already exposes:
//   - driver_profiles + profiles join, same shape as DriverReview.jsx's
//     query, gated by the existing "admin can read all driver profiles"
//     RLS policy (critical_security_fixes.sql) — no new policy needed.
//   - kyc_documents rendered via the shared DriverDocumentsGallery, which
//     opens each file through a short-lived signed URL, gated by the
//     existing "admins can read all driver documents" Storage policy
//     (verification_storage.sql) — again, no new policy needed.
// This view is intentionally read-only: approve/reject actions stay in
// Driver Review, and suspend/ban/reactivate actions stay in Manage Users'
// own row actions, so there's exactly one place each decision is made.
export default function DriverDetailsModal({ driverId, onClose }) {
  const [driver, setDriver] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      const { data, error: fetchError } = await supabase
        .from('driver_profiles')
        .select(`
          *,
          profiles:profile_id (full_name, email, phone, national_id, emergency_contact_name, emergency_contact_phone, profile_picture, created_at),
          approved_by_admin:kyc_approved_by (full_name, email)
        `)
        .eq('profile_id', driverId)
        .single();
      if (cancelled) return;
      if (fetchError) {
        setError("We couldn't load this driver's details right now.");
      } else {
        setDriver(data);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [driverId]);

  const identity = driver?.profiles;
  const documents = Array.isArray(driver?.kyc_documents) ? driver.kyc_documents : [];
  const faceStatus = FACE_STATUS_BADGE[driver?.face_verification_status] || FACE_STATUS_BADGE.not_started;
  const vehicleTypeLabel = driver?.vehicle_type === 'other' ? (driver?.vehicle_type_other || 'Other') : 'Private Car';

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
          <h3 style={{ fontSize: 18 }}>Driver Details</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {loading ? (
          <div style={{ padding: '24px 0' }}>
            <div className="skeleton-row" /><div className="skeleton-row" />
          </div>
        ) : error ? (
          <div className="alert alert-danger" style={{ marginTop: 12 }}>{error}</div>
        ) : !driver ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>Driver not found.</p>
        ) : (
          <div style={{ marginTop: 8 }}>
            {/* Driver information */}
            <SectionHeading>Driver Information</SectionHeading>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              {identity?.profile_picture ? (
                <img src={identity.profile_picture} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--bg-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>
                  {identity?.full_name?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{identity?.full_name || '—'}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Driver since {formatDate(identity?.created_at)}</div>
              </div>
            </div>

            <div className="divider" />

            {/* Contact information */}
            <SectionHeading>Contact Information</SectionHeading>
            <div className="grid-2" style={{ gap: 14, marginBottom: 16 }}>
              <Field label="Email" value={identity?.email} />
              <Field label="Phone" value={identity?.phone} />
              <Field label="Emergency Contact" value={identity?.emergency_contact_name} />
              <Field label="Emergency Phone" value={identity?.emergency_contact_phone} />
            </div>

            <div className="divider" />

            {/* Verification status */}
            <SectionHeading>Verification Status</SectionHeading>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <span className={`badge ${VERIFICATION_BADGE[driver.verification_status] || 'badge-gray'}`}>{driver.verification_status || 'pending'}</span>
              <span className={`badge ${faceStatus.cls}`}>Face: {faceStatus.label}</span>
            </div>
            <div className="grid-2" style={{ gap: 14, marginBottom: 16 }}>
              <Field label="Submitted" value={formatDateTime(driver.kyc_submitted_at)} />
              <Field label="Submission Attempts" value={driver.kyc_attempts ?? 0} />
            </div>

            <div className="divider" />

            {/* Submitted verification information */}
            <SectionHeading>Submitted Verification Information</SectionHeading>
            <div className="grid-2" style={{ gap: 14, marginBottom: 16 }}>
              <Field label="National ID" value={identity?.national_id} />
              <Field label="Licence Number" value={driver.licence_number} />
              <Field label="Licence Expiry" value={formatDate(driver.licence_expiry)} />
            </div>

            <div className="divider" />

            {/* Uploaded documents */}
            <SectionHeading>Uploaded Documents</SectionHeading>
            <div style={{ marginBottom: 16 }}>
              <DriverDocumentsGallery documents={documents} />
            </div>

            <div className="divider" />

            {/* Vehicle information */}
            <SectionHeading>Vehicle Information</SectionHeading>
            <div className="grid-2" style={{ gap: 14, marginBottom: 16 }}>
              <Field label="Vehicle Type" value={vehicleTypeLabel} />
              <Field label="Make / Model" value={`${driver.vehicle_make || ''} ${driver.vehicle_model || ''}`.trim()} />
              <Field label="Year / Colour" value={`${driver.vehicle_year || '—'} · ${driver.vehicle_color || '—'}`} />
              <Field label="Plate" value={driver.vehicle_plate} />
              <Field label="Seats" value={driver.vehicle_seats} />
            </div>

            <div className="divider" />

            {/* Approval / review information */}
            <SectionHeading>Approval / Review Information</SectionHeading>
            <div className="grid-2" style={{ gap: 14 }}>
              <Field label="Approved At" value={formatDateTime(driver.kyc_approved_at)} />
              <Field label="Approved By" value={formatApprovedBy(driver)} />
              <Field label="Account Status" value={driver.account_status} />
              {driver.suspension_reason && <Field label="Suspension / Ban Reason" value={driver.suspension_reason} />}
              {driver.kyc_rejection_reason && <Field label="Rejection Reason" value={driver.kyc_rejection_reason} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>
      {children}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value || '—'}</div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
};
const modalStyle = {
  background: 'white', borderRadius: 16, padding: '28px 30px', maxWidth: 560, width: '100%',
  maxHeight: '85vh', overflowY: 'auto',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', fontFamily: "'DM Sans', sans-serif",
};
