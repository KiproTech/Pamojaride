import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import ContactSupportForm from './ContactSupportForm';
import SupportRequestsList from './SupportRequestsList';

// Shared Help & Support page, used by both portals:
//   - pages/passenger/Support.jsx (portal="passenger")
//   - pages/driver/Support.jsx    (portal="driver")
//
// Ties together: a short explanation of how to get help, the ALREADY
// CONFIGURED support email used elsewhere in this project (receipts,
// PDFs, and the Banned/Suspended/PendingApproval pages all already use
// support@pamojaride.co.ke — nothing here is invented), a link into the
// existing Report an Issue flow for misconduct/safety topics, the Contact
// Support form, and the user's own request history.
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

        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 10 }}>Support contact</h3>
          <p style={{ fontSize: 13.5, color: 'var(--text-secondary, #334155)', margin: '0 0 10px' }}>
            You can also reach our support team directly by email:
          </p>
          <a className="btn btn-outline btn-sm" href="mailto:support@pamojaride.co.ke">support@pamojaride.co.ke</a>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            For the fastest response, submit a request below instead — it's automatically linked to your
            account and any relevant booking, and you can track its status here.
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <ContactSupportForm userId={user?.id} portal={portal} onSubmitted={() => setRefreshKey(k => k + 1)} />
      </div>

      <SupportRequestsList portal={portal} refreshKey={refreshKey} />
    </div>
  );
}
