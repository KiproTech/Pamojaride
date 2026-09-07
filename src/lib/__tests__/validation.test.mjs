// ============================================================================
// Plain-Node test suite for src/lib/validation.js — no test framework
// required (this project's package.json/test runner isn't part of this
// export), so this uses only Node's built-in `assert` and runs with:
//
//   node src/lib/__tests__/validation.test.mjs
//
// (Requires Node to resolve validation.js as ESM — true automatically if
// the project's package.json has "type": "module", which is standard for a
// Vite project. If you use a different test runner (vitest/jest), these
// same cases can be dropped straight into `it(...)` blocks — each `test()`
// call below is already one isolated case with a descriptive name.)
// ============================================================================

import assert from 'node:assert/strict';
import {
  validateFullName,
  validateEmail,
  validatePhone,
  validatePassword,
  validatePasswordConfirmation,
  validateRegistrationForm,
} from '../validation.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('validateFullName');
test('accepts a valid two-name registration ("John Kamau")', () => {
  const result = validateFullName('John Kamau');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'John Kamau');
});

test('rejects a one-name registration ("John")', () => {
  const result = validateFullName('John');
  assert.equal(result.valid, false);
  assert.match(result.error, /first and last name/i);
});

test('rejects an empty name', () => {
  const result = validateFullName('');
  assert.equal(result.valid, false);
  assert.match(result.error, /required/i);
});

test('rejects a whitespace-only name', () => {
  const result = validateFullName('   ');
  assert.equal(result.valid, false);
  assert.match(result.error, /required/i);
});

test('trims and collapses unnecessary whitespace', () => {
  const result = validateFullName('   John    Kamau  ');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'John Kamau');
});

test('accepts three-plus-part names', () => {
  assert.equal(validateFullName('Mary Jane Wanjiru').valid, true);
});

test('accepts legitimate names with hyphens and apostrophes', () => {
  assert.equal(validateFullName("Jean-Paul O'Brien").valid, true);
  assert.equal(validateFullName('Otieno-Kamau Wafula').valid, true);
});

test('accepts non-Latin-script names (not English-only)', () => {
  assert.equal(validateFullName('José García').valid, true);
  assert.equal(validateFullName('Ngũgĩ wa Thiong’o').valid, true);
});

test('rejects a name part that is only digits/symbols', () => {
  const result = validateFullName('John 123');
  assert.equal(result.valid, false);
  assert.match(result.error, /doesn't look like a valid name/i);
});

console.log('\nvalidateEmail');
test('rejects an invalid email', () => {
  const result = validateEmail('not-an-email');
  assert.equal(result.valid, false);
  assert.match(result.error, /valid email/i);
});

test('rejects an email missing a domain dot', () => {
  assert.equal(validateEmail('john@gmail').valid, false);
});

test('rejects an email with spaces', () => {
  assert.equal(validateEmail('john doe@example.com').valid, false);
});

test('accepts a valid email', () => {
  const result = validateEmail('jane@example.com');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'jane@example.com');
});

test('normalizes email casing', () => {
  const result = validateEmail('Jane@Example.COM');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'jane@example.com');
});

console.log('\nvalidatePhone');
test('accepts a local 07XX number', () => {
  const result = validatePhone('0712345678');
  assert.equal(result.valid, true);
  assert.equal(result.value, '0712345678');
});

test('accepts a local 01XX number', () => {
  assert.equal(validatePhone('0112345678').valid, true);
});

test('accepts +254 international format', () => {
  const result = validatePhone('+254712345678');
  assert.equal(result.valid, true);
  assert.equal(result.value, '+254712345678');
});

test('accepts bare 254 international format', () => {
  assert.equal(validatePhone('254712345678').valid, true);
});

test('accepts spaces/hyphens and strips them for the stored value', () => {
  const result = validatePhone('0712 345 678');
  assert.equal(result.valid, true);
  assert.equal(result.value, '0712345678');
});

