// Dropdown → "Other" → manual text pattern, reused for vehicle make,
// model, colour, and vehicle type. Native <select> rather than a custom
// combobox: works reliably on mobile without extra JS/CSS, and typing
// jumps to a matching option on both desktop and mobile OSes, which
// covers the "searchable" requirement without a new dependency.
export default function SelectOrOther({
  label,
  required,
  options,             // array of strings, WITHOUT 'Other' — added automatically
  value,               // currently selected option, or 'Other'
  otherValue,          // manual text, only used/shown when value === 'Other'
  onChange,            // (selectedOption) => void
  onOtherChange,       // (text) => void
  error,
  otherError,
  otherPlaceholder = 'Type it in',
  disabled,
}) {
  const isOther = value === 'Other';
  return (
    <div>
      <div className="form-group">
        <label className="form-label">{label} {required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
        <select
          className="form-select"
          value={value || ''}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
        >
          <option value="">Select {label.toLowerCase()}</option>
          {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          <option value="Other">Other</option>
        </select>
        {error && <span className="form-error">{error}</span>}
      </div>

      {isOther && (
        <div className="form-group" style={{ marginTop: 10 }}>
          <label className="form-label">Enter {label.toLowerCase()} <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input
            className="form-input"
            value={otherValue || ''}
            onChange={e => onOtherChange(e.target.value)}
            placeholder={otherPlaceholder}
          />
          {otherError && <span className="form-error">{otherError}</span>}
        </div>
      )}
    </div>
  );
}
