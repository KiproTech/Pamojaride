// ============================================================================
// Registration form validation — shared by PassengerRegister.jsx and
// DriverRegister.jsx (and reusable anywhere else a name/email/password needs
// validating, e.g. a future "edit profile" or "change password" screen).
//
// Pure functions, no React/Supabase imports, so they're trivially unit
// testable on their own (see src/lib/__tests__/validation.test.mjs) and can
// run identically on the client. This is UX/fast-fail only — Supabase Auth
// remains the actual source of truth for email uniqueness and password
// acceptance; nothing here talks to the network or stores a password
// anywhere. See profiles_full_name_two_parts note in
// src/database/registration_validation.sql for why full-name shape is NOT
// additionally enforced at the database layer.
// ============================================================================

// Collapse any run of whitespace (including tabs/newlines from a pasted
// name) to a single space, and trim the ends. "  John   Kamau " -> "John Kamau".
export function normalizeWhitespace(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

// A name "part" must start with a letter (any script — Unicode-aware, so
// this isn't restricted to ASCII/English names) and may otherwise contain
// letters, apostrophes ('/'), hyphens, or periods (covers "O'Brien",
// "Jean-Paul", "Otieno-Kamau", "J." for a middle initial, etc.). Digits and
// other punctuation are rejected.
const NAME_PART_PATTERN = /^[\p{L}][\p{L}'’.-]*$/u;

// Requires at least two name parts (e.g. "John Kamau") and rejects a single
// name (e.g. "John"), per the product requirement. Deliberately NOT
// restrictive about which scripts/characters are allowed within a part, how
// long a name is, or how many parts it has beyond the two-part minimum —
// "Mary Jane van der Berg" and "José María Fernández López" are both valid.
export function validateFullName(rawName) {
  const value = normalizeWhitespace(rawName);

  if (!value) {
    return { valid: false, error: 'Full name is required.', value };
  }

  const parts = value.split(' ').filter(Boolean);

  if (parts.length < 2) {
    return {
      valid: false,
      error: 'Enter your full name with at least a first and last name (e.g. "John Kamau").',
      value,
    };
  }

  const invalidPart = parts.find(part => !NAME_PART_PATTERN.test(part));
  if (invalidPart) {
    return {
      valid: false,
      error: `"${invalidPart}" doesn't look like a valid name. Use letters only (hyphens and apostrophes are fine).`,
      value,
    };
  }

  return { valid: true, error: null, value: parts.join(' ') };
}

// Standard, deliberately-not-overly-strict email shape check: something,
// then @, then something, then a dot, then something — with no whitespace.
// This intentionally does not attempt to fully validate against RFC 5322;
// Supabase Auth is still the final authority on whether an email is
// accepted, this is only meant to catch obvious typos before a network
// round-trip ("john@gmail" / "john gmail.com" / "john@@gmail.com").
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(rawEmail) {
  const value = (rawEmail || '').trim();

  if (!value) {
    return { valid: false, error: 'Email address is required.', value };
  }
  if (!EMAIL_PATTERN.test(value)) {
    return { valid: false, error: 'Enter a valid email address (e.g. name@example.com).', value };
  }

  // Lowercased so "Jane@Example.com" and "jane@example.com" are treated as
  // the same account rather than two — matches how Supabase Auth itself
  // normalizes email lookups, and avoids a confusing "already registered"
  // vs "no account found" mismatch caused only by casing.
  return { valid: true, error: null, value: value.toLowerCase() };
}

// PamojaRide relies on Supabase Auth as the password store and authority —
// this file never stores or compares against a stored password. The only
// thing validated here is the EXISTING requirement already enforced by the
// Supabase project's Auth settings (minimum 6 characters), surfaced early
// and clearly instead of waiting on a round-trip to the API to find out.
const MIN_PASSWORD_LENGTH = 6;

export function validatePassword(rawPassword) {
  const value = rawPassword || '';

  if (!value) {
    return { valid: false, error: 'Password is required.' };
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` };
  }

  return { valid: true, error: null };
}

// Kenyan mobile format (this project targets Kenya — M-Pesa, "07XX XXX
// XXX" placeholders throughout the register forms), accepted in any of the
// forms a user is likely to type or paste: local "07.../01..." (10
// digits), "+2547.../+2541..." or bare "2547.../2541...". Spaces, hyphens,
// and parentheses are stripped before checking, so "0712 345 678" and
// "0712-345-678" are both fine. Deliberately lenient about the trailing
// digits (doesn't try to validate against real network prefixes) — this is
// a shape check to catch typos, not a carrier lookup.
const PHONE_PATTERN = /^(?:\+?254|0)(?:1|7)\d{8}$/;

export function validatePhone(rawPhone) {
  const trimmed = normalizeWhitespace(rawPhone);

  if (!trimmed) {
    return { valid: false, error: 'Phone number is required.', value: trimmed };
  }

  const compact = trimmed.replace(/[\s\-()]/g, '');
  if (!PHONE_PATTERN.test(compact)) {
    return {
      valid: false,
      error: 'Enter a valid phone number (e.g. 07XX XXX XXX or +2547XX XXX XXX).',
      value: trimmed,
    };
  }

  return { valid: true, error: null, value: compact };
}

export function validatePasswordConfirmation(password, confirm) {
  if (!confirm) {
    return { valid: false, error: 'Please confirm your password.' };
  }
  if (password !== confirm) {
    return { valid: false, error: 'Passwords do not match.' };
  }
  return { valid: true, error: null };
}

// Runs every check for a registration form in one call and returns a single
// {valid, errors, firstError, values} result. `errors` is keyed by field
// name so a form can show per-field messages; `firstError` is a convenience
// for forms (like this project's) that only show one error banner at a time.
// `values` returns the trimmed/normalized versions of each field so the
// caller can send clean data to Supabase without re-deriving it.
export function validateRegistrationForm({ name, email, phone, password, confirm }) {
  const errors = {};

  const nameResult = validateFullName(name);
  if (!nameResult.valid) errors.name = nameResult.error;

  const emailResult = validateEmail(email);
  if (!emailResult.valid) errors.email = emailResult.error;

  const phoneResult = validatePhone(phone);
  if (!phoneResult.valid) errors.phone = phoneResult.error;

  const passwordResult = validatePassword(password);
  if (!passwordResult.valid) errors.password = passwordResult.error;

  const confirmResult = validatePasswordConfirmation(password, confirm);
  if (!confirmResult.valid) errors.confirm = confirmResult.error;

  const valid = Object.keys(errors).length === 0;
  const fieldOrder = ['name', 'email', 'phone', 'password', 'confirm'];
  const firstError = valid ? null : errors[fieldOrder.find(f => errors[f])];

  return {
    valid,
    errors,
    firstError,
    values: {
      name: nameResult.value,
      email: emailResult.value,
      phone: phoneResult.value,
      password,
      confirm,
    },
  };
}