test('rejects an empty phone number', () => {
  const result = validatePhone('');
  assert.equal(result.valid, false);
  assert.match(result.error, /required/i);
});

test('rejects a too-short number', () => {
  assert.equal(validatePhone('0712345').valid, false);
});

test('rejects a number with letters', () => {
  assert.equal(validatePhone('07123abc78').valid, false);
});

test('rejects a non-Kenyan-looking number', () => {
  assert.equal(validatePhone('12345').valid, false);
});

console.log('\nvalidatePassword / validatePasswordConfirmation');
test('rejects an empty password', () => {
  assert.equal(validatePassword('').valid, false);
});

test('rejects a password shorter than the existing 6-character minimum', () => {
  assert.equal(validatePassword('abc12').valid, false);
});

test('accepts a password meeting the existing minimum', () => {
  assert.equal(validatePassword('abc123').valid, true);
});

test('rejects mismatched password confirmation', () => {
  const result = validatePasswordConfirmation('Passw0rd!', 'Passw0rd?');
  assert.equal(result.valid, false);
  assert.match(result.error, /do not match/i);
});

test('accepts matching password confirmation', () => {
  assert.equal(validatePasswordConfirmation('Passw0rd!', 'Passw0rd!').valid, true);
});

console.log('\nvalidateRegistrationForm (full form, as used by the register pages)');
test('successful registration: a fully valid form passes with no errors', () => {
  const result = validateRegistrationForm({
    name: '  John   Kamau ',
    email: 'John@Example.com',
    phone: '0712345678',
    password: 'Passw0rd!',
    confirm: 'Passw0rd!',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
  assert.equal(result.values.name, 'John Kamau');
  assert.equal(result.values.email, 'john@example.com');
});

test('one-name registration fails the whole form with a clear message', () => {
  const result = validateRegistrationForm({
    name: 'John',
    email: 'john@example.com',
    phone: '0712345678',
    password: 'Passw0rd!',
    confirm: 'Passw0rd!',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.name);
  assert.equal(result.firstError, result.errors.name);
});

test('empty name fails the whole form', () => {
  const result = validateRegistrationForm({
    name: '',
    email: 'john@example.com',
    phone: '0712345678',
    password: 'Passw0rd!',
    confirm: 'Passw0rd!',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.name);
});

test('invalid email fails the whole form', () => {
  const result = validateRegistrationForm({
    name: 'John Kamau',
    email: 'not-an-email',
    phone: '0712345678',
    password: 'Passw0rd!',
    confirm: 'Passw0rd!',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.email);
});

test('password mismatch fails the whole form', () => {
  const result = validateRegistrationForm({
    name: 'John Kamau',
    email: 'john@example.com',
    phone: '0712345678',
    password: 'Passw0rd!',
    confirm: 'Different1',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.confirm);
});

test('missing required field (phone) fails the whole form', () => {
  const result = validateRegistrationForm({
    name: 'John Kamau',
    email: 'john@example.com',
    phone: '',
    password: 'Passw0rd!',
    confirm: 'Passw0rd!',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.phone);
});

test('malformed phone (not empty, just invalid) fails the whole form', () => {
  const result = validateRegistrationForm({
    name: 'John Kamau',
    email: 'john@example.com',
    phone: '12345',
    password: 'Passw0rd!',
    confirm: 'Passw0rd!',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.phone);
});

// NOTE on "existing email" (duplicate registration): that check is
// inherently a live-database concern (Supabase Auth is the source of truth
// for which emails are already registered), not something this pure,
// offline validation module can or should decide — see
// PassengerRegister.jsx / DriverRegister.jsx, which still handle Supabase's
// "already registered" response exactly as before (unchanged by this
// change) by attempting to attach a new role profile to the existing
// identity. That flow is integration-level, not unit-testable here without
// a live Supabase project, and this task didn't add or change that logic.

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
