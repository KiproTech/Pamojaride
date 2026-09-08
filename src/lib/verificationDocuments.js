// ============================================================================
// Driver KYC document upload helpers.
//
// Documents are stored in a PRIVATE Supabase Storage bucket named
// "driver-documents" (see src/database/verification_storage.sql for the
// bucket + RLS policies that must exist for this to work). Files are never
// public — every read goes through a short-lived signed URL created
// on demand for an authenticated admin or the owning driver.
//
// Storage path convention:
//   {driver_id}/{doc_type}-{timestamp}.{ext}
// The {driver_id} folder prefix is what the storage RLS policies key off
// of, so a driver can only ever write/read inside their own folder.
// ============================================================================

// Capped at 4 — the maximum number of uploads a driver is ever asked for,
// keeping only what's genuinely necessary to verify who the driver is and
// what vehicle they'll be driving:
//   - National ID + Driving Licence: confirm identity and legal eligibility
//     to drive.
//   - Vehicle Photo: visual confirmation of the actual vehicle in use.
//   - Face Verification Photo: matches the driver's live face against their
//     ID, the core anti-fraud check.
// Vehicle Logbook and Insurance Certificate were dropped from this list —
// they're compliance/ownership paperwork rather than identity or vehicle
// verification, and any driver who previously uploaded one still has it on
// file (kyc_documents is additive/never truncated), it's just no longer
// collected or required going forward.
export const DOCUMENT_TYPES = [
  { key: 'national_id', label: 'National ID', required: true },
  { key: 'driving_licence', label: 'Driving Licence', required: true },
  // Image-only (no PDF) — the driver is declaring the actual vehicle/face,
  // not scanning a paper document, so a photo format is required.
  { key: 'vehicle_photo', label: 'Vehicle Photo', required: true, imageOnly: true },
  { key: 'face_verification', label: 'Face Verification Photo', required: true, imageOnly: true },
];

export const MAX_VERIFICATION_UPLOADS = DOCUMENT_TYPES.length; // 4

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const BUCKET = 'driver-documents';

// `imageOnly` rejects PDFs — used for vehicle_photo and face_verification,
// where the driver must submit an actual photo rather than a scanned doc.
export function validateFile(file, { imageOnly = false } = {}) {
  if (!file) return 'No file selected.';
  const allowed = imageOnly ? ALLOWED_IMAGE_MIME_TYPES : ALLOWED_MIME_TYPES;
  if (!allowed.includes(file.type)) {
    return imageOnly ? 'Only JPG or PNG photos are allowed.' : 'Only JPG, PNG, or PDF files are allowed.';
  }
  if (file.size > MAX_FILE_SIZE_BYTES) return 'File is too large — maximum size is 5MB.';
  return null;
}

function extensionFor(file) {
  const fromName = file.name?.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type === 'image/png') return 'png';
  return 'jpg';
}

// Uploads one document for the CURRENT authenticated user only — the path
// is always rooted at driverId, which the caller must pass as the
// authenticated user's own id (never a value from a form field).
// Face capture goes through this exact same function (called with
// docType='face_verification' and a File built from a captured canvas
// frame) — one upload/storage/RLS path for every kind of driver document,
// photo included.
//
// `previousPath`, if given (the path of whatever this upload is replacing,
// e.g. from the existing kyc_documents entry for this doc type), is best-
// effort removed from Storage AFTER the new file is safely uploaded. This
// keeps a driver's folder capped at (at most) one object per document type
// instead of accumulating an orphaned copy on every "Replace" — the same
// 4-document ceiling the UI and database enforce for kyc_documents should
// hold for the actual files sitting in Storage too. Failing to delete the
// old file is logged but never fails the upload itself — the new document
// is already saved and correct; a leftover old object is untidy, not a
// correctness or security problem (it's still private, still only
// reachable by this driver or an admin).
export async function uploadVerificationDocument(client, driverId, docType, file, previousPath) {
  const docConfig = DOCUMENT_TYPES.find(d => d.key === docType);
  const validationError = validateFile(file, { imageOnly: !!docConfig?.imageOnly });
  if (validationError) return { data: null, error: { message: validationError } };

  const safeExt = extensionFor(file);
  const path = `${driverId}/${docType}-${Date.now()}.${safeExt}`;

  const { error: uploadError } = await client.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) return { data: null, error: uploadError };

  if (previousPath && previousPath !== path) {
    const { error: removeError } = await removeVerificationDocument(client, previousPath);
    if (removeError) console.error('Could not remove superseded verification document:', previousPath, removeError);
  }

  return {
    data: {
      type: docType,
      path,
      file_name: file.name,
      size: file.size,
      mime_type: file.type,
      uploaded_at: new Date().toISOString(),
    },
    error: null,
  };
}

export async function getSignedDocumentUrl(client, path, expiresInSeconds = 300) {
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error) return { url: null, error };
  return { url: data?.signedUrl ?? null, error: null };
}

export async function removeVerificationDocument(client, path) {
  return client.storage.from(BUCKET).remove([path]);
}
