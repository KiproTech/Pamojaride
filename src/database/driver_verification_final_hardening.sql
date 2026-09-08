-- ============================================================================
-- PamojaRide — Driver verification: final hardening (4-document cap +
-- document-path ownership, enforced at the database layer)
-- ============================================================================
-- Run this once in the Supabase SQL Editor, AFTER every other migration in
-- src/database/ (in particular verification_storage.sql,
-- vehicle_face_verification_upgrade.sql, verification_progress_persistence.sql,
-- critical_security_fixes.sql, driver_approval_admin_policy.sql). Idempotent
-- — safe to re-run. Purely additive: no table is dropped, no column is
-- removed, and no existing driver/verification data is touched or deleted.
--
-- WHY THIS FILE EXISTS (inspection findings — nothing below duplicates an
-- existing system):
--
--   1. The 4-document limit (src/lib/verificationDocuments.js
--      DOCUMENT_TYPES, capped at 4) was already fully enforced in the UI —
--      the Documents/Face Verification steps only ever offer 4 fixed
--      upload slots. It was NOT enforced anywhere the database could catch
--      a client that bypasses the UI: the existing "drivers can update own
--      profile" RLS policy (driver_approval_admin_policy.sql) lets an
--      authenticated driver write ANY jsonb value into their own
--      kyc_documents column via a direct API call, with nothing checking
--      its shape, size, or that every entry actually belongs to them. This
--      migration closes exactly that gap with one new BEFORE INSERT/UPDATE
--      trigger on driver_profiles — no new table, column, or bucket.
--
--   2. Storage bucket + RLS (verification_storage.sql) already: creates a
--      PRIVATE "driver-documents" bucket (public = false), restricts
--      insert/select/update/delete on storage.objects to the requesting
--      driver's own "{auth.uid()}/..." folder, and already grants an
--      unconditional "admins can read all driver documents" SELECT policy
--      (keyed off profiles.is_admin, with no verification_status
--      condition — works before AND after approval). Nothing here touches
--      or duplicates that bucket or those policies; they're already
--      correct.
--
--   3. Table-level admin/driver read access to driver_profiles (including
--      kyc_documents) is already correctly scoped by "admin can read all
--      driver profiles" (critical_security_fixes.sql) and "drivers can
--      read own profile" (verification_progress_persistence.sql). No
--      passenger-facing policy or RPC selects driver_profiles at all —
--      passengers only ever see driver info through the dedicated,
--      narrower RPCs (get_trip_driver_previews / get_booked_trip_driver_
--      details), neither of which returns kyc_documents. Nothing to change
--      here either.
--
--   4. Storage object COUNT cannot practically be capped with a
--      storage.objects RLS policy (RLS conditions can't run an aggregate
--      COUNT(*) subquery against the same table mid-INSERT in a
--      Supabase-managed way here), so instead this migration caps the
--      thing that actually matters — the kyc_documents jsonb array that
--      every admin screen and every RPC reads — and the accompanying
--      frontend change (src/lib/verificationDocuments.js,
--      uploadVerificationDocument) now deletes the superseded Storage
--      object immediately after a successful replace, so in practice a
--      driver's Storage folder stays at (at most) one live object per
--      document type too.
-- ============================================================================

-- ── 1. Enforce the 4-document cap + basic integrity, at the database layer ──
-- Applies to every INSERT/UPDATE of driver_profiles.kyc_documents made by a
-- non-admin (a driver updating their own row via the app or any direct API
-- call). Admins are exempt (SECURITY DEFINER + is_admin check, same pattern
-- as protect_driver_profile_privileged_columns()) so admin tooling/manual
-- corrections are never blocked.
--
-- Rules enforced:
--   a) kyc_documents must be a JSON array (or NULL).
--   b) Each entry must be an object with a non-empty `type` and `path`.
--   c) No two entries may share the same `type` — one current document per
--      type, matching mergeKycDocuments()'s dedupe-by-type behaviour in
--      src/context/AuthContext.jsx; a direct API call can no longer stuff
--      in duplicates that the app's own merge logic would never produce.
--   d) Every entry's `path` must start with "<this driver's own
--      profile_id>/" — the same folder-prefix convention the Storage RLS
--      policies already key off of (verification_storage.sql) — so a
--      driver can never point their own kyc_documents record at another
--      driver's file path, even though they still couldn't read the file
--      itself thanks to the Storage RLS.
--   e) The array may never grow past GREATEST(4, however many entries were
--      already on file before this update). For every driver who has never
--      exceeded 4 (the normal case, and every driver going forward), this
--      is a hard cap of exactly 4 — the same "at most 4 uploads" rule the
--      UI already states. For a driver who, under the OLD 6-document list,
--      already had 5 or 6 legacy entries (e.g. an old logbook/insurance
--      upload from before the cap was introduced), this preserves that
--      existing data losslessly instead of destroying it, while still
--      preventing any FURTHER growth beyond what they already had.
CREATE OR REPLACE FUNCTION public.enforce_driver_kyc_documents_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_count   integer;
  v_new_count   integer;
  v_max_allowed integer;
  v_doc         jsonb;
  v_type        text;
  v_path        text;
  v_seen_types  text[] := '{}';
