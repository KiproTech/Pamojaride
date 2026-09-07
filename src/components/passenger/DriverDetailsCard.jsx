// Verification badge wording is deliberately softer than the driver-facing
// one in driver/Dashboard.jsx ("Action needed" etc. is guidance FOR the
// driver, not something a passenger needs to see about someone else).
const VERIFICATION_META = {
  verified: { label: '✓ Verified driver', badge: 'badge-green' },
};
function verificationMeta(status) {
  return VERIFICATION_META[status] || { label: 'Verification pending', badge: 'badge-gray' };
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

/**
 * Shows the driver's name, photo (if any), phone, vehicle, and
 * verification status for one confirmed/completed booking. Fetching and
 * gating both happen server-side (get_booked_trip_driver_details) — this
 * component only renders whatever it's given.
 *
 * `driver` is one row from fetchBookedTripDriverDetails, or null.
 * `loading` shows a lightweight placeholder while the first fetch is in
 * flight. If loading is false and driver is null, an error/empty state is
 * shown instead (e.g. RPC failed, or — defensively — the caller somehow
 * isn't authorized for this trip).
 */
export default function DriverDetailsCard({ driver, loading }) {
  if (loading) {
    return (
      <div className="alert alert-info" style={{ padding: '10px 12px', fontSize: 12.5 }}>
        Loading driver details…
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="alert alert-amber" style={{ padding: '10px 12px', fontSize: 12.5 }}>
        Driver details aren't available right now. Please refresh, or contact support if this continues.
      </div>
    );
  }

  const vMeta = verificationMeta(driver.verification_status);
  const vehicleLine = [driver.vehicle_make, driver.vehicle_model].filter(Boolean).join(' ');

  return (
    <div
      className="card"
      style={{ padding: 12, background: 'var(--bg-alt)', border: '1px solid var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {driver.profile_picture ? (
          <img
            src={driver.profile_picture}
            alt={driver.full_name || 'Driver'}
            style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
          />
        ) : (
          <span className="topbar-avatar" style={{ width: 44, height: 44, fontSize: 15, flexShrink: 0 }}>
            {initials(driver.full_name)}
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ fontSize: 14.5, display: 'block' }}>{driver.full_name || 'Driver'}</strong>
          <span className={`badge ${vMeta.badge}`} style={{ marginTop: 4, display: 'inline-block' }}>{vMeta.label}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        {driver.phone && (
          <div>
            📞 <a href={`tel:${driver.phone}`}>{driver.phone}</a>
          </div>
        )}
        {vehicleLine && (
          <div style={{ color: 'var(--text)' }}>🚗 {vehicleLine}</div>
        )}
        {driver.vehicle_plate && (
          <div style={{ color: 'var(--text-muted)' }}>Plate: {driver.vehicle_plate}</div>
        )}
        {driver.vehicle_color && (
          <div style={{ color: 'var(--text-muted)' }}>Colour: {driver.vehicle_color}</div>
        )}
        {typeof driver.trips_completed === 'number' && (
          <div style={{ color: 'var(--text-muted)' }}>{driver.trips_completed} trip{driver.trips_completed === 1 ? '' : 's'} completed</div>
        )}
      </div>
    </div>
  );
}
