import { useEffect, useRef, useState } from 'react';
import { searchLocations, LocationServiceError } from '../../lib/location';

// A text input that only lets the trip form accept a *recognized* place —
// the driver types, sees real matching locations from the location search
// service (major cities down to small towns, trading centres, villages
// and estates/neighbourhoods), and must click one (or arrow-key + Enter)
// before the field counts as valid. Typing after a pick clears the
// selection again, so a trip can never be created from raw unvalidated
// text.
export default function LocationAutocomplete({ label, placeholder, value, onChange, error }) {
  const [query, setQuery] = useState(value?.label || '');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [open, setOpen] = useState(false);
  const [searched, setSearched] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const abortRef = useRef(null);
  const debounceRef = useRef(null);
  const wrapRef = useRef(null);

  // Keep the input text in sync if the parent resets/prefills the value.
  useEffect(() => {
    setQuery(value?.label || '');
  }, [value?.id]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function runSearch(text) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (text.trim().length < 2) {
      setResults([]);
      setLoading(false);
      setSearchError('');
      setSearched(false);
      return;
    }

    setLoading(true);
    setSearchError('');
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const matches = await searchLocations(text, { signal: controller.signal });
        setResults(matches);
        setHighlighted(-1);
        setSearched(true);
      } catch (err) {
        if (err.name === 'AbortError') return;
        setResults([]);
        setSearched(true);
        setSearchError(err instanceof LocationServiceError ? err.message : 'Could not search locations right now.');
      } finally {
        setLoading(false);
      }
    }, 400);
  }

  function handleTextChange(e) {
    const text = e.target.value;
    setQuery(text);
    setOpen(true);
    setSearched(false);
    if (value) onChange(null); // any edit invalidates the previously picked location
    runSearch(text);
  }

  function pick(place) {
    onChange(place);
    setQuery(place.label);
    setResults([]);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleKeyDown(e) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(i => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(i => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (highlighted >= 0 && highlighted < results.length) {
        e.preventDefault();
        pick(results[highlighted]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="form-group" ref={wrapRef} style={{ position: 'relative' }}>
      <label className="form-label">{label}</label>
      <input
        className="form-input"
        value={query}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0 || searchError) setOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
        inputMode="search"
      />
      {value && (
        <p style={{ fontSize: 11.5, color: 'var(--green)', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
          ✓ {value.fullLabel}
        </p>
      )}
      {error && !value && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}

      {open && (loading || searchError || (searched && results.length === 0) || results.length > 0) && (
        <div
          className="card"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
            zIndex: 60, maxHeight: 280, overflowY: 'auto', padding: 4,
          }}
        >
          {loading && (
            <div style={{ padding: 10, fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="spinner" /> Searching locations…
            </div>
          )}
          {!loading && searchError && (
            <div style={{ padding: 10, fontSize: 13, color: 'var(--danger)' }}>{searchError}</div>
          )}
          {!loading && !searchError && searched && results.length === 0 && (
            <div style={{ padding: 10, fontSize: 13, color: 'var(--text-muted)' }}>
              No matching location found in Kenya. Try a shorter or differently spelled name — small
              towns, trading centres and villages are all supported, e.g. "Malava" or "Khwisero".
            </div>
          )}
          {!loading && results.map((r, i) => (
            <button
              type="button"
              key={r.id}
              onClick={() => pick(r)}
              onMouseEnter={() => setHighlighted(i)}
              style={{
                display: 'flex', flexDirection: 'column', gap: 1, width: '100%', textAlign: 'left',
                background: i === highlighted ? 'var(--bg-alt)' : 'none',
                border: 'none', padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer', color: 'var(--text)',
              }}
              onMouseDown={(e) => e.preventDefault()} // keep focus so onFocus re-open doesn't race the click
            >
              <span style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                📍 {r.label}
                {r.typeLabel && (
                  <span style={{
                    fontSize: 10.5, color: 'var(--text-muted)', border: '1px solid var(--border)',
                    borderRadius: 999, padding: '1px 6px', fontWeight: 500,
                  }}>
                    {r.typeLabel}
                  </span>
                )}
              </span>
              {r.contextLabel && (
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingLeft: 20 }}>
                  {r.contextLabel}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
