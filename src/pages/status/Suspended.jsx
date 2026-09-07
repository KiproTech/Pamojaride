import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

// Shown by App.jsx's ProtectedRoute whenever statusFor(role).isSuspended
// is true. Suspensions are meant to be temporary/reversible by an admin
// (see UserManagement.jsx "Reactivate"), so the tone here is lighter than
// Banned — no appeal form needed, just contact info and a way out.
export default function Suspended({ reason }) {
  const { profile, portal, signOut } = useAuth();

  return (
    <div className="page-layout" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex', minHeight: '100vh', padding: 24 }}>
      <div className="card card-pad" style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⏸️</div>
        <span className="badge badge-amber">Account Suspended</span>
        <h1 style={{ fontSize: 21, margin: '14px 0 8px' }}>Your {portal} account is temporarily suspended</h1>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, margin: '0 0 16px' }}>
          Your account is under review by our team. This is usually temporary — you'll regain access once it's lifted.
        </p>

        {reason && (
          <div className="alert alert-amber" style={{ textAlign: 'left', marginBottom: 20 }}>
            <strong>Reason given:</strong> {reason}
          </div>
        )}

        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 20 }}>
          If you think this is a mistake, contact support and reference your account email
          (<strong>{profile?.email}</strong>).
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a className="btn btn-outline btn-sm" href="mailto:support@pamojaride.co.ke">Contact Support</a>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Log out</button>
        </div>
      </div>
    </div>
  );
}
