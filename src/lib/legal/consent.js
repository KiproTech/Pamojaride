// ============================================================================
// PamojaRide — record Terms & Conditions / Privacy Policy consent.
// ============================================================================
//
// There are two places consent needs to be written:
//
//  1. Brand-new identity registering for the first time: handled entirely
//     server-side. PassengerRegister.jsx / DriverRegister.jsx pass
//     `terms_accepted: true, terms_version: TERMS_VERSION` in
//     supabase.auth.signUp()'s `options.data`, and the
//     trg_apply_registration_consent trigger (see
//     src/database/terms_privacy_consent.sql) copies that onto the new
//     profiles row the moment it's created — no extra call needed here.
//
//  2. Attaching a second role (driver/passenger) to an email that already
//     has an identity: no new profiles row is created in this path (see
//     the `alreadyRegistered` branch in both register pages), so the
//     INSERT-time trigger above never fires. This helper covers that case
//     with a plain, already-authenticated update() — the same RLS-permitted
//     own-row update every other profile edit in this app already uses
//     (see PersonalInfoCard.jsx / ChangePasswordCard.jsx). Also reused by
//     LegalConsentCard.jsx so an existing (pre-feature) user can
//     voluntarily record consent from their Profile page.
//
// terms_accepted_at is deliberately NOT sent from here — it's set by the
// database (protect_profile_privileged_columns trigger) using the
// server's clock, never a client-supplied value.

import { TERMS_VERSION } from './termsContent';

export { TERMS_VERSION };

export async function acceptTermsForUser(supabaseClient, userId) {
  const { error } = await supabaseClient
    .from('profiles')
    .update({ terms_accepted: true, terms_version: TERMS_VERSION })
    .eq('id', userId);

  if (error) throw new Error(error.message);
}
