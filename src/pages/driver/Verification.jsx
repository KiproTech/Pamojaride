import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import DashboardLayout from '../../components/shared/DashboardLayout';
import SelectOrOther from '../../components/shared/SelectOrOther';
import FaceVerificationCapture from '../../components/driver/FaceVerificationCapture';
import { VEHICLE_MAKES, VEHICLE_MAKE_MODELS, VEHICLE_COLORS } from '../../lib/vehicleData';
import {
  DOCUMENT_TYPES,
  ALLOWED_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_VERIFICATION_UPLOADS,
  validateFile,
  uploadVerificationDocument,
} from '../../lib/verificationDocuments';

// Vehicle types: seeded from public.vehicle_types (private_car, other today).
// Kept as a small local list here purely for the dropdown UI — adding a
// new type later is a database INSERT, not a code change, so this list is
// expected to drift slightly behind the DB over time. 'Other' always
// covers the gap in the meantime.
const VEHICLE_TYPES = ['Private Car'];

const CURRENT_YEAR = new Date().getFullYear();
const VEHICLE_YEARS = Array.from({ length: 30 }, (_, i) => CURRENT_YEAR - i);

const STEPS = ['Personal', 'Vehicle', 'Documents', 'Face Verification', 'Confirm'];

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Turns a failed save's `error` (as returned by supabase-js) into an
// honest, specific message — NEVER collapse every failure into "check
// your connection".
//
// supabase-js always resolves (never rejects) a query with { data, error
// }, and the shape of `error` tells you which kind of failure this was:
//   - A request that actually reached Postgres/PostgREST (a validation
//     rule, a trigger's RAISE EXCEPTION, an RLS check, a malformed
//     column/value, etc.) always comes back with a non-empty `code`
//     (either a Postgres SQLSTATE like '23514'/'42501'/'P0001', or a
//     PostgREST code like 'PGRST116'). Its `message` is the real,
//     specific reason the save was rejected — surface that directly.
//   - A request that never reached the server at all (offline, DNS
//     failure, CORS, an aborted/timed-out fetch) comes back from
//     supabase-js with `code` empty/undefined, because there was no
//     database response to attach a SQLSTATE to. ONLY this case should
//     ever be described as a connection problem.
function describeSaveError(error) {
  if (!error) return '';
  if (error.code) {
    return error.message || "That couldn't be saved — please check the field and try again.";
  }
  return "Couldn't reach the server — check your connection and try again.";
}

// A value that came back from the DB might be a curated option ("Toyota")
// or a previously-typed custom value ("Skoda") — decide which state the
// SelectOrOther field should start in.
function initSelectOrOther(existingValue, knownOptions) {
  if (!existingValue) return { value: '', other: '' };
  return knownOptions.includes(existingValue)
    ? { value: existingValue, other: '' }
    : { value: 'Other', other: existingValue };
}

function resolveSelectOrOther(value, other) {
  return value === 'Other' ? (other || '').trim() : value;
}

export default function Verification() {
  const { user, profile, driverProfile, verificationStatus, isDriverVerified, needsVerification, submitDriverVerification, saveVerificationProgress, refreshProfile, supabase } = useAuth();
  const navigate = useNavigate();

  if (isDriverVerified) return <VerifiedState driverProfile={driverProfile} onBack={() => navigate('/driver/dashboard')} />;
  if (!needsVerification) return <PendingState driverProfile={driverProfile} onBack={() => navigate('/driver/dashboard')} />;

  return (
    <DashboardLayout title="Driver Verification">
      <div className="page-header">
        <h1>Driver Verification</h1>
        <p>
          A few quick steps — mostly picking from lists, not typing. You'll be asked for a maximum of{' '}
          {MAX_VERIFICATION_UPLOADS} uploads in total — only the documents and photos listed on each step are needed,
          nothing else. Review usually takes under 24 hours.
        </p>
      </div>
      <VerificationWizard
        user={user}
        profile={profile}
        driverProfile={driverProfile}
        verificationStatus={verificationStatus}
        submitDriverVerification={submitDriverVerification}
        saveVerificationProgress={saveVerificationProgress}
        refreshProfile={refreshProfile}
        supabase={supabase}
        onDone={() => navigate('/driver/dashboard')}
      />
    </DashboardLayout>
  );
}

// ── Already verified ──────────────────────────────────────────────────────
function VerifiedState({ driverProfile, onBack }) {
  const vehicleType = driverProfile?.vehicle_type === 'other' ? driverProfile?.vehicle_type_other : 'Private Car';
  return (
    <DashboardLayout title="Driver Verification">
      <div className="empty-state">
        <div className="empty-icon">✅</div>
        <h3>You're already verified</h3>
        <p>Nothing more to do here — you can post trips whenever you like.</p>
        <div className="grid-2" style={{ gap: 12, maxWidth: 420, margin: '20px auto 0', textAlign: 'left' }}>
          <InfoRow label="Vehicle" value={`${driverProfile?.vehicle_make || ''} ${driverProfile?.vehicle_model || ''}`} />
          <InfoRow label="Type" value={vehicleType} />
          <InfoRow label="Plate" value={driverProfile?.vehicle_plate} />
          <InfoRow label="Seats" value={driverProfile?.vehicle_seats} />
        </div>
        <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={onBack}>Back to dashboard</button>
      </div>
    </DashboardLayout>
  );
}

