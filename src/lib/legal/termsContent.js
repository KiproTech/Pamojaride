// ============================================================================
// PamojaRide — Terms & Conditions and Privacy Policy: single source of
// truth for the copy shown in TermsPrivacyModal.jsx and the full page at
// /legal/terms (src/pages/legal/TermsAndPrivacy.jsx).
//
// ONE PamojaRide-wide agreement, not a separate document per role — driver-
// specific document-handling rules live in their own clearly-labelled
// section (id: 'driver-documents') rather than as a second document, per
// the product requirement. Both PassengerRegister.jsx and
// DriverRegister.jsx link to and require agreement to this SAME content;
// DriverRegister.jsx additionally surfaces the 'driver-documents' section
// inline as its own notice box, since that section is the one a driver
// specifically needs to see before uploading anything.
//
// Bump TERMS_VERSION whenever the substance of this content changes.
// Existing acceptances (profiles.terms_version) are never rewritten
// retroactively — a version bump only affects what NEW acceptances record,
// so old audit rows keep truthfully reflecting the version a person
// actually agreed to at the time.
// ============================================================================

export const TERMS_VERSION = '1.0';
export const TERMS_LAST_UPDATED = 'September 8, 2026';

export const TERMS_SECTIONS = [
  {
    id: 'introduction',
    title: '1. Introduction',
    paragraphs: [
      'These Terms & Conditions and this Privacy Policy ("Terms") govern your use of PamojaRide, a ride-sharing platform connecting passengers and drivers across Kenya. By creating a PamojaRide account — as a passenger or as a driver — you agree to these Terms.',
      'PamojaRide maintains one set of Terms & Conditions and one Privacy Policy that apply platform-wide. Drivers are additionally bound by the driver-specific provisions in Section 5, which apply on top of — not instead of — everything else in this document.',
    ],
  },
  {
    id: 'account-registration',
    title: '2. Account Registration',
    paragraphs: [
      'You must provide accurate, current information when registering (full name, email address, and phone number). You are responsible for keeping your login credentials secure and for all activity that happens under your account.',
      'One person may hold both a passenger profile and a driver profile under the same account. Agreeing to these Terms once covers both roles on that account.',
    ],
  },
  {
    id: 'privacy-information-use',
    title: '3. How We Handle Your Personal Information',
    paragraphs: [
      'Information you provide during registration and while using PamojaRide (name, email, phone number, profile photo, emergency contact details, trip and booking history, ratings, and — for drivers — vehicle and licence details) is handled securely and used only for legitimate PamojaRide purposes: operating the service, matching trips, processing bookings and payments, communicating with you about your account or trips, safety and fraud prevention, resolving disputes and reports, and complying with legal obligations.',
      'Your personal information is not publicly displayed beyond what is reasonably necessary to use the service — for example, a driver and passenger on a shared trip can see the trip-relevant details needed to complete that trip (such as a name, contact details for coordinating pickup, and vehicle information), but your full profile is not exposed to the public or to other users you have no trip in common with.',
      'We do not share your personal information or verification documents with unauthorized people or third parties, except: (a) where required by Kenyan law or a valid legal process, (b) where necessary to provide the service you have requested (for example, sharing minimal trip-coordination details with your matched driver or passenger), or (c) with your explicit consent.',
      'You may request access to, correction of, or deletion of your personal information (subject to records we are legally required to retain) by contacting PamojaRide support from within the app.',
    ],
  },
  {
    id: 'driver-document-confidentiality',
    title: '4. Confidentiality of Driver Verification Documents',
    paragraphs: [
      'Driver verification documents (such as a driving licence, national ID, and vehicle-related documents) are confidential. They are only accessible to authorized PamojaRide administrators and staff who need them for verification, safety, compliance, or legitimate reference purposes.',
      'Documents you upload for verification are never downloadable or viewable by other drivers or by passengers — not even in aggregate, and not even after your account is verified.',
    ],
  },
  {
    id: 'driver-documents',
    title: '5. Driver-Specific Terms: Verification Documents',
    paragraphs: [
      'This section applies to driver accounts, in addition to everything else in these Terms.',
      'Verification documents are required to confirm your identity and eligibility to drive on PamojaRide before you can be approved to post trips.',
      'Approved drivers\' documents may be retained after approval. Retention supports legitimate verification, safety, compliance, and reference purposes — for example, responding to a safety report, a legal or regulatory request, or re-confirming your identity if your account is later flagged for review.',
      'Documents are always treated as confidential, per Section 4 above — retention after approval does not change who can access them.',
      'You must only upload genuine, unaltered, and accurate documents that belong to you. Providing false, misleading, expired, or altered documents may result in your verification being rejected, delayed, or — if discovered after approval — in suspension or termination of your account.',
    ],
  },
  {
    id: 'payments',
    title: '6. Payments',
    paragraphs: [
      'Passengers pay for bookings through the payment methods PamojaRide supports (including M-Pesa). Drivers receive payouts for completed trips according to the payout terms shown in their driver dashboard.',
    ],
  },
  {
    id: 'conduct-safety',
    title: '7. Conduct & Safety',
    paragraphs: [
      'All users are expected to behave respectfully and safely. Reports of unsafe driving, harassment, no-shows, or other misconduct are reviewed by PamojaRide administrators and may result in warnings, suspension, or account termination.',
    ],
  },
  {
    id: 'changes',
    title: '8. Changes to These Terms',
    paragraphs: [
      'We may update these Terms from time to time. Material changes will be reflected in a new version number, and continued use of PamojaRide after an update constitutes acceptance of the revised Terms.',
    ],
  },
  {
    id: 'contact',
    title: '9. Contact',
    paragraphs: [
      'Questions about these Terms or how your information is handled can be sent through the Help & Support section of the app.',
    ],
  },
];

// The subset shown as a compact, driver-facing notice box directly under
// the driver registration form (Requirement 3), so a driver doesn't have
// to open the full document to see the document-handling rules that apply
// specifically to them. Kept as short bullet points here; the full,
// unabridged wording lives in TERMS_SECTIONS above (id: 'driver-documents'
// and 'driver-document-confidentiality') and is what actually governs.
export const DRIVER_DOCUMENT_NOTICE_POINTS = [
  'Verification documents are required to confirm your identity and eligibility to drive.',
  'Documents may be retained after approval for verification, safety, compliance, and reference purposes.',
  'Documents are confidential — only authorized PamojaRide administrators can access them. Other drivers and passengers can never view or download them.',
  'Upload only genuine, accurate documents. False or misleading information can result in verification failure or account action.',
];
