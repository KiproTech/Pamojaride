import { useState } from 'react';

// ============================================================================
// Shared show/hide password input, used by the new Forgot/Reset password
// pages and the profile "Change Password" cards. Visually and behaviourally
// identical to the (previously copy-pasted) PasswordInput found inline in
// PassengerLogin.jsx / DriverLogin.jsx / PassengerRegister.jsx / etc — kept
// as a single component here so new password-management UI doesn't add yet
// another copy. Existing pages are left untouched (still have their own
// inline copies) to avoid touching working, unrelated code.
// ============================================================================
export default function PasswordInput({ value, onChange, inputStyle, className, placeholder = '••••••••', autoComplete, id, name }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        name={name}
        className={className}
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        style={{ ...inputStyle, paddingRight: 44 }}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        style={eyeBtn}
        aria-label={visible ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        )}
      </button>
    </div>
  );
}

const eyeBtn = {
  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
  background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8',
  display: 'flex', alignItems: 'center', padding: 0, lineHeight: 1,
};
