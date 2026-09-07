// ============================================================================
// Profile photo upload helpers — shared by Passenger and Driver Profile
// pages (via components/shared/PersonalInfoCard.jsx) so there's exactly one
// upload/validation/cleanup path for the `profiles.profile_picture` column,
// which is already displayed throughout the app (Navbar initials fallback,
// driver dashboard rail, DriverPreviewCard, DriverDetailsCard) but had no
// UI anywhere to actually set it.
//
// Storage: a PUBLIC bucket ("profile-photos") — see
// src/database/profile_photo_storage.sql for the bucket + RLS. Public is the
// correct choice here (unlike the private "driver-documents" KYC bucket):
// profile photos are already rendered as plain <img src={profile_picture}>
// all over the app, including to OTHER users (a passenger viewing a driver's
// card) — that only works with a stable public URL, not a signed URL that
// expires and would need re-issuing on every render.
//
// Path convention: "{user_id}/avatar-{timestamp}.{ext}" — same shape as
// verificationDocuments.js's "{driver_id}/{doc_type}-{timestamp}.{ext}", so
// the storage RLS can key off (storage.foldername(name))[1] = auth.uid()
// exactly the same way.
// ============================================================================

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
export const MAX_PHOTO_SIZE_BYTES = 3 * 1024 * 1024; // 3MB — plenty for an avatar, keeps uploads fast
const BUCKET = 'profile-photos';

export function validateImageFile(file) {
  if (!file) return 'No file selected.';
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
    return 'Only JPG, PNG, or WEBP images are allowed.';
  }
  if (file.size > MAX_PHOTO_SIZE_BYTES) {
    return 'Image is too large — maximum size is 3MB.';
  }
  return null;
}

function extensionFor(file) {
  const fromName = file.name?.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/webp') return 'webp';
  return 'jpg';
}

// Pulls the storage object path back out of a previously-stored public URL,
// so a replace/remove can target the exact old file. Returns null for
// anything that isn't one of our own profile-photos public URLs (e.g. no
// photo set yet, or a value from before this feature existed) — callers
// treat null as "nothing to clean up", never as an error.
export function pathFromPublicUrl(url) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}

// Uploads a new profile photo for the CURRENT authenticated user only — the
// path is always rooted at userId, which the caller must pass as the
// authenticated user's own id (auth.uid()), never a value from a form
// field. Returns the new object's PUBLIC url on success, ready to save
// straight onto profiles.profile_picture via updateProfile().
export async function uploadProfilePhoto(client, userId, file) {
  const validationError = validateImageFile(file);
  if (validationError) return { url: null, error: { message: validationError } };

  const path = `${userId}/avatar-${Date.now()}.${extensionFor(file)}`;

  const { error: uploadError } = await client.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) return { url: null, error: uploadError };

  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  return { url: data?.publicUrl ?? null, error: null };
}

// Best-effort cleanup of a replaced/removed photo. Failures are swallowed
// by the caller (an orphaned old file is a minor storage-cost issue, never
// a reason to fail the profile update the user actually asked for).
export async function removeProfilePhoto(client, path) {
  if (!path) return { error: null };
  return client.storage.from(BUCKET).remove([path]);
}
