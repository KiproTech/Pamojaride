import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import DashboardLayout from '../../components/shared/DashboardLayout';

const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  verification_admin: 'Verification Admin',
  support_admin: 'Support Admin',
  reports_admin: 'Reports Admin',
};

const ROLE_DESCRIPTIONS = {
  super_admin: 'Full access, including managing other administrators and assigning roles.',
  admin: 'General administrative access.',
  verification_admin: 'Driver verification, documents, and approval/rejection.',
  support_admin: 'Users (suspend/ban), support requests, and help functionality.',
  reports_admin: 'Reports, performance statistics, and report downloads.',
};

const ROLE_OPTIONS = Object.keys(ROLE_LABELS);

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function AdminManagement() {
  const { profile: currentAdminProfile } = useAuth();
  const [admins, setAdmins] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ full_name: '', email: '', phone: '', admin_role: 'admin' });
  const [inviteError, setInviteError] = useState('');
  const [inviteLink, setInviteLink] = useState(null); // shown once, after a successful invite

  const [roleTarget, setRoleTarget] = useState(null); // { admin, newRole }
  const [statusTarget, setStatusTarget] = useState(null); // { admin, action: 'deactivate' | 'reactivate' }
  const [removeTarget, setRemoveTarget] = useState(null); // admin to permanently remove

  async function loadAll() {
    setLoading(true);
    setError('');

    const [adminsRes, invitesRes] = await Promise.all([
      supabase
        .from('admin_profiles')
        .select('profile_id, admin_role, account_status, created_at, profiles:profile_id (full_name, email, phone, profile_picture, created_at)'),
      supabase
        .from('admin_invitations')
        .select('id, email, full_name, phone, admin_role, status, created_at, expires_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
    ]);

    if (adminsRes.error) {
      setError(adminsRes.error.message);
      setLoading(false);
      return;
    }

    const flattened = (adminsRes.data || [])
      .map(({ profile_id, profiles: identity, ...roleFields }) => ({ id: profile_id, ...identity, ...roleFields }))
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    setAdmins(flattened);
    // A failed invitations fetch shouldn't block the (more important)
    // admin list from rendering.
    if (!invitesRes.error) setInvitations(invitesRes.data || []);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  async function handleInviteSubmit(e) {
    e.preventDefault();
    setInviteError('');
    if (!inviteForm.full_name.trim() || !inviteForm.email.trim()) {
      setInviteError('Full name and email are required.');
      return;
    }
    setBusy(true);
    const { data, error: inviteErr } = await supabase.rpc('create_admin_invitation', {
      p_email: inviteForm.email.trim(),
      p_full_name: inviteForm.full_name.trim(),
      p_phone: inviteForm.phone.trim() || null,
      p_admin_role: inviteForm.admin_role,
    });
    setBusy(false);
    if (inviteErr) { setInviteError(inviteErr.message); return; }

    const link = `${window.location.origin}/admin/accept-invite?token=${data.token}`;
    setInviteLink({ link, email: data.email, role: data.admin_role });
    setInviteForm({ full_name: '', email: '', phone: '', admin_role: 'admin' });
    setShowInvite(false);
    loadAll();
  }

  async function revokeInvite(id) {
    setBusy(true);
    const { error: revokeErr } = await supabase.rpc('revoke_admin_invitation', { p_id: id });
    setBusy(false);
    if (revokeErr) { setError(revokeErr.message); return; }
    setInvitations(prev => prev.filter(i => i.id !== id));
  }

  async function confirmRoleChange() {
    if (!roleTarget) return;
    setBusy(true);
    setError('');
    const { error: updateErr } = await supabase
      .from('admin_profiles')
      .update({ admin_role: roleTarget.newRole })
      .eq('profile_id', roleTarget.admin.id);
    setBusy(false);
    if (updateErr) { setError(updateErr.message); return; }
    setAdmins(prev => prev.map(a => a.id === roleTarget.admin.id ? { ...a, admin_role: roleTarget.newRole } : a));
    setRoleTarget(null);
  }

  async function confirmStatusChange() {
    if (!statusTarget) return;
    const { admin, action } = statusTarget;
    const nextStatus = action === 'deactivate' ? 'deactivated' : 'active';
    setBusy(true);
    setError('');

    // Two writes, same shape as UserManagement's suspend/ban: the
    // admin_profiles status (what Admin Management itself reads), and
    // profiles.is_admin (the flag every OTHER RLS policy in the app
    // actually checks) -- deactivating an admin here immediately revokes
    // every admin-only permission everywhere else, not just hides them
    // from this list.
    const { error: apErr } = await supabase
      .from('admin_profiles')
      .update({ account_status: nextStatus })
      .eq('profile_id', admin.id);
    if (apErr) { setError(apErr.message); setBusy(false); return; }

    const { error: profErr } = await supabase
      .from('profiles')
      .update({ is_admin: action === 'reactivate' })
      .eq('id', admin.id);
    if (profErr) { setError(profErr.message); setBusy(false); return; }

    setAdmins(prev => prev.map(a => a.id === admin.id ? { ...a, account_status: nextStatus } : a));
    setBusy(false);
    setStatusTarget(null);
  }

  // Permanent removal, distinct from deactivate: deletes the
  // admin_profiles row entirely rather than just flagging it inactive.
  // The person is no longer an administrator at all -- if they need
  // access again later, a super admin has to invite them fresh.
  async function confirmRemove() {
    if (!removeTarget) return;
    setBusy(true);
    setError('');

    const { error: deleteErr } = await supabase
      .from('admin_profiles')
      .delete()
      .eq('profile_id', removeTarget.id);
    if (deleteErr) { setError(deleteErr.message); setBusy(false); return; }

    const { error: profErr } = await supabase
      .from('profiles')
      .update({ is_admin: false })
      .eq('id', removeTarget.id);
    if (profErr) { setError(profErr.message); setBusy(false); return; }

    setAdmins(prev => prev.filter(a => a.id !== removeTarget.id));
    setBusy(false);
    setRemoveTarget(null);
  }

  return (
    <DashboardLayout title="Admin Management">
      <div className="page-header flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Admin Management</h1>
          <p>Add administrators and manage their roles. Only Super Admins can see this page.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => { setShowInvite(true); setInviteError(''); }}>
          + Invite Admin
        </button>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}>{error}</div>}

      {inviteLink && (
        <div className="card card-pad" style={{ marginBottom: 20, background: 'var(--primary-xlight)' }}>
          <strong style={{ fontSize: 13.5 }}>Invitation created for {inviteLink.email} ({ROLE_LABELS[inviteLink.role]})</strong>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 10px' }}>
            Share this link with them directly (e.g. by email or chat) — this app has no way to email it automatically.
            They'll set their own password when they open it; you never see or set a credential for them.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{ fontSize: 12, background: 'white', padding: '6px 10px', borderRadius: 8, wordBreak: 'break-all', flex: 1, minWidth: 200 }}>
              {inviteLink.link}
            </code>
            <button className="btn btn-sm btn-outline" onClick={() => navigator.clipboard?.writeText(inviteLink.link)}>Copy</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setInviteLink(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700 }}>
            Pending Invitations
          </div>
          {invitations.map(inv => (
            <div key={inv.id} className="flex-between" style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <strong style={{ fontSize: 13.5 }}>{inv.full_name}</strong>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.email} · {ROLE_LABELS[inv.admin_role]} · expires {fmtDate(inv.expires_at)}</div>
              </div>
              <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => revokeInvite(inv.id)}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24 }}>
            <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
          </div>
        ) : admins.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🛡️</div>
            <h3>No administrators found</h3>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                {['Admin', 'Contact', 'Role', 'Status', 'Since', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '12px 20px', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {admins.map(a => {
                const isSelf = a.id === currentAdminProfile?.id;
                return (
                  <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '14px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {a.profile_picture ? (
                          <img src={a.profile_picture} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
                        ) : (
                          <span className="topbar-avatar" style={{ width: 32, height: 32, fontSize: 12 }}>{initials(a.full_name)}</span>
                        )}
                        <strong style={{ fontSize: 13.5 }}>{a.full_name}{isSelf ? ' (you)' : ''}</strong>
                      </div>
                    </td>
                    <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)' }}>{a.email}<br />{a.phone}</td>
                    <td style={{ padding: '14px 20px' }}>
                      <span className="badge badge-teal" title={ROLE_DESCRIPTIONS[a.admin_role]}>{ROLE_LABELS[a.admin_role] || a.admin_role}</span>
                    </td>
                    <td style={{ padding: '14px 20px' }}>
                      <span className={`badge ${a.account_status === 'active' ? 'badge-green' : 'badge-danger'}`}>
                        {a.account_status === 'active' ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td style={{ padding: '14px 20px', fontSize: 12.5, color: 'var(--text-muted)' }}>{fmtDate(a.created_at)}</td>
                    <td style={{ padding: '14px 20px', textAlign: 'right', minWidth: 260 }}>
                      {!isSelf && (
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-sm btn-outline"
                            onClick={() => setRoleTarget({ admin: a, newRole: a.admin_role })}
                          >
                            Change Role
                          </button>
                          {a.account_status === 'active' ? (
                            <button className="btn btn-sm btn-danger" onClick={() => setStatusTarget({ admin: a, action: 'deactivate' })}>Deactivate</button>
                          ) : (
                            <button className="btn btn-sm btn-primary" onClick={() => setStatusTarget({ admin: a, action: 'reactivate' })}>Reactivate</button>
                          )}
                          <button className="btn btn-sm btn-outline" style={{ color: '#DC2626', borderColor: '#FECACA' }} onClick={() => setRemoveTarget(a)}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 16 }}>Invite Administrator</h3>
            <form onSubmit={handleInviteSubmit}>
              {inviteError && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{inviteError}</div>}
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Full name</label>
                <input className="form-input" value={inviteForm.full_name} onChange={e => setInviteForm(f => ({ ...f, full_name: e.target.value }))} />
              </div>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Email</label>
                <input type="email" className="form-input" value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Phone (optional)</label>
                <input className="form-input" value={inviteForm.phone} onChange={e => setInviteForm(f => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">Role</label>
                <select className="form-input" value={inviteForm.admin_role} onChange={e => setInviteForm(f => ({ ...f, admin_role: e.target.value }))}>
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{ROLE_DESCRIPTIONS[inviteForm.admin_role]}</p>
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setShowInvite(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? <span className="spinner" /> : 'Send Invitation'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Role-change modal */}
      {roleTarget && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>Change role for {roleTarget.admin.full_name}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Takes effect immediately.</p>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <select className="form-input" value={roleTarget.newRole} onChange={e => setRoleTarget(t => ({ ...t, newRole: e.target.value }))}>
                {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{ROLE_DESCRIPTIONS[roleTarget.newRole]}</p>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRoleTarget(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={confirmRoleChange}>{busy ? <span className="spinner" /> : 'Save Role'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Deactivate/reactivate confirm modal */}
      {statusTarget && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>
              {statusTarget.action === 'deactivate' ? `Deactivate ${statusTarget.admin.full_name}?` : `Reactivate ${statusTarget.admin.full_name}?`}
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              {statusTarget.action === 'deactivate'
                ? 'They will immediately lose all admin access, including the ability to sign in to the admin portal.'
                : 'They will regain admin access with their previous role.'}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setStatusTarget(null)}>Cancel</button>
              <button
                className={`btn btn-sm ${statusTarget.action === 'deactivate' ? 'btn-danger' : 'btn-primary'}`}
                disabled={busy}
                onClick={confirmStatusChange}
              >
                {busy ? <span className="spinner" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent removal confirm modal */}
      {removeTarget && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginBottom: 8 }}>Remove {removeTarget.full_name}?</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              This permanently deletes their administrator record — unlike Deactivate, this can't be undone by
              reactivating. They immediately lose all admin access. If they need it again later, they'll need a
              brand new invitation.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRemoveTarget(null)}>Cancel</button>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={confirmRemove}>
                {busy ? <span className="spinner" /> : 'Permanently Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
};
const modalStyle = {
  background: 'white', borderRadius: 16, padding: '28px 30px', maxWidth: 440, width: '100%',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', fontFamily: "'DM Sans', sans-serif",
};
