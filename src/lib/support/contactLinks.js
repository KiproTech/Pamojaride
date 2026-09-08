// Pure helpers that turn a raw admin-managed contact value (support_email,
// support_phone, whatsapp_number, facebook_url, twitter_url — see
// lib/support/supportContacts.js) into a safe, working action link.
//
// Deliberately pure/synchronous and has no knowledge of Supabase — it only
// formats strings that are already in hand, so it can be reused anywhere a
// contact value needs to become a clickable action (Help & Support pages
// now; receipts/reports/status pages in a later prompt) without duplicating
// this formatting logic each time.
//
// Every function returns null for a blank/whitespace-only input so callers
// can do `if (link) { ...render button... }` and never render a broken,
// empty-href button.

function cleanString(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

// Digits only, for building tel:/wa.me links. Converts a leading local "0"
// to Kenya's "254" country code (matching the 07XX/01XX format used
// throughout registration — see validatePhone in lib/validation.js) so the
// generated link works whether Admin typed a local or international number.
function toDigits(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  let digits = cleaned.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '254' + digits.slice(1);
  return digits.length > 0 ? digits : null;
}

// tel: link for the Support Phone Number field.
export function toTelHref(phone) {
  const digits = toDigits(phone);
  return digits ? `tel:+${digits}` : null;
}

// wa.me deep link for the WhatsApp Number field, with a friendly prefilled
// message so the chat doesn't open blank.
export function toWhatsappHref(whatsapp, presetMessage = 'Hi PamojaRide Support, I need some help.') {
  const digits = toDigits(whatsapp);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(presetMessage)}`;
}

// mailto: link for the Support Email field.
export function toMailtoHref(email) {
  const cleaned = cleanString(email);
  return cleaned ? `mailto:${cleaned}` : null;
}

// Safe https(s) URL for the Facebook/Twitter fields. Admin may type a bare
// domain like "facebook.com/pamojaride" — this adds a scheme rather than
// treating it as broken. Anything that still isn't a plausible URL after
// that (e.g. stray text) is treated as unset so no broken link is rendered.
export function toSafeUrl(url) {
  const cleaned = cleanString(url);
  if (!cleaned) return null;
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.hostname.includes('.') ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// Display-friendly version of the phone/WhatsApp digits (kept as typed by
// Admin, just trimmed) — used as the visible label so users see a familiar
// format rather than the raw digit string used internally for the link.
export function displayValue(value) {
  return cleanString(value);
}
