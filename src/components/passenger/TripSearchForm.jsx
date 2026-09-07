import { useState } from 'react';

export default function TripSearchForm({ initial, onSearch, loading }) {
  const [form, setForm] = useState({
    origin: initial?.origin || '',
    destination: initial?.destination || '',
    date: initial?.date || '',
    maxPrice: initial?.maxPrice || '',
    minSeats: initial?.minSeats || 1,
  });

  function set(field) { return e => setForm(f => ({ ...f, [field]: e.target.value })); }

  function handleSubmit(e) {
    e.preventDefault();
    onSearch(form);
  }

  return (
    <form onSubmit={handleSubmit} className="card card-pad">
      <div className="grid-4" style={{ gap: 12, alignItems: 'end' }}>
        <div className="form-group">
          <label className="form-label">From</label>
          <input className="form-input" value={form.origin} onChange={set('origin')} placeholder="e.g. Nairobi" />
        </div>
        <div className="form-group">
          <label className="form-label">To</label>
          <input className="form-input" value={form.destination} onChange={set('destination')} placeholder="e.g. Kisumu" />
        </div>
        <div className="form-group">
          <label className="form-label">Date</label>
          <input className="form-input" type="date" value={form.date} onChange={set('date')} />
        </div>
        <button className="btn btn-primary" disabled={loading}>
          {loading ? <span className="spinner" /> : '🔍 Search'}
        </button>
      </div>

      <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
        <div className="form-group">
          <label className="form-label">Max price per seat (KES)</label>
          <input className="form-input" type="number" min="0" value={form.maxPrice} onChange={set('maxPrice')} placeholder="Any" />
        </div>
        <div className="form-group">
          <label className="form-label">Minimum seats needed</label>
          <select className="form-select" value={form.minSeats} onChange={set('minSeats')}>
            {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} seat{n > 1 ? 's' : ''}</option>)}
          </select>
        </div>
      </div>
    </form>
  );
}
