-- ============================================================================
-- PamojaRide — Profile & Account Settings: profile-photo storage + RLS
-- ============================================================================
--
-- CONTEXT: profiles.profile_picture already exists and is already rendered
-- throughout the app (Navbar, driver dashboard rail, DriverPreviewCard,
-- DriverDetailsCard — all with a graceful initials fallback when it's
-- null), but nothing in the project could ever actually SET it: no bucket,
-- no upload UI. This migration adds the storage side; the upload UI is
-- src/lib/profilePhoto.js + src/components/shared/PersonalInfoCard.jsx.
--
-- PUBLIC, unlike "driver-documents": profile photos are rendered directly
-- as <img src={profile_picture}> to OTHER users too (a passenger viewing a
-- driver's card before booking), which only works with a stable public URL
-- — a private bucket would need a signed URL re-issued on every render,
-- everywhere a photo is shown, for no real confidentiality benefit (a
-- profile photo, unlike a national ID scan, isn't sensitive).
--
-- Same idempotent, additive pattern as every other migration in this
-- project. Safe to run multiple times.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  true, -- PUBLIC: read access needed by other users viewing this profile's photo
  3145728, -- 3MB, matches MAX_PHOTO_SIZE_BYTES in src/lib/profilePhoto.js
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

-- Path convention: "{user_id}/avatar-{timestamp}.{ext}" — same shape as
-- verification_storage.sql's driver-documents bucket, so
-- (storage.foldername(name))[1] = auth.uid()::text is what every policy
-- below keys off of.

drop policy if exists "anyone can view profile photos" on storage.objects;
create policy "anyone can view profile photos"
on storage.objects for select
to public
using (bucket_id = 'profile-photos');

drop policy if exists "users can upload own profile photo" on storage.objects;
create policy "users can upload own profile photo"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "users can replace own profile photo" on storage.objects;
create policy "users can replace own profile photo"
on storage.objects for update
to authenticated
using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "users can remove own profile photo" on storage.objects;
create policy "users can remove own profile photo"
on storage.objects for delete
to authenticated
using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ----------------------------------------------------------------------------
-- Re-assert "own profile" UPDATE access on public.profiles (defense-in-
-- depth, same reasoning as driver_approval_admin_policy.sql: the other
-- migrations in this project were written against live introspection and
-- found this already in place; I don't have live access in this task to
-- confirm it's still there under the same name, so this idempotently
-- re-creates the same-effect policy rather than assume). This is what lets
-- PersonalInfoCard's updateProfile()/photo-save calls reach the row at all
-- — WHICH columns a non-admin may actually change within that row is a
-- separate question, already fully handled by the existing
-- trg_protect_profile_privileged_columns trigger (critical_security_
-- fixes.sql), which blocks is_admin and trips_completed for anyone but an
-- admin/the system. full_name, phone, and profile_picture are untouched by
-- that trigger, i.e. already freely editable by their own owner — this
-- policy only grants reaching the row, it doesn't loosen anything the
-- trigger restricts.
-- ----------------------------------------------------------------------------
drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());
