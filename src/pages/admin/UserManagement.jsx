import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import DashboardLayout from '../../components/shared/DashboardLayout';
import DriverDetailsModal from '../../components/admin/DriverDetailsModal';

const ROLE_TABS = [
  { value: 'all', label: 'All' },
  { value: 'driver', label: 'Drivers' },
  { value: 'passenger', label: 'Passengers' },
];

const STATUS_BADGE = {
  active:    { label: 'Active',    cls: 'badge-green' },
  suspended: { label: 'Suspended', cls: 'badge-amber' },
  banned:    { label: 'Banned',    cls: 'badge-danger' },
};

// Approval status is driven off driver_profiles.verification_status.
// Passengers never require admin approval, so their rows always show
// "Not Required" regardless of anything on the row -- there is no
// verification_status concept for a passenger account.
function approvalStatusFor(user) {
  if (user.role !== 'driver') {
    return { label: 'Not Required', cls: 'badge-gray', icon: '⚪', actionable: false };
  }
  const v = user.verification_status;
  if (v === 'verified') return { label: 'Approved', cls: 'badge-green', icon: '🟢', actionable: false };
  if (v === 'rejected') return { label: 'Rejected', cls: 'badge-danger', icon: '🔴', actionable: true };
  // Covers 'pending', 'pending_verification', 'under_review', legacy
  // 'unverified'/'active', and anything unset -- all still "not yet
  // approved to drive" from an admin's point of view.
  return { label: 'Pending', cls: 'badge-amber', icon: '🟠', actionable: true };
}

