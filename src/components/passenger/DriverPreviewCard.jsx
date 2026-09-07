// Same trust-level color scale used on driver/Dashboard.jsx's TrustBadge,
// kept as a local copy since that file is page-specific and not meant to be
// imported from elsewhere.
const TRUST_COLORS = {
  1: { color: '#64748B', bg: 'var(--bg-alt)' },
  2: { color: '#0E7490', bg: 'var(--primary-xlight)' },
  3: { color: '#16A34A', bg: 'var(--green-light)' },
  4: { color: '#F59E0B', bg: 'var(--amber-light)' },
  5: { color: '#F97316', bg: 'var(--accent-light)' },
};

// Verification wording intentionally matches DriverDetailsCard.jsx (the
// post-booking card) so a passenger sees consistent language throughout —
// "pending" here covers both 'under_review' and 'unverified' since neither
// distinction is a passenger's concern.
function verificationMeta(status) {
  if (status === 'verified') return { label: '✓ Verified driver', badge: 'badge-green' };
  return { label: 'Verification pending', badge: 'badge-gray' };
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

/**
 * Shows the driver/trust info a passenger should see BEFORE booking a trip:
 * name, photo, phone, rating + review count, trust level, verification
 * status, and the vehicle assigned to this specific trip.
 *
 * `preview` is one row from fetchTripDriverPreviews, or null/undefined.
 * `loading` shows a lightweight placeholder while the first fetch is in
 * flight. If loading is false and preview is missing, a quiet fallback is
 * shown instead of blocking the trip card (e.g. RPC hiccup) — the trip
 * itself is still bookable either way.
 */
export default function DriverPreviewCard({ preview, loading, compact }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--text-muted)' }}>
        <span className="spinner" style={{ width: 14, height: 14 }} /> Loading driver info…
      </div>
    );
  }

  if (!preview) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
        Driver details aren't available right now.
      </div>
    );
  }

  const level = preview.trust_level || 1;
  const trustColors = TRUST_COLORS[level] || TRUST_COLORS[1];
  const vMeta = verificationMeta(preview.verification_status);
  const vehicleLine = [preview.vehicle_make, preview.vehicle_model].filter(Boolean).join(' ');
  const hasRating = preview.rating_count > 0;

  return (
    <div
      className="card"
      style={{ padding: compact ? 10 : 12, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {preview.profile_picture ? (
          <img
            src={preview.profile_picture}
            alt={preview.full_name || 'Driver'}
            style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
          />
        ) : (
          <span className="topbar-avatar" style={{ width: 40, height: 40, fontSize: 14, flexShrink: 0 }}>
            {initials(preview.full_name)}
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ fontSize: 14, display: 'block' }}>{preview.full_name || 'Driver'}</strong>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {hasRating
              ? <>⭐ {preview.avg_rating} · {preview.rating_count} rating{preview.rating_count === 1 ? '' : 's'}</>
              : 'New driver · No ratings yet'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <span className={`badge ${vMeta.badge}`}>{vMeta.label}</span>
        <span className="badge" style={{ background: trustColors.bg, color: trustColors.color, border: `1px solid ${trustColors.color}33` }}>
          🛡️ Trust Level {level}
        </span>
      </div>

      {preview.phone && (
        <div style={{ fontSize: 12.5, marginBottom: vehicleLine || preview.vehicle_plate ? 6 : 0 }}>
          📞 <a href={`tel:${preview.phone}`}>{preview.phone}</a>
        </div>
      )}

      {(vehicleLine || preview.vehicle_plate) && (
        <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
          🚙 {vehicleLine}{vehicleLine && preview.vehicle_plate ? ' · ' : ''}
          {preview.vehicle_plate && <span style={{ color: 'var(--text-muted)' }}>{preview.vehicle_plate}</span>}
        </div>
      )}
    </div>
  );
}
