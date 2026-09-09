import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import KYCReviewer from '../../components/admin/KYCReviewer';

const FILTER_TABS = [
  { value: 'queue', label: 'Pending Review' },
  { value: 'verified', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'banned', label: 'Banned' },
  { value: 'all', label: 'All' },
];

const STATUS_BADGE = {
  pending: 'badge-gray',
  pending_verification: 'badge-teal',
  under_review: 'badge-teal',
  verified: 'badge-green',
  rejected: 'badge-danger',
};

export default function DriverReview() {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('queue');
  const [search, setSearch] = useState('');

  async function loadDrivers(activeFilter) {
    setLoading(true);
    setError('');
    // Driver-specific fields live on driver_profiles; identity fields
    // (name/email/phone/national_id/emergency contact) live on the
    // shared profiles row. Join them and flatten for KYCReviewer, which
    // expects a single flat object.
    let query = supabase
      .from('driver_profiles')
      .select('*, profiles:profile_id (full_name, email, phone, national_id, emergency_contact_name, emergency_contact_phone)')
      .order('kyc_submitted_at', { ascending: true, nullsFirst: false });

    if (activeFilter === 'queue') query = query.in('verification_status', ['pending_verification', 'under_review']);
    else if (activeFilter === 'verified') query = query.eq('verification_status', 'verified');
    else if (activeFilter === 'rejected') query = query.eq('verification_status', 'rejected');
    else if (activeFilter === 'banned') query = query.eq('account_status', 'banned');
    // 'all' → no extra filter

    const { data, error: fetchError } = await query;
    if (fetchError) {
      setError(fetchError.message);
    } else {
      setDrivers(
        (data || []).map(({ profiles: identity, profile_id, ...driverFields }) => ({
          id: profile_id,
          ...identity,
          ...driverFields,
        }))
      );
    }
    setLoading(false);
  }

  useEffect(() => { loadDrivers(filter); }, [filter]);

  async function notify(userId, type, title, body) {
    // Best-effort — a failed notification insert shouldn't block the
    // approval/rejection itself.
    const { error: notifyError } = await supabase.from('notifications').insert({
      user_id: userId, type, title, body,
    });
    if (notifyError) console.error('Notification insert failed:', notifyError);
  }

  async function logAudit(action, targetUserId, oldValue, newValue) {
    // Same pattern as UserManagement.jsx's ban/suspend/reactivate logging,
    // so KYC approve/reject shows up in the Audit Log viewer too.
    const adminId = (await supabase.auth.getUser()).data.user?.id;
    const { error: auditError } = await supabase.from('audit_logs').insert({
      admin_id: adminId,
      user_id: targetUserId,
      action,
      table_name: 'driver_profiles',
      record_id: targetUserId,
      old_value: oldValue,
      new_value: newValue,
    });
    if (auditError) console.error('Audit log insert failed:', auditError);
  }

  async function handleApprove(driverId) {
    setError('');
    const driver = drivers.find(d => d.id === driverId);
    // Goes through admin_review_driver_verification() -- see
    // database/admin_management_roles_and_visibility.sql -- which
    // independently re-checks the caller has the verification_admin (or
    // super_admin) role before touching driver_profiles at all, and
    // applies the exact same fields this used to set directly.
    const { error: rpcError } = await supabase.rpc('admin_review_driver_verification', {
      p_driver_id: driverId,
      p_decision: 'verified',
    });
    if (rpcError) { setError(rpcError.message); return; }

    await logAudit(
      'kyc_approved',
      driverId,
      { verification_status: driver?.verification_status },
      { verification_status: 'verified' }
    );
    await notify(driverId, 'kyc_approved', "You're verified! 🎉", "Your documents were approved — you can now post trips.");
    setDrivers(ds => ds.filter(d => d.id !== driverId));
  }

  async function handleReject(driverId, reason) {
    setError('');
    const driver = drivers.find(d => d.id === driverId);
    const { error: rpcError } = await supabase.rpc('admin_review_driver_verification', {
      p_driver_id: driverId,
      p_decision: 'rejected',
      p_reason: reason,
    });
    if (rpcError) { setError(rpcError.message); return; }

    await logAudit(
      'kyc_rejected',
      driverId,
      { verification_status: driver?.verification_status },
      { verification_status: 'rejected', kyc_rejection_reason: reason }
    );
    await notify(driverId, 'kyc_rejected', 'Verification needs another look', reason);
    setDrivers(ds => ds.filter(d => d.id !== driverId));
  }

  const filtered = drivers.filter(d => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      d.full_name?.toLowerCase().includes(q) ||
      d.email?.toLowerCase().includes(q) ||
      d.phone?.includes(q) ||
      d.vehicle_plate?.toLowerCase().includes(q)
    );
  });

  const isReviewQueue = filter === 'queue';

  return (
    <DashboardLayout title="Driver Review">
      <div className="page-header">
        <h1>Driver Verification</h1>
        <p>{filtered.length} driver{filtered.length === 1 ? '' : 's'} {isReviewQueue ? 'awaiting review' : 'matching this filter'}.</p>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="flex-between" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FILTER_TABS.map(t => (
            <button
              key={t.value}
              className={`btn btn-sm ${filter === t.value ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setFilter(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          className="form-input"
          placeholder="Search name, email, phone, or plate…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
        />
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">{isReviewQueue ? '🎉' : '🔍'}</div>
          <h3>{isReviewQueue ? 'Nothing pending' : 'No drivers found'}</h3>
          <p>{isReviewQueue ? "You're all caught up — new submissions will show up here." : 'Try a different filter or search term.'}</p>
        </div>
      ) : isReviewQueue ? (
        filtered.map(d => (
          <KYCReviewer key={d.id} driver={d} onApprove={handleApprove} onReject={handleReject} />
        ))
      ) : (
        // Read-only list for non-actionable filters (approved/rejected/banned/all) —
        // approve/reject only makes sense from the pending queue; ban/unban already
        // lives in User Management to avoid a second, duplicate action surface.
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['Driver', 'Contact', 'Vehicle', 'Verification', 'Account'].map(h => (
                  <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '14px 20px', fontSize: 13.5, fontWeight: 600 }}>{d.full_name}</td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)' }}>{d.email}<br />{d.phone}</td>
                  <td style={{ padding: '14px 20px', fontSize: 12.5 }}>{[d.vehicle_make, d.vehicle_model].filter(Boolean).join(' ') || '—'}{d.vehicle_plate && <div style={{ color: 'var(--text-muted)' }}>{d.vehicle_plate}</div>}</td>
                  <td style={{ padding: '14px 20px' }}><span className={`badge ${STATUS_BADGE[d.verification_status] || 'badge-gray'}`}>{d.verification_status}</span></td>
                  <td style={{ padding: '14px 20px' }}>
                    <span className={`badge ${d.account_status === 'banned' ? 'badge-danger' : d.account_status === 'suspended' ? 'badge-amber' : 'badge-green'}`}>{d.account_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardLayout>
  );
}
