import { useState } from 'react';
import DriverDocumentsGallery from './DriverDocumentsGallery';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

const FACE_STATUS_BADGE = {
  not_started: { label: 'Not started', cls: 'badge-gray' },
  captured:    { label: 'Captured — awaiting review', cls: 'badge-teal' },
  approved:    { label: 'Approved', cls: 'badge-green' },
  rejected:    { label: 'Rejected', cls: 'badge-danger' },
};

// Manual review card for a single driver's KYC submission, including the
// documents they uploaded (driver.kyc_documents — an array of
// { type, path, file_name, size, mime_type, uploaded_at }). Documents live
// in a private Storage bucket, so previews are opened via short-lived
// signed URLs generated on click rather than a static <img src>.
export default function KYCReviewer({ driver, onApprove, onReject }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const documents = Array.isArray(driver.kyc_documents) ? driver.kyc_documents : [];

  const faceStatus = FACE_STATUS_BADGE[driver.face_verification_status] || FACE_STATUS_BADGE.not_started;
  const vehicleTypeLabel = driver.vehicle_type === 'other' ? (driver.vehicle_type_other || 'Other') : 'Private Car';

  const isFirstAttempt = (driver.kyc_attempts || 0) <= 1;

  async function handleApprove() {
    setBusy(true);
    await onApprove(driver.id);
    setBusy(false);
  }

  async function handleConfirmReject() {
    if (!reason.trim()) return;
    setBusy(true);
    await onReject(driver.id, reason.trim());
    setBusy(false);
    setRejecting(false);
    setReason('');
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="flex-between" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ fontSize: 16, marginBottom: 2 }}>{driver.full_name}</h3>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{driver.email} · {driver.phone}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isFirstAttempt && <span className="badge badge-amber">Resubmission (#{driver.kyc_attempts})</span>}
          <span className={`badge ${faceStatus.cls}`}>Face: {faceStatus.label}</span>
          <span className="badge badge-teal">
            {driver.verification_status === 'under_review' ? 'Under review' : 'Pending'}
          </span>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Submitted {formatDate(driver.kyc_submitted_at)} · Review documents supplied outside the app against the details below.
      </p>

      <div className="divider" />

      <div className="grid-2" style={{ gap: 14, margin: '16px 0' }}>
        <Field label="National ID" value={driver.national_id} />
        <Field label="Licence Number" value={driver.licence_number} />
        <Field label="Licence Expiry" value={formatDate(driver.licence_expiry)} />
      </div>

      <div className="divider" />

      <div className="grid-2" style={{ gap: 14, margin: '16px 0' }}>
        <Field label="Vehicle Type" value={vehicleTypeLabel} />
        <Field label="Vehicle" value={`${driver.vehicle_make || ''} ${driver.vehicle_model || ''} (${driver.vehicle_year || '—'})`} />
        <Field label="Plate" value={driver.vehicle_plate} />
        <Field label="Colour" value={driver.vehicle_color} />
        <Field label="Seats" value={driver.vehicle_seats} />
      </div>

      <div className="divider" />

      <div className="grid-2" style={{ gap: 14, margin: '16px 0' }}>
        <Field label="Emergency Contact" value={driver.emergency_contact_name} />
        <Field label="Emergency Phone" value={driver.emergency_contact_phone} />
      </div>

      <div className="divider" />

      <div style={{ margin: '16px 0' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
          Submitted Documents
        </div>
        <DriverDocumentsGallery documents={documents} />
      </div>

      {rejecting ? (
        <div style={{ marginTop: 8 }}>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Rejection reason (shown to the driver)</label>
            <textarea
              className="form-input"
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Licence photo unclear, expiry date doesn't match records"
              style={{ resize: 'vertical', fontFamily: "'DM Sans', sans-serif" }}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-danger btn-sm" disabled={busy || !reason.trim()} onClick={handleConfirmReject}>
              {busy ? <span className="spinner" /> : 'Confirm rejection'}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setRejecting(false); setReason(''); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleApprove}>
            {busy ? <span className="spinner" /> : '✓ Approve'}
          </button>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setRejecting(true)}>
            ✕ Reject
          </button>
        </div>
      )}
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
