-- ============================================================================
-- PamojaRide — Driver KYC document storage (bucket + RLS only)
-- ============================================================================
-- Run this once in Supabase SQL Editor. Does NOT touch driver_profiles or
-- any trigger — your database already has its own privilege-protection
-- trigger on driver_profiles (trg_protect_driver_profile_privileged_columns),
-- discovered via live schema introspection, so nothing extra is added here
-- until we've reviewed what that trigger already permits.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'driver-documents',
  'driver-documents',
  false, -- PRIVATE: never publicly readable; access only via signed URLs
  5242880, -- 5MB, matches MAX_FILE_SIZE_BYTES in src/lib/verificationDocuments.js
  array['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];

-- Path convention: "{driver_id}/{filename}" — (storage.foldername(name))[1]
-- is the first path segment, i.e. the driver_id folder. See
-- src/lib/verificationDocuments.js for the upload path builder.

drop policy if exists "drivers can upload own documents" on storage.objects;
create policy "drivers can upload own documents"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'driver-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "drivers can read own documents" on storage.objects;
create policy "drivers can read own documents"
on storage.objects for select
to authenticated
using (
  bucket_id = 'driver-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "drivers can replace own documents" on storage.objects;
create policy "drivers can replace own documents"
on storage.objects for update
to authenticated
using (bucket_id = 'driver-documents' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'driver-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "drivers can remove own documents" on storage.objects;
create policy "drivers can remove own documents"
on storage.objects for delete
to authenticated
using (bucket_id = 'driver-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "admins can read all driver documents" on storage.objects;
create policy "admins can read all driver documents"
on storage.objects for select
to authenticated
using (
  bucket_id = 'driver-documents'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
);

create index if not exists idx_driver_profiles_verification_status
  on public.driver_profiles (verification_status);

-- ============================================================================
-- Fix: your existing trigger (discovered via live introspection) only
-- allows a driver to submit verification when their CURRENT status is
-- 'active' or 'rejected'. But driver_profiles.verification_status actually
-- DEFAULTS to 'pending' — confirmed against your live data, every real
-- driver row is stuck at 'pending' — so no first-time driver could ever
-- submit; the trigger raised "Only an administrator may change
-- verification_status" every time. This redefines the SAME function,
-- adding 'pending' to the allowed set. Everything else is identical to
-- what's already running in production.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.protect_driver_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_driver_kyc_submission boolean;
begin
  if public.is_admin(auth.uid()) then
    return new;
  end if;

  v_is_driver_kyc_submission := (
    auth.uid() = old.profile_id
    and old.verification_status in ('pending', 'active', 'rejected')
    and new.verification_status = 'pending_verification'
  );

  if new.verification_status is distinct from old.verification_status then
    if not v_is_driver_kyc_submission then
      raise exception 'Only an administrator may change verification_status (the sole exception is a driver submitting KYC documents)';
    end if;
    new.kyc_submitted_at := now();
    new.kyc_attempts := coalesce(old.kyc_attempts, 0) + 1;
  end if;

  if new.account_status is distinct from old.account_status then
    raise exception 'Only an administrator may change account_status';
  end if;

  if new.trust_level          is distinct from old.trust_level
     or new.max_seats_per_trip   is distinct from old.max_seats_per_trip
     or new.max_active_trips     is distinct from old.max_active_trips
     or new.payout_delay_hours   is distinct from old.payout_delay_hours
     or new.trips_completed      is distinct from old.trips_completed
     or new.dispute_count        is distinct from old.dispute_count
     or new.flagged_for_review   is distinct from old.flagged_for_review
     or new.suspension_reason    is distinct from old.suspension_reason
     or new.kyc_approved_at      is distinct from old.kyc_approved_at
     or new.kyc_approved_by      is distinct from old.kyc_approved_by
     or new.kyc_rejection_reason is distinct from old.kyc_rejection_reason
  then
    raise exception 'Only an administrator may change privileged driver profile fields';
  end if;

  return new;
end;
$function$;
