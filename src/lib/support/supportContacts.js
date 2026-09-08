import { supabase } from '../supabase';
import { toTelHref, toWhatsappHref, toMailtoHref, toSafeUrl, displayValue } from './contactLinks';

// Data-fetching / update helpers for the centralized PamojaRide Support
// Contacts (database/admin_support_contacts_foundation.sql) — a single
// row of PamojaRide's own contact details (support email, support phone,
// WhatsApp number, Facebook, Twitter/X), NOT a passenger's or driver's
// personal contact info and NOT the separate `support_requests` ticket
// system (database/customer_support_system.sql, lib/support/support.js).
//
// Reads go through a plain `.select()` on `support_contacts`, gated by
// that table's "authenticated users can view support contacts" RLS
// policy — any signed-in passenger, driver, or admin can read. Writes go
// through a plain `.update()`, gated by the admin-only UPDATE policy;
// a non-admin caller's update is simply rejected by RLS and surfaces as
// an error here, never silently ignored.

const EMPTY_CONTACTS = {
  support_email: '',
  support_phone: '',
  whatsapp_number: '',
  facebook_url: '',
  twitter_url: '',
  updated_at: null,
};

// Fetches the single support-contacts row. Returns EMPTY_CONTACTS (never
// throws) if the row is somehow missing, so a page can always render
// something sensible instead of crashing on a null.
export async function fetchSupportContacts() {
  const { data, error } = await supabase
    .from('support_contacts')
    .select('support_email, support_phone, whatsapp_number, facebook_url, twitter_url, updated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error('fetchSupportContacts error:', error);
    return { contacts: EMPTY_CONTACTS, error };
  }
  return { contacts: data || EMPTY_CONTACTS, error: null };
}

// Updates the support-contacts row. `updated_by`/`updated_at` are stamped
// server-side by trg_touch_support_contacts_updated_at regardless of what
// is sent here. Admin-only via RLS — a non-admin caller gets back an
// error rather than a silent no-op.
export async function updateSupportContacts({ supportEmail, supportPhone, whatsappNumber, facebookUrl, twitterUrl }) {
  const norm = v => {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  };

  const { error } = await supabase
    .from('support_contacts')
    .update({
      support_email: norm(supportEmail),
      support_phone: norm(supportPhone),
      whatsapp_number: norm(whatsappNumber),
      facebook_url: norm(facebookUrl),
      twitter_url: norm(twitterUrl),
    })
    .eq('id', 1);

  if (error) {
    console.error('updateSupportContacts error:', error);
    return { error: { message: "We couldn't save these changes right now. Please try again." } };
  }
  return { error: null };
}

// ----------------------------------------------------------------------------
// Reused by generated PDFs (receiptPdf.js and driverBookingReport.js) so
// their footers show the same centrally-managed contacts as the Help &
// Support pages, instead of a hardcoded email.
//
// receiptPdf.js and driverBookingReport.js are both deliberately pure/sync
// PDF builders — neither imports supabase or does any data fetching of its
// own (see their own header comments); they only draw whatever strings a
// caller hands them. So the fetch happens where the PDF is actually
// generated (e.g. BookingDetailsView.jsx's handleGenerateReceipt() and
// driver/Bookings.jsx's handleGenerateReport()), via this module's own
// fetchSupportContacts(), and the plain result is passed through to this
// formatter before being handed to the PDF builder.
//
// Availability per channel is decided exactly the same way
// SupportContactsCard.jsx decides it — by checking the same href a real
// button would use (toMailtoHref/toTelHref/toWhatsappHref/toSafeUrl) — so a
// channel that wouldn't render a button on the Support page never shows up
// in a receipt/report footer either. Labels match that card's labels
// ("Email", "Call", "WhatsApp", "Facebook", "Twitter / X") for consistency
// across the app.
export function formatSupportFooterLine(contacts) {
  const segments = [
    { label: 'Email', href: toMailtoHref(contacts?.support_email), value: displayValue(contacts?.support_email) },
    { label: 'Call', href: toTelHref(contacts?.support_phone), value: displayValue(contacts?.support_phone) },
    { label: 'WhatsApp', href: toWhatsappHref(contacts?.whatsapp_number), value: displayValue(contacts?.whatsapp_number) },
    { label: 'Facebook', href: toSafeUrl(contacts?.facebook_url), value: 'PamojaRide on Facebook' },
    { label: 'Twitter / X', href: toSafeUrl(contacts?.twitter_url), value: 'PamojaRide on Twitter / X' },
  ]
    .filter(seg => seg.href) // same availability rule as SupportContactsCard.jsx
    .map(seg => `${seg.label}: ${seg.value}`);

  if (segments.length === 0) {
    // Nothing set up yet (or the fetch failed and EMPTY_CONTACTS came
    // back) — never draw a broken "Need help? " line with nothing after
    // it; point to the in-app Support page instead, same fallback message
    // SupportContactsCard.jsx shows when no channel is configured.
    return 'PamojaRide · Need help with a booking? Visit the Support page in the app.';
  }
  return `PamojaRide · Need help with a booking? ${segments.join(' · ')}`;
}
