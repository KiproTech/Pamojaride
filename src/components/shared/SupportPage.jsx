import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import ContactSupportForm from './ContactSupportForm';
import SupportRequestsList from './SupportRequestsList';
import SupportContactsCard from './SupportContactsCard';

// Shared Help & Support page, used by both portals:
//   - pages/passenger/Support.jsx (portal="passenger")
//   - pages/driver/Support.jsx    (portal="driver")
//
// Ties together: a short explanation of how to get help, the LIVE
// Admin-managed support contacts (database/admin_support_contacts_
// foundation.sql, lib/support/supportContacts.js, rendered here by
// SupportContactsCard — nothing hardcoded, always reflects whatever
// Admin currently has saved at /admin/settings/support-contacts), a link
// into the existing Report an Issue flow for misconduct/safety topics,
// the Contact Support form, and the user's own request history.
export default function SupportPage({ portal }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div>
      <div className="page-header">
        <h1>Help &amp; Support</h1>
        <p>Get help with your account, bookings, payments, or anything else — our team is here to help.</p>
      </div>

      <div className="grid-2" style={{ gap: 20, marginBottom: 20, alignItems: 'stretch' }}>
        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 10 }}>Ways to get help</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: 'var(--text-secondary, #334155)', lineHeight: 1.9 }}>
            <li><strong>Contact Support</strong> — submit a request below for account, booking, payment, or technical questions.</li>
            <li>
              <strong>Report an Issue</strong> — for misconduct, safety concerns, or a dispute about a specific trip, report it
              directly from{' '}
              <button
                type="button"
                onClick={() => navigate(`/${portal}/bookings`)}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary-dark, #1D4ED8)', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', fontSize: 13.5 }}
              >
                your bookings
              </button>.
            </li>
            <li><strong>My Reports</strong> — track reports you've already filed from the "My Reports" section.</li>
          </ul>
        </div>

        <SupportContactsCard />
      </div>

      <div style={{ marginBottom: 20 }}>
        <ContactSupportForm userId={user?.id} portal={portal} onSubmitted={() => setRefreshKey(k => k + 1)} />
      </div>

      <SupportRequestsList portal={portal} refreshKey={refreshKey} />
    </div>
  );
}