// ── Submitted / under review (not editable) ────────────────────────────────
function PendingState({ driverProfile, onBack }) {
  return (
    <DashboardLayout title="Driver Verification">
      <div className="empty-state">
        <div className="empty-icon">⏳</div>
        <h3>Submitted for review</h3>
        <p>
          Your application was submitted{driverProfile?.kyc_submitted_at ? ` on ${formatDate(driverProfile.kyc_submitted_at)}` : ''} and our team is reviewing it —
          usually within 24 hours. You'll be notified as soon as it's decided, and you can keep using the app in the meantime.
        </p>
        <span className="badge badge-teal" style={{ marginTop: 8 }}>⏳ Under review</span>
        <div>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={onBack}>Back to dashboard</button>
        </div>
      </div>
    </DashboardLayout>
  );
}

// ── Main step-by-step wizard: unverified (first submission) or rejected (resubmission) ───
function VerificationWizard({ user, profile, driverProfile, verificationStatus, submitDriverVerification, saveVerificationProgress, refreshProfile, supabase, onDone }) {
  const makeInit = initSelectOrOther(driverProfile?.vehicle_make, VEHICLE_MAKES.filter(m => m !== 'Other'));
  const modelKnownForMake = VEHICLE_MAKE_MODELS[driverProfile?.vehicle_make] || [];
  const modelInit = initSelectOrOther(driverProfile?.vehicle_model, modelKnownForMake);
  const colorInit = initSelectOrOther(driverProfile?.vehicle_color, VEHICLE_COLORS.filter(c => c !== 'Other'));
  const typeInit = driverProfile?.vehicle_type === 'other'
    ? { value: 'Other', other: driverProfile?.vehicle_type_other || '' }
    : { value: 'Private Car', other: '' };

  // Resume automatically: the database (driver_profiles.verification_step)
  // is the source of truth for where the driver left off, never
  // localStorage. Clamped defensively in case the stored value is ever
  // outside the current step range (e.g. STEPS shrinks in a future
  // release).
  //
  // Exception: a REJECTED verification always reopens at Step 0. Final
  // submission sets verification_step = 4 (see AuthContext.
  // submitDriverVerification), and an admin rejection only changes
  // verification_status — it never touches verification_step. If we
  // honoured the stored step here, a rejected driver would land straight
  // on the Confirm screen and never see the rejection-reason banner (which
  // only renders on Step 0) or get walked back through every field to fix.
  const initialStep = verificationStatus === 'rejected'
    ? 0
    : Math.min(Math.max(driverProfile?.verification_step ?? 0, 0), STEPS.length - 1);
  const [step, setStep] = useState(initialStep);
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | saved | error
  const [saveErrorMessage, setSaveErrorMessage] = useState(''); // human-readable reason for the last save failure (never a generic fallback unless it truly was a connection problem)
  const [form, setForm] = useState({
    nationalId: profile?.national_id || '',
    licenceNumber: driverProfile?.licence_number || '',
    licenceExpiry: driverProfile?.licence_expiry || '',
    emergencyContactName: profile?.emergency_contact_name || '',
    emergencyContactPhone: profile?.emergency_contact_phone || '',

    vehicleType: typeInit.value,
    vehicleTypeOther: typeInit.other,
    vehicleMake: makeInit.value,
    vehicleMakeOther: makeInit.other,
    vehicleModel: modelInit.value,
    vehicleModelOther: modelInit.other,
    vehicleYear: driverProfile?.vehicle_year || '',
    vehicleColor: colorInit.value,
    vehicleColorOther: colorInit.other,
    vehiclePlate: driverProfile?.vehicle_plate || '',
    vehicleSeats: driverProfile?.vehicle_seats || '',

    confirmAccuracy: false,
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [files, setFiles] = useState({});       // { [docType]: File }
  const [fileErrors, setFileErrors] = useState({});
  const [uploadingDoc, setUploadingDoc] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const existingDocs = Array.isArray(driverProfile?.kyc_documents) ? driverProfile.kyc_documents : [];
  const existingDocMap = Object.fromEntries(existingDocs.map(d => [d.type, d]));

  const paperDocTypes = DOCUMENT_TYPES.filter(d => d.key !== 'vehicle_photo' && d.key !== 'face_verification');
  const vehiclePhotoDoc = DOCUMENT_TYPES.find(d => d.key === 'vehicle_photo');

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }));
  }
  function setVal(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  // Picking a new make resets model — a model from the old make rarely
  // makes sense once the make itself has changed.
  function setMake(value) {
    setForm(f => ({ ...f, vehicleMake: value, vehicleMakeOther: '', vehicleModel: '', vehicleModelOther: '' }));
  }

  // Documents/photos upload — and are persisted to the database — the
  // moment they're selected, rather than waiting for final submission.
  // `files[docType]` only ever represents a LOCAL, not-yet-confirmed
  // selection (uploading, or failed and awaiting retry); once the upload
  // and the driver_profiles save both succeed, the entry is cleared here
  // and the document lives on in `existingDocMap` (derived from
  // driverProfile.kyc_documents, which saveVerificationProgress just
  // updated) — the database, not local state, is the source of truth for
  // "this document is saved".
  async function uploadAndSave(docType, file) {
    setUploadingDoc(docType);
    setFileErrors(prev => ({ ...prev, [docType]: null }));
    try {
      const previousPath = existingDocMap[docType]?.path;
      const { data, error } = await uploadVerificationDocument(supabase, user.id, docType, file, previousPath);
      if (error) throw new Error(error.message || 'Upload failed.');
      const { error: saveErr } = await saveVerificationProgress({ newDocuments: [data] });
      if (saveErr) throw new Error(saveErr.message || 'Unable to save your progress. Please check your connection and try again.');
      setFiles(prev => { const next = { ...prev }; delete next[docType]; return next; });
    } catch (err) {
      setFileErrors(prev => ({ ...prev, [docType]: err.message || 'Upload failed. Please check your connection and try again.' }));
    } finally {
      setUploadingDoc(null);
    }
  }

  function handleFileSelect(docType, fileList) {
    const file = fileList?.[0];
    if (!file) return;
    const docConfig = DOCUMENT_TYPES.find(d => d.key === docType);
    const error = validateFile(file, { imageOnly: !!docConfig?.imageOnly });
    if (error) { setFileErrors(prev => ({ ...prev, [docType]: error })); return; }
    setFiles(prev => ({ ...prev, [docType]: file }));
    uploadAndSave(docType, file);
  }

  function retryUpload(docType) {
    const file = files[docType];
    if (file) uploadAndSave(docType, file);
  }

  function removeFile(docType) {
    setFiles(prev => { const next = { ...prev }; delete next[docType]; return next; });
    setFileErrors(prev => { const next = { ...prev }; delete next[docType]; return next; });
  }

  function handleFaceCaptured(file) {
    if (!file) { removeFile('face_verification'); return; }
    setFiles(prev => ({ ...prev, face_verification: file }));
    uploadAndSave('face_verification', file);
  }

  // ── Per-step validation ───────────────────────────────────────────────
  function validateStep(i) {
    const nextFieldErrors = {};
    const nextFileErrors = {};

    if (i === 0) {
      if (!form.nationalId.trim()) nextFieldErrors.nationalId = 'Required';
      if (!form.licenceNumber.trim()) nextFieldErrors.licenceNumber = 'Required';
      if (!form.licenceExpiry) nextFieldErrors.licenceExpiry = 'Required';
      else if (form.licenceExpiry < todayISO()) nextFieldErrors.licenceExpiry = 'Licence has expired';
      if (!form.emergencyContactName.trim()) nextFieldErrors.emergencyContactName = 'Required';
      if (!form.emergencyContactPhone.trim()) nextFieldErrors.emergencyContactPhone = 'Required';
      else if (!/^(?:\+254|0)7\d{8}$|^(?:\+254|0)1\d{8}$/.test(form.emergencyContactPhone.replace(/\s+/g, '')))
        nextFieldErrors.emergencyContactPhone = 'Enter a valid Kenyan phone number, e.g. 07XX XXX XXX';
    }

    if (i === 1) {
      if (!form.vehicleType) nextFieldErrors.vehicleType = 'Required';
      else if (form.vehicleType === 'Other' && !form.vehicleTypeOther.trim()) nextFieldErrors.vehicleTypeOther = 'Required';

      if (!form.vehicleMake) nextFieldErrors.vehicleMake = 'Required';
      else if (form.vehicleMake === 'Other' && !form.vehicleMakeOther.trim()) nextFieldErrors.vehicleMakeOther = 'Required';

      if (!form.vehicleModel) nextFieldErrors.vehicleModel = 'Required';
      else if (form.vehicleModel === 'Other' && !form.vehicleModelOther.trim()) nextFieldErrors.vehicleModelOther = 'Required';

      if (!form.vehicleYear) nextFieldErrors.vehicleYear = 'Required';

      if (!form.vehicleColor) nextFieldErrors.vehicleColor = 'Required';
      else if (form.vehicleColor === 'Other' && !form.vehicleColorOther.trim()) nextFieldErrors.vehicleColorOther = 'Required';

      if (!form.vehiclePlate.trim()) nextFieldErrors.vehiclePlate = 'Required';

      const seats = Number(form.vehicleSeats);
      if (!form.vehicleSeats && form.vehicleSeats !== 0) nextFieldErrors.vehicleSeats = 'Required';
      else if (!Number.isInteger(seats) || seats < 1 || seats > 100) nextFieldErrors.vehicleSeats = 'Enter a whole number between 1 and 100';

      // Require the SAVED (server-confirmed) document, not just a locally
      // selected file — a file sitting in `files` might still be
      // uploading, or might have failed, and clicking Next must never
      // move on until saving has actually succeeded.
      if (!existingDocMap.vehicle_photo) {
        nextFileErrors.vehicle_photo = uploadingDoc === 'vehicle_photo'
          ? 'Please wait for the vehicle photo to finish uploading'
          : files.vehicle_photo ? 'Vehicle photo upload failed — please retry' : 'Vehicle photo is required';
      }
    }

    if (i === 2) {
      for (const doc of paperDocTypes) {
        if (!doc.required) continue;
        if (!existingDocMap[doc.key]) {
          nextFileErrors[doc.key] = uploadingDoc === doc.key
            ? 'Please wait for this document to finish uploading'
            : files[doc.key] ? 'Upload failed — please retry' : 'Required document';
        }
      }
    }

    if (i === 3) {
      if (!existingDocMap.face_verification) {
        nextFileErrors.face_verification = uploadingDoc === 'face_verification'
          ? 'Please wait for the capture to finish uploading'
          : files.face_verification ? 'Upload failed — please retry' : 'Please complete face verification before continuing';
      }
    }

    if (i === 4) {
      if (!form.confirmAccuracy) nextFieldErrors.confirmAccuracy = 'You must confirm before submitting';
    }

    setFieldErrors(prev => ({ ...prev, ...nextFieldErrors }));
    setFileErrors(prev => ({ ...prev, ...nextFileErrors }));
    return { ...nextFieldErrors, ...nextFileErrors };
  }

  // ── Which columns each step is responsible for saving ──────────────────
  // Steps 2 (Documents) and 3 (Face Verification) have no typed fields of
  // their own — their content is a set of files, each already saved the
  // instant it uploads successfully (see uploadAndSave above) — so their
  // payload here is deliberately empty; Next just advances the saved
  // verification_step marker.
  function buildStepPayload(i) {
    if (i === 0) {
      return {
        driverFields: {
          licence_number: form.licenceNumber,
          licence_expiry: form.licenceExpiry || null,
        },
        profileFields: {
          national_id: form.nationalId,
          emergency_contact_name: form.emergencyContactName,
          emergency_contact_phone: form.emergencyContactPhone,
        },
      };
    }
    if (i === 1) {
      const seats = Number(form.vehicleSeats);
      const clampedSeats = Number.isInteger(seats) ? Math.min(100, Math.max(1, seats)) : null;
      return {
        driverFields: {
          vehicle_type: form.vehicleType === 'Other' ? 'other' : 'private_car',
          vehicle_type_other: form.vehicleType === 'Other' ? ((form.vehicleTypeOther || '').trim() || null) : null,
          vehicle_make: resolveSelectOrOther(form.vehicleMake, form.vehicleMakeOther) || null,
          vehicle_model: resolveSelectOrOther(form.vehicleModel, form.vehicleModelOther) || null,
          vehicle_year: form.vehicleYear ? parseInt(form.vehicleYear, 10) : null,
          vehicle_color: resolveSelectOrOther(form.vehicleColor, form.vehicleColorOther) || null,
          vehicle_plate: form.vehiclePlate || null,
          vehicle_seats: clampedSeats,
        },
        profileFields: {},
      };
    }
    return { driverFields: {}, profileFields: {} };
  }

  // Fill → Validate → Save → Confirm saved → Move to next step. Never
  // advances if the save fails, and never silently discards what the
  // driver entered — the form state is untouched on error, so they can
  // just fix their connection and hit Next again.
  async function goNext() {
    const errors = validateStep(step);
    if (Object.keys(errors).length > 0) return;

    setSaveStatus('saving');
    setSubmitError('');
    setSaveErrorMessage('');
    const { driverFields, profileFields } = buildStepPayload(step);
    const { error } = await saveVerificationProgress({ driverFields, profileFields, verificationStep: step + 1 });

    if (error) {
      // Leave lastAutosavedRef untouched on failure — see the autosave
      // effect below for why marking a FAILED save as "already attempted"
      // would silently prevent it from ever being retried.
      const message = describeSaveError(error);
      setSaveStatus('error');
      setSaveErrorMessage(message);
      setSubmitError(message);
      return;
    }

    lastAutosavedRef.current[step] = JSON.stringify(buildStepPayload(step));
    setSaveStatus('saved');
    setStep(s => Math.min(s + 1, STEPS.length - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
  }
  function goBack() {
    setStep(s => Math.max(s - 1, 0));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Autosave: debounced, per-step, so partial progress on Steps 1–2 ────
  // (typed fields) is never lost even if the driver never reaches Next —
  // e.g. they fill in half of Vehicle Information and just close the tab.
  // Compares against the last-saved snapshot for THIS step so unrelated
  // re-renders, or switching steps without changing anything, never fire
  // an extra request. Debounced (not saved on every keystroke) to avoid
  // excessive database writes, but short enough that dropdown selections
  // (which change the form in one shot) are saved close to immediately.
  const lastAutosavedRef = useRef({
    0: JSON.stringify(buildStepPayload(0)),
    1: JSON.stringify(buildStepPayload(1)),
  });
  useEffect(() => {
    if (step !== 0 && step !== 1) return; // steps 2-4 have no free-typed fields to autosave
    const snapshot = JSON.stringify(buildStepPayload(step));
    if (snapshot === lastAutosavedRef.current[step]) return;

    const timer = setTimeout(async () => {
      const { driverFields, profileFields } = buildStepPayload(step);
      setSaveStatus('saving');
      const { error } = await saveVerificationProgress({ driverFields, profileFields });
      if (error) {
        // Deliberately do NOT update lastAutosavedRef here. If we did, a
        // failed save would be marked as "already attempted for this
        // exact form state" — so if the driver navigated away and back
        // (or the field just happened to be re-evaluated) without
        // changing the value again, this effect would see snapshot ===
        // lastAutosavedRef.current[step] and skip re-saving forever,
        // silently leaving the field unsaved. Leaving the ref stale means
        // the *next* genuine change to this step's fields (or a manual
        // "Next") will naturally attempt the save again — this is
        // deliberate retry-on-new-input, not a blind repeat of the same
        // rejected request (which requirement #2 rules out).
        setSaveStatus('error');
        setSaveErrorMessage(describeSaveError(error));
      } else {
        lastAutosavedRef.current[step] = snapshot;
        setSaveStatus('saved');
        setSaveErrorMessage('');
        setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
      }
    }, 800);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, step]);

  function validateAll() {
    let combined = {};
    for (let i = 0; i < STEPS.length; i++) combined = { ...combined, ...validateStep(i) };
    return Object.keys(combined).length === 0;
  }

  async function handleSubmit() {
    setSubmitError('');
    if (!validateAll()) {
      // Jump the driver back to the first step that still has a problem,
      // rather than leaving them on Confirm staring at nothing.
      for (let i = 0; i < STEPS.length; i++) {
        if (Object.keys(validateStep(i)).length > 0) { setStep(i); break; }
      }
      return;
    }

    setSubmitting(true);
    try {
      // Every document/photo has already been uploaded and persisted to
      // driver_profiles.kyc_documents incrementally as it was selected
      // (see uploadAndSave) — validateStep(2)/(3) above already refused to
      // let the driver reach this point otherwise. Submission just flips
      // verification_status; there's nothing left to upload here.
      const payload = {
        nationalId: form.nationalId,
        licenceNumber: form.licenceNumber,
        licenceExpiry: form.licenceExpiry,
        emergencyContactName: form.emergencyContactName,
        emergencyContactPhone: form.emergencyContactPhone,
        vehiclePlate: form.vehiclePlate,
        vehicleYear: form.vehicleYear,
        vehicleSeats: form.vehicleSeats,
        vehicleMake: resolveSelectOrOther(form.vehicleMake, form.vehicleMakeOther),
        vehicleModel: resolveSelectOrOther(form.vehicleModel, form.vehicleModelOther),
        vehicleColor: resolveSelectOrOther(form.vehicleColor, form.vehicleColorOther),
        vehicleType: form.vehicleType === 'Other' ? 'other' : 'private_car',
        vehicleTypeOther: form.vehicleType === 'Other' ? form.vehicleTypeOther.trim() : null,
      };

      const { error: submitErr } = await submitDriverVerification(payload, []);
      if (submitErr) throw new Error(submitErr.message);

      await refreshProfile();
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
      setUploadingDoc(null);
    }
  }

  if (submitted) {
    return (
      <div className="empty-state">
        <div className="empty-icon">✅</div>
        <h3>Verification Submitted</h3>
        <p>Your documents have been submitted successfully. Our team is currently reviewing your information.</p>
        <span className="badge badge-teal" style={{ marginTop: 4 }}>⏳ Status: Under Review</span>
        <p style={{ marginTop: 12 }}>You'll be notified once your verification has been reviewed.</p>
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={onDone}>Back to dashboard</button>
      </div>
    );
  }

  const modelOptions = VEHICLE_MAKE_MODELS[form.vehicleMake] || [];

  return (
    <div style={{ maxWidth: 720 }}>
      <StepProgress steps={STEPS} current={step} />

      {verificationStatus === 'rejected' && step === 0 && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>
          <strong>Verification requires attention.</strong>{' '}
          {driverProfile?.kyc_rejection_reason || 'Please review your details and documents, then resubmit.'}
        </div>
      )}
      {submitError && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{submitError}</div>}

      {step === 0 && (
        <section className="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 4 }}>Personal &amp; Licence Information</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Only the details PamojaRide needs to verify you as a driver.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TextField label="National ID Number" required value={form.nationalId} onChange={set('nationalId')} error={fieldErrors.nationalId} placeholder="e.g. 12345678" />
            <TextField label="Driving Licence Number" required value={form.licenceNumber} onChange={set('licenceNumber')} error={fieldErrors.licenceNumber} placeholder="e.g. DL123456" />
            <TextField label="Licence Expiry" type="date" required min={todayISO()} value={form.licenceExpiry} onChange={set('licenceExpiry')} error={fieldErrors.licenceExpiry} />
            <div className="divider" />
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-6px 0 2px' }}>Emergency contact — only used in emergencies, never visible to passengers.</p>
            <div className="grid-2" style={{ gap: 14 }}>
              <TextField label="Contact Name" required value={form.emergencyContactName} onChange={set('emergencyContactName')} error={fieldErrors.emergencyContactName} placeholder="e.g. Mary Otieno" />
              <TextField label="Contact Phone" type="tel" required value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} error={fieldErrors.emergencyContactPhone} placeholder="07XX XXX XXX" />
            </div>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 4 }}>Vehicle Information</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>The vehicle you'll be driving for PamojaRide trips. Mostly picking from lists.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SelectOrOther
              label="Vehicle Type" required options={VEHICLE_TYPES}
              value={form.vehicleType} otherValue={form.vehicleTypeOther}
              onChange={v => setVal('vehicleType', v)} onOtherChange={v => setVal('vehicleTypeOther', v)}
              error={fieldErrors.vehicleType} otherError={fieldErrors.vehicleTypeOther}
              otherPlaceholder="e.g. Minibus, Van, SUV"
            />
            <div className="grid-2" style={{ gap: 16 }}>
              <SelectOrOther
                label="Make" required options={VEHICLE_MAKES.filter(m => m !== 'Other')}
                value={form.vehicleMake} otherValue={form.vehicleMakeOther}
                onChange={setMake} onOtherChange={v => setVal('vehicleMakeOther', v)}
                error={fieldErrors.vehicleMake} otherError={fieldErrors.vehicleMakeOther}
                otherPlaceholder="e.g. Skoda"
              />
              <SelectOrOther
                label="Model" required options={modelOptions}
                value={form.vehicleModel} otherValue={form.vehicleModelOther}
                onChange={v => setVal('vehicleModel', v)} onOtherChange={v => setVal('vehicleModelOther', v)}
                error={fieldErrors.vehicleModel} otherError={fieldErrors.vehicleModelOther}
                otherPlaceholder="e.g. Octavia"
                disabled={!form.vehicleMake}
              />
            </div>
            <div className="grid-2" style={{ gap: 16 }}>
              <SelectField label="Year" required value={form.vehicleYear} onChange={set('vehicleYear')} error={fieldErrors.vehicleYear}>
                <option value="">Select year</option>
                {VEHICLE_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
              </SelectField>
              <SelectOrOther
                label="Colour" required options={VEHICLE_COLORS.filter(c => c !== 'Other')}
                value={form.vehicleColor} otherValue={form.vehicleColorOther}
                onChange={v => setVal('vehicleColor', v)} onOtherChange={v => setVal('vehicleColorOther', v)}
                error={fieldErrors.vehicleColor} otherError={fieldErrors.vehicleColorOther}
                otherPlaceholder="e.g. Maroon"
              />
            </div>
            <div className="grid-2" style={{ gap: 16 }}>
              <TextField label="Number Plate" required value={form.vehiclePlate} onChange={set('vehiclePlate')} error={fieldErrors.vehiclePlate} placeholder="e.g. KCA 123A" />
              <div className="form-group">
                <label className="form-label">Passenger Seats Available <span style={{ color: 'var(--danger)' }}>*</span></label>
                <input
                  className="form-input" type="number" min={1} max={100} step={1}
                  value={form.vehicleSeats} onChange={set('vehicleSeats')} placeholder="e.g. 4"
                />
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>1–100 — vans, minibuses and buses welcome.</span>
                {fieldErrors.vehicleSeats && <span className="form-error">{fieldErrors.vehicleSeats}</span>}
              </div>
            </div>

            <div className="divider" />
            <div>
              <p style={{ fontSize: 13, marginBottom: 10 }}>
                <strong>Vehicle Photo</strong> <span style={{ color: 'var(--danger)' }}>*</span> — upload a clear photo showing the vehicle you intend to use for PamojaRide trips.
              </p>
              <DocumentUploadRow
                doc={vehiclePhotoDoc}
                file={files.vehicle_photo}
                existing={existingDocMap.vehicle_photo}
                error={fileErrors.vehicle_photo}
                uploading={uploadingDoc === 'vehicle_photo'}
                onSelect={f => handleFileSelect('vehicle_photo', f)}
                onRemove={() => removeFile('vehicle_photo')}
                onRetry={() => retryUpload('vehicle_photo')}
                capture="environment"
              />
            </div>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 4 }}>Documents</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Only the documents listed below are required — please don't upload anything else.
            Clear photos or scans (JPG, PNG, or PDF — max {formatBytes(MAX_FILE_SIZE_BYTES)} each).
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {paperDocTypes.map(doc => (
              <DocumentUploadRow
                key={doc.key}
                doc={doc}
                file={files[doc.key]}
                existing={existingDocMap[doc.key]}
                error={fileErrors[doc.key]}
                uploading={uploadingDoc === doc.key}
                onSelect={f => handleFileSelect(doc.key, f)}
                onRemove={() => removeFile(doc.key)}
                onRetry={() => retryUpload(doc.key)}
              />
            ))}
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 4 }}>Identity / Face Verification</h3>
          <FaceVerificationCapture
            onCaptured={handleFaceCaptured}
            existingLabel={existingDocMap.face_verification ? 'Already on file — capture again to replace it' : null}
            disabled={uploadingDoc === 'face_verification'}
          />
          {fileErrors.face_verification && (
            <div className="form-error" style={{ textAlign: 'center', marginTop: 10 }}>{fileErrors.face_verification}</div>
          )}
        </section>
      )}

      {step === 4 && (
        <section className="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 4 }}>Confirm &amp; Submit</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Review everything below before submitting.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <SummaryHeading>Personal</SummaryHeading>
              <div className="grid-2" style={{ gap: 10 }}>
                <InfoRow label="National ID" value={form.nationalId} />
                <InfoRow label="Licence Number" value={form.licenceNumber} />
                <InfoRow label="Licence Expiry" value={formatDate(form.licenceExpiry)} />
                <InfoRow label="Emergency Contact" value={`${form.emergencyContactName} · ${form.emergencyContactPhone}`} />
              </div>
            </div>
            <div className="divider" />
            <div>
              <SummaryHeading>Vehicle</SummaryHeading>
              <div className="grid-2" style={{ gap: 10 }}>
                <InfoRow label="Type" value={form.vehicleType === 'Other' ? form.vehicleTypeOther : form.vehicleType} />
                <InfoRow label="Make / Model" value={`${resolveSelectOrOther(form.vehicleMake, form.vehicleMakeOther)} ${resolveSelectOrOther(form.vehicleModel, form.vehicleModelOther)}`} />
                <InfoRow label="Year / Colour" value={`${form.vehicleYear} · ${resolveSelectOrOther(form.vehicleColor, form.vehicleColorOther)}`} />
                <InfoRow label="Plate" value={form.vehiclePlate} />
                <InfoRow label="Seats" value={form.vehicleSeats} />
                <InfoRow label="Vehicle Photo" value={existingDocMap.vehicle_photo?.file_name || (existingDocMap.vehicle_photo ? 'Already on file' : '—')} />
              </div>
            </div>
            <div className="divider" />
            <div>
              <SummaryHeading>Documents &amp; Face Verification</SummaryHeading>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {DOCUMENT_TYPES.map(doc => {
                  const has = !!files[doc.key] || !!existingDocMap[doc.key];
                  return <span key={doc.key} className={`badge ${has ? 'badge-green' : 'badge-gray'}`}>{has ? '✓' : '—'} {doc.label}</span>;
                })}
              </div>
            </div>
          </div>

          <div className="alert alert-danger" style={{ marginTop: 20 }}>
            ⚠️ <strong>Important:</strong> Make sure all information and documents you provide are accurate, genuine, and belong to you.
            Providing false, misleading, altered, or someone else's information may result in rejection, suspension, or permanent
            banning of your PamojaRide account.
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 16, fontSize: 13.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.confirmAccuracy}
              onChange={e => setVal('confirmAccuracy', e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>I confirm that the information and documents I have provided are accurate and valid.</span>
          </label>
          {fieldErrors.confirmAccuracy && <div className="form-error" style={{ marginTop: 6 }}>{fieldErrors.confirmAccuracy}</div>}
        </section>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 20 }}>
        {step > 0 && (
          <button type="button" className="btn btn-outline" disabled={submitting} onClick={goBack}>← Back</button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn btn-primary" disabled={saveStatus === 'saving' || !!uploadingDoc} onClick={goNext}>
            {saveStatus === 'saving' ? <span className="spinner" /> : 'Next →'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-lg" disabled={submitting || !form.confirmAccuracy} onClick={handleSubmit}>
            {submitting
              ? <span className="spinner" />
              : verificationStatus === 'rejected' ? 'Resubmit for Verification' : 'Submit Verification'}
          </button>
        )}
        {step === 0 && (
          <button type="button" className="btn btn-ghost" disabled={submitting} onClick={onDone}>Do this later</button>
        )}
        {saveStatus === 'saving' && (
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Saving…</span>
        )}
        {saveStatus === 'saved' && (
          <span style={{ fontSize: 12.5, color: 'var(--green, #1a8a4a)' }}>Saved ✓</span>
        )}
        {saveStatus === 'error' && (
          <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>
            {saveErrorMessage || "Couldn't reach the server — check your connection and try again."}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Step progress indicator ─────────────────────────────────────────────
function StepProgress({ steps, current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20, overflowX: 'auto', paddingBottom: 4 }}>
      {steps.map((label, i) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, flexShrink: 0,
            background: i < current ? 'var(--primary)' : i === current ? 'var(--primary)' : 'var(--bg-alt)',
            color: i <= current ? '#fff' : 'var(--text-muted)',
            border: i === current ? '2px solid var(--primary-dark)' : 'none',
          }}>
            {i < current ? '✓' : i + 1}
          </div>
          <span style={{ fontSize: 12, fontWeight: i === current ? 700 : 500, color: i === current ? 'var(--text)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {label}
          </span>
          {i < steps.length - 1 && <div style={{ width: 20, height: 2, background: 'var(--border)', flexShrink: 0 }} />}
        </div>
      ))}
    </div>
  );
}

function SummaryHeading({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

// ── Reusable field components ──────────────────────────────────────────────
function TextField({ label, required, error, ...inputProps }) {
  return (
    <div className="form-group">
      <label className="form-label">{label} {required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
      <input className="form-input" {...inputProps} />
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

function SelectField({ label, required, error, children, ...selectProps }) {
  return (
    <div className="form-group">
      <label className="form-label">{label} {required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
      <select className="form-select" {...selectProps}>{children}</select>
      {error && <span className="form-error">{error}</span>}
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

// ── Document upload row: picker, preview, progress, remove/replace ─────────
// `capture="environment"` (only meaningful for vehicle_photo) hints mobile
// browsers to offer the rear camera directly, per "allow the driver to
// take the photo directly from a phone camera" — it's a progressive-
// enhancement attribute; browsers that don't support it just fall back to
// the normal file/photo picker.
function DocumentUploadRow({ doc, file, existing, error, uploading, onSelect, onRemove, onRetry, capture }) {
  const inputRef = useRef(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const accept = doc.imageOnly ? ALLOWED_IMAGE_MIME_TYPES.join(',') : ALLOWED_MIME_TYPES.join(',');

  function pick() { inputRef.current?.click(); }

  function handleChange(e) {
    const selected = e.target.files?.[0];
    onSelect(e.target.files);
    if (selected && selected.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(selected));
    } else {
      setPreviewUrl(null);
    }
    e.target.value = '';
  }

  const hasNewFile = !!file;
  const hasExisting = !hasNewFile && !!existing;
  // A file only stays in `file` after an upload attempt when it failed —
  // uploadAndSave() clears it on success — so hasNewFile + an error means
  // "this one didn't save, and is waiting to be retried", not "ready to
  // submit". Distinguishing this from the (very brief) in-flight state
  // matters for the copy below.
  const failed = hasNewFile && !!error && !uploading;

  return (
    <div style={{
      border: `1.5px dashed ${error ? 'var(--danger)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)',
      padding: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      background: hasNewFile || hasExisting ? 'var(--bg-alt)' : 'transparent',
    }}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture}
        style={{ display: 'none' }}
        onChange={handleChange}
      />

      <div style={{ fontSize: 26, flexShrink: 0 }}>
        {previewUrl ? (
          <img src={previewUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8 }} />
        ) : hasNewFile || hasExisting ? '📄' : '📎'}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {doc.label} {doc.required && <span style={{ color: 'var(--danger)' }}>*</span>}
        </div>
        {hasNewFile ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {file.name} · {formatBytes(file.size)} — {uploading ? 'saving…' : failed ? 'not saved — tap Retry' : 'saved'}
          </div>
        ) : hasExisting ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{existing.file_name || 'Uploaded'} — already on file</div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {doc.imageOnly ? 'JPG or PNG' : 'JPG, PNG, or PDF'} — max {formatBytes(MAX_FILE_SIZE_BYTES)}
          </div>
        )}
        {error && <div className="form-error" style={{ marginTop: 4 }}>{error}</div>}
      </div>

      <div style={{ flexShrink: 0, display: 'flex', gap: 8 }}>
        {uploading ? (
          <span className="spinner" />
        ) : failed ? (
          <>
            <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>Retry</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>
          </>
        ) : hasNewFile ? (
          <>
            <button type="button" className="btn btn-outline btn-sm" onClick={pick}>Replace</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>
          </>
        ) : (
          <button type="button" className="btn btn-outline btn-sm" onClick={pick}>{hasExisting ? 'Replace' : 'Upload'}</button>
        )}
      </div>
    </div>
  );
}