// NOTE: one identity (one email) can now have BOTH a driver profile and a
// passenger profile, each with its own independent status. So this table
// lists role-accounts, not people — the same person can appear as two
// rows (one "Driver", one "Passenger") if they registered as both, and
// suspending one does not affect the other. Each row's key is
// `${role}-${profile_id}`.
export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [actionTarget, setActionTarget] = useState(null); // { user, action: 'suspend' | 'ban' | 'reactivate' }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailsDriverId, setDetailsDriverId] = useState(null); // profile_id of driver shown in DriverDetailsModal

  async function loadUsers() {
    setLoading(true);
    setError('');

    const identityCols = 'full_name, email, phone, created_at';
    const [driversRes, passengersRes] = await Promise.all([
      supabase
        .from('driver_profiles')
        .select(`profile_id, account_status, suspension_reason, verification_status, profiles:profile_id (${identityCols})`),
      supabase
        .from('passenger_profiles')
        .select(`profile_id, account_status, suspension_reason, verification_status, profiles:profile_id (${identityCols})`),
    ]);

    if (driversRes.error || passengersRes.error) {
      setError((driversRes.error || passengersRes.error).message);
      setLoading(false);
      return;
    }

    const flatten = (rows, role) =>
      (rows || []).map(({ profile_id, profiles: identity, ...roleFields }) => ({
        id: profile_id,          // shared identity id (not unique per row anymore)
        rowKey: `${role}-${profile_id}`,
        role,
        ...identity,
        ...roleFields,
      }));

    const combined = [
      ...flatten(driversRes.data, 'driver'),
      ...flatten(passengersRes.data, 'passenger'),
    ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    setUsers(combined);
    setLoading(false);
  }

  useEffect(() => { loadUsers(); }, []);

  async function logAudit(action, targetUserId, tableName, oldValue, newValue) {
    const adminId = (await supabase.auth.getUser()).data.user?.id;
    const { error: auditError } = await supabase.from('audit_logs').insert({
      admin_id: adminId,
      user_id: targetUserId,
      action,
      table_name: tableName,
      record_id: targetUserId,
      old_value: oldValue,
      new_value: newValue,
    });
    if (auditError) console.error('Audit log insert failed:', auditError);
  }

  async function notify(userId, type, title, body) {
    const { error: notifyError } = await supabase.from('notifications').insert({ user_id: userId, type, title, body });
    if (notifyError) console.error('Notification insert failed:', notifyError);
  }

  function openAction(user, action) {
    setActionTarget({ user, action });
    setReason('');
  }

  async function confirmAction() {
    if (!actionTarget) return;
    const { user, action } = actionTarget;
    if (action !== 'reactivate' && !reason.trim()) return;

    setBusy(true);
    setError('');
    const newStatus = action === 'reactivate' ? 'active' : action === 'suspend' ? 'suspended' : 'banned';
    const table = user.role === 'driver' ? 'driver_profiles' : 'passenger_profiles';

    const { error: updateError } = await supabase
      .from(table)
      .update({
        account_status: newStatus,
        suspension_reason: newStatus === 'active' ? null : reason.trim(),
      })
      .eq('profile_id', user.id);

    if (updateError) { setError(updateError.message); setBusy(false); return; }

    await logAudit(
      `account_${newStatus}`,
      user.id,
      table,
      { account_status: user.account_status },
      { account_status: newStatus, suspension_reason: newStatus === 'active' ? null : reason.trim() }
    );

    if (newStatus === 'suspended') {
      await notify(user.id, 'account_suspended', `Your ${user.role} account has been suspended`, reason.trim());
    } else if (newStatus === 'active') {
      await notify(user.id, 'account_reactivated', `Your ${user.role} account has been reactivated`, 'You now have full access to this account again.');
    } else {
      await notify(user.id, 'account_banned', `Your ${user.role} account has been banned`, reason.trim());
    }

    setUsers(prev => prev.map(u =>
      u.rowKey === user.rowKey
        ? { ...u, account_status: newStatus, suspension_reason: newStatus === 'active' ? null : reason.trim() }
        : u
    ));
    setBusy(false);
    setActionTarget(null);
    setReason('');
  }

  const filtered = users.filter(u => {
    if (roleFilter !== 'all' && u.role !== roleFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return u.full_name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.phone?.includes(q);
    }
    return true;
  });

  return (
    <DashboardLayout title="User Management">
      <div className="page-header">
        <h1>User Management</h1>
        <p>Suspend or ban drivers and passengers, or restore access. Suspending someone's driver account does not affect their passenger account (or vice versa).</p>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}

      <div className="flex-between" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {ROLE_TABS.map(t => (
            <button
              key={t.value}
              className={`btn btn-sm ${roleFilter === t.value ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setRoleFilter(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          className="form-input"
          placeholder="Search name, email, or phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
        />
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24 }}>
            <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">👥</div>
            <h3>No users found</h3>
            <p>Try a different filter or search term.</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['Name', 'Contact', 'Role', 'Approval Status', 'Account Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => {
                const status = STATUS_BADGE[u.account_status] || STATUS_BADGE.active;
                const approval = approvalStatusFor(u);
                return (
                  <tr key={u.rowKey} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '14px 20px', fontSize: 13.5, fontWeight: 600 }}>{u.full_name}</td>
                    <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)' }}>{u.email}<br />{u.phone}</td>
                    <td style={{ padding: '14px 20px', fontSize: 12.5, textTransform: 'capitalize' }}>{u.role}</td>
                    <td style={{ padding: '14px 20px' }}>
                      <span className={`badge ${approval.cls}`}>{approval.icon} {approval.label}</span>
                      {u.role === 'driver' && approval.actionable && (
                        <div style={{ marginTop: 6 }}>
                          <Link to="/admin/drivers/review" className="btn btn-sm btn-outline" style={{ fontSize: 11.5, padding: '4px 10px' }}>
                            Review →
                          </Link>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <span className={`badge ${status.cls}`}>{status.label}</span>
                      {u.suspension_reason && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, maxWidth: 220 }}>{u.suspension_reason}</div>
                      )}
                    </td>
                    <td style={{ padding: '14px 20px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {u.role === 'driver' && (
                        <button className="btn btn-sm btn-outline" style={{ marginRight: 8 }} onClick={() => setDetailsDriverId(u.id)}>
                          View Driver Details
                        </button>
                      )}
                      {u.account_status === 'active' && (
                        <>
                          <button className="btn btn-sm btn-outline" style={{ marginRight: 8 }} onClick={() => openAction(u, 'suspend')}>Suspend</button>
                          <button className="btn btn-sm btn-danger" onClick={() => openAction(u, 'ban')}>Ban</button>
                        </>
                      )}
                      {u.account_status === 'suspended' && (
                        <>
                          <button className="btn btn-sm btn-primary" style={{ marginRight: 8 }} onClick={() => openAction(u, 'reactivate')}>Reactivate</button>
                          <button className="btn btn-sm btn-danger" onClick={() => openAction(u, 'ban')}>Ban</button>
                        </>
                      )}
                      {u.account_status === 'banned' && (
                        <button className="btn btn-sm btn-primary" onClick={() => openAction(u, 'reactivate')}>Reactivate</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {actionTarget && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>
              {actionTarget.action === 'suspend' && `Suspend ${actionTarget.user.full_name}'s ${actionTarget.user.role} account?`}
              {actionTarget.action === 'ban' && `Ban ${actionTarget.user.full_name}'s ${actionTarget.user.role} account?`}
              {actionTarget.action === 'reactivate' && `Reactivate ${actionTarget.user.full_name}'s ${actionTarget.user.role} account?`}
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              {actionTarget.action === 'suspend' && `Their ${actionTarget.user.role} account will only show a suspension notice until reactivated. Their other role account (if any) is unaffected.`}
              {actionTarget.action === 'ban' && `This is a stronger action — their ${actionTarget.user.role} account will only show a permanent ban notice. Their other role account (if any) is unaffected. This can be reversed manually if needed.`}
              {actionTarget.action === 'reactivate' && `They will regain full access to their ${actionTarget.user.role} account immediately.`}
            </p>

            {actionTarget.action !== 'reactivate' && (
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">Reason (shown to the user)</label>
                <textarea
                  className="form-input"
                  rows={3}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  style={{ resize: 'vertical', fontFamily: "'DM Sans', sans-serif" }}
                  placeholder="e.g. Multiple passenger safety reports pending investigation"
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setActionTarget(null)}>Cancel</button>
              <button
                className={`btn btn-sm ${actionTarget.action === 'reactivate' ? 'btn-primary' : 'btn-danger'}`}
                disabled={busy || (actionTarget.action !== 'reactivate' && !reason.trim())}
                onClick={confirmAction}
              >
                {busy ? <span className="spinner" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailsDriverId && (
        <DriverDetailsModal driverId={detailsDriverId} onClose={() => setDetailsDriverId(null)} />
      )}
    </DashboardLayout>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
};
const modalStyle = {
  background: 'white', borderRadius: 16, padding: '28px 30px', maxWidth: 420, width: '100%',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', fontFamily: "'DM Sans', sans-serif",
};