BEGIN
  -- Admins (e.g. manual data fixes via the SQL editor or future admin
  -- tooling) are never restricted by this check.
  IF public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Nothing to validate if this column isn't part of the change.
  IF TG_OP = 'UPDATE' AND NEW.kyc_documents IS NOT DISTINCT FROM OLD.kyc_documents THEN
    RETURN NEW;
  END IF;

  IF NEW.kyc_documents IS NULL THEN
    RETURN NEW; -- clearing to NULL is never a "too many documents" problem
  END IF;

  IF jsonb_typeof(NEW.kyc_documents) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'kyc_documents must be a JSON array';
  END IF;

  v_old_count := CASE
    WHEN TG_OP = 'UPDATE' AND OLD.kyc_documents IS NOT NULL AND jsonb_typeof(OLD.kyc_documents) = 'array'
      THEN jsonb_array_length(OLD.kyc_documents)
    ELSE 0
  END;
  v_new_count   := jsonb_array_length(NEW.kyc_documents);
  v_max_allowed := GREATEST(4, v_old_count);

  IF v_new_count > v_max_allowed THEN
    RAISE EXCEPTION 'A driver may have at most % verification document(s) on file (attempted %)', v_max_allowed, v_new_count;
  END IF;

  FOR v_doc IN SELECT * FROM jsonb_array_elements(NEW.kyc_documents)
  LOOP
    IF jsonb_typeof(v_doc) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each kyc_documents entry must be a JSON object';
    END IF;

    v_type := v_doc->>'type';
    v_path := v_doc->>'path';

    IF v_type IS NULL OR btrim(v_type) = '' THEN
      RAISE EXCEPTION 'Each verification document must include a type';
    END IF;
    IF v_path IS NULL OR btrim(v_path) = '' THEN
      RAISE EXCEPTION 'Each verification document must include a storage path';
    END IF;

    IF v_type = ANY(v_seen_types) THEN
      RAISE EXCEPTION 'Duplicate document type "%" in kyc_documents — only one current file per document type is allowed', v_type;
    END IF;
    v_seen_types := array_append(v_seen_types, v_type);

    -- Must live inside the caller's OWN storage folder, matching the
    -- "{driver_id}/{doc_type}-{timestamp}.{ext}" convention the Storage
    -- RLS policies (verification_storage.sql) already enforce for reads/
    -- writes. This stops a driver from recording a pointer to a path
    -- outside their own folder in the metadata, even though the Storage
    -- policies already prevent them from ever reading such a file.
    IF v_path NOT LIKE (NEW.profile_id::text || '/%') THEN
      RAISE EXCEPTION 'Document path for type "%" does not belong to this driver', v_type;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_driver_kyc_documents_integrity ON public.driver_profiles;
CREATE TRIGGER trg_enforce_driver_kyc_documents_integrity
BEFORE INSERT OR UPDATE ON public.driver_profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_kyc_documents_integrity();

COMMENT ON FUNCTION public.enforce_driver_kyc_documents_integrity() IS
  'Backend enforcement of the 4-document verification cap: rejects a '
  'non-admin write to driver_profiles.kyc_documents that exceeds the '
  'driver''s existing document count (capped at 4 for anyone who has '
  'never exceeded it), contains duplicate document types, or references '
  'a storage path outside the driver''s own folder. Complements (does '
  'not replace) the existing UI-level 4-upload limit and the Storage RLS '
  'policies in verification_storage.sql.';

-- ============================================================================
-- Explicitly NOT done here, and why:
--
--   - No changes to storage.buckets or storage.objects RLS policies: the
--     private bucket, owner-folder read/write/delete policies, and the
--     unconditional admin-read policy in verification_storage.sql are
--     already correct and already satisfy every requirement in this task
--     (driver isolation, no passenger access, no public exposure,
--     admin-only review access, admin access surviving approval).
--
--   - No changes to driver_profiles RLS SELECT/UPDATE policies: "admin can
--     read all driver profiles", "drivers can read own profile", "admin
--     can update driver profiles", and "drivers can update own profile"
--     already correctly scope who can reach a driver_profiles row at all;
--     this migration only tightens WHAT a driver-scoped write may contain,
--     via the trigger above — the same layering
--     protect_driver_profile_privileged_columns() already uses.
--
--   - No new table, bucket, or verification system: kyc_documents remains
--     the single source of truth for every uploaded verification file
--     (identity documents, vehicle photo, and face-verification photo
--     alike), exactly as vehicle_face_verification_upgrade.sql already
--     established.
-- ============================================================================
