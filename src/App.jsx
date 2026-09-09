import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';

// Public
import Landing from './pages/Landing';
import TermsAndPrivacy from './pages/legal/TermsAndPrivacy';

// Auth
import PassengerLogin    from './pages/auth/PassengerLogin';
import PassengerRegister from './pages/auth/PassengerRegister';
import DriverLogin       from './pages/auth/DriverLogin';
import DriverRegister    from './pages/auth/DriverRegister';
import AdminLogin        from './pages/auth/AdminLogin';
import ForgotPassword    from './pages/auth/ForgotPassword';
import ResetPassword     from './pages/auth/ResetPassword';

// Passenger
import PassengerDashboard from './pages/passenger/Dashboard';
import SearchTrips        from './pages/passenger/SearchTrips';
import TripDetails        from './pages/passenger/TripDetails';
import MyBookings         from './pages/passenger/MyBookings';
import PassengerBookingDetails from './pages/passenger/BookingDetails';
import PassengerProfile   from './pages/passenger/Profile';
import PassengerMyReports from './pages/passenger/MyReports';
import PassengerReportDetails from './pages/passenger/ReportDetails';
import PassengerSupport from './pages/passenger/Support';
import PassengerSupportDetails from './pages/passenger/SupportDetails';
import PassengerNotifications from './pages/passenger/Notifications';

// Driver
import DriverDashboard    from './pages/driver/Dashboard';
import CreateTrip         from './pages/driver/CreateTrip';
import ManageTrips        from './pages/driver/ManageTrips';
import DriverBookings     from './pages/driver/Bookings';
import DriverBookingDetails from './pages/driver/BookingDetails';
import DriverProfile      from './pages/driver/Profile';
import DriverVerification from './pages/driver/Verification';
import DriverMyReports    from './pages/driver/MyReports';
import DriverReportDetails from './pages/driver/ReportDetails';
import DriverSupport      from './pages/driver/Support';
import DriverSupportDetails from './pages/driver/SupportDetails';
import DriverNotifications from './pages/driver/Notifications';

// Admin
import AdminDashboard   from './pages/admin/Dashboard';
import DriverReview     from './pages/admin/DriverReview';
import TripOversight    from './pages/admin/TripOversight';
import UserManagement   from './pages/admin/UserManagement';
import Reports          from './pages/admin/Reports';
import Analytics        from './pages/admin/Analytics';
import AdminReportDetails from './pages/admin/ReportDetails';
import AdminSupport     from './pages/admin/Support';
import AdminSupportDetails from './pages/admin/SupportDetails';
import AdminNotifications from './pages/admin/Notifications';
import AdminProfile from './pages/admin/Profile';
import AdminSupportContacts from './pages/admin/SupportContacts';
import AuditLog         from './pages/admin/AuditLog';
import AdminManagement  from './pages/admin/AdminManagement';
import AcceptAdminInvite from './pages/auth/AcceptAdminInvite';

// Account status (suspended / banned / pending driver approval) — scoped
// to whichever role tripped it
import Suspended      from './pages/status/Suspended';
import Banned         from './pages/status/Banned';
import PendingApproval from './pages/status/PendingApproval';

// ── Route guards ───────────────────────────────────────────────────────
//
// IMPORTANT: role is now checked against the EXISTENCE of a role-scoped
// profile (driverProfile / passengerProfile), never against a single
// global `profile.role`. One identity can have both, so "does this
// identity have a driver profile" is a completely separate question from
// "does this identity have a passenger profile" -- and neither implies
// anything about which dashboard THIS route should show. The `role` prop
// passed to ProtectedRoute is the only thing that decides that.
// `allowUnverifiedDriver`: driver routes that must stay reachable even
// before verification is approved -- currently /driver/verification (so a
// driver can actually submit/resubmit documents) and /driver/profile (so
// they can fix contact details). Every other driver route requires
// verification_status === 'verified', enforced below.
function ProtectedRoute({ children, role, allowUnverifiedDriver = false, requireSuperAdmin = false, adminRoles = null }) {
  const { user, loading, isAdmin, isSuperAdmin, hasAdminRole, statusFor, verificationStatus, isDriverVerified } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <Navigate to="/" replace />;

  // Admin routes: gated on the is_admin flag (a deactivated admin has
  // is_admin flipped back to false by Admin Management, so this already
  // covers "deactivated admin loses access" with no extra check needed).
  // requireSuperAdmin additionally gates Admin Management itself to the
  // super_admin role tier -- enforced again on the backend by RLS on
  // admin_profiles/admin_invitations, this is just the UI-level mirror.
  if (role === 'admin') {
    if (!isAdmin) return <Navigate to="/admin/login" replace />;
    if (requireSuperAdmin && !isSuperAdmin) return <Navigate to="/admin/dashboard" replace />;
    // adminRoles: e.g. ['verification_admin'] on Driver Review, ['reports_admin']
    // on Reports/Analytics. super_admin always passes (hasAdminRole ORs it
    // in), and pages with no adminRoles list stay open to every admin tier
    // ("general administrative access"), matching the spec's Admin role.
    if (adminRoles && !hasAdminRole(adminRoles)) return <Navigate to="/admin/dashboard" replace />;
    return children;
  }

  // Driver / passenger routes: gated on that specific role profile
  // existing for this identity -- never on the other role, and never on
  // whichever role happens to be "primary".
  const status = statusFor(role);

  if (!status.exists) {
    // This identity has no profile for the role this route requires.
    // Do NOT fall back to another role's dashboard -- send them to the
    // matching login/register flow instead.
    return <Navigate to={`/${role}/login`} replace />;
  }

  // Ban/suspension always takes priority over verification state -- a
  // banned driver sees Banned, never PendingApproval, even if they were
  // also never verified.
  if (status.isBanned) return <Banned reason={status.suspensionReason} />;
  if (status.isSuspended) return <Suspended reason={status.suspensionReason} />;

  // Driver-only: block everything except the exempted routes until the
  // account is approved. Passengers have no equivalent gate -- they never
  // require admin approval.
  if (role === 'driver' && !isDriverVerified && !allowUnverifiedDriver) {
    return <PendingApproval />;
  }

  return children;
}

// Portal sessions are isolated (see AuthContext / supabaseClients), so on a
// portal-specific login page (preferredRole set) `useAuth()` already
// reflects that exact portal's session and the check below is direct.
//
// On the generic landing page ("/"), there is deliberately NO cross-portal
// "is the person signed in somewhere else" check here. Landing always just
// renders the landing page with its Passenger Login / Driver Login choices,
// regardless of what's signed in in this browser under a different portal
// (or even the same portal, in another tab) -- that's the whole point of a
// landing page, and it also avoids a bug this app used to have: an
// automatic redirect out of "/" raced against AuthContext's own async,
// portal-scoped session bootstrap (see the `setLoading(true)` comment in
// AuthContext.jsx), which could bounce a freshly-opened tab back and forth
// between "/" and a dashboard forever. If someone wants their existing
// dashboard, that's one click away on Landing -- it never happens for them
// automatically.
function PublicRoute({ children, preferredRole = null }) {
  const { user, loading, isAdmin, isDriver, isPassenger } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (user) {
    // On a role-specific login/register page, only redirect away if the
    // person already has THAT role's session active -- e.g. someone
    // signed in as passenger (but not driver) landing on /driver/login
    // should still see the driver login/register form, not get bounced.
    if (preferredRole === 'admin' && isAdmin) return <Navigate to="/admin/dashboard" replace />;
    if (preferredRole === 'driver' && isDriver) return <Navigate to="/driver/dashboard" replace />;
    if (preferredRole === 'passenger' && isPassenger) return <Navigate to="/passenger/dashboard" replace />;
  }

  return children;
}

// ── App ────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<PublicRoute><Landing /></PublicRoute>} />
      {/* Not wrapped in PublicRoute/ProtectedRoute: must be reachable by
          anyone regardless of login state or portal, same reasoning as
          /passenger/reset-password above — reached from registration,
          the landing footer, the dashboard sidebar, and Profile pages. */}
      <Route path="/legal/terms" element={<TermsAndPrivacy />} />

      {/* Auth — passenger */}
      <Route path="/passenger/login"    element={<PublicRoute preferredRole="passenger"><PassengerLogin /></PublicRoute>} />
      <Route path="/passenger/register" element={<PublicRoute preferredRole="passenger"><PassengerRegister /></PublicRoute>} />
      <Route path="/passenger/forgot-password" element={<PublicRoute preferredRole="passenger"><ForgotPassword portal="passenger" /></PublicRoute>} />
      {/* Not wrapped in PublicRoute/ProtectedRoute: this page must render
          regardless of whether a passenger session already exists in this
          browser, since the recovery link itself creates/refreshes one the
          instant it's opened — a guard here could bounce the user away
          before they ever see the reset form. */}
      <Route path="/passenger/reset-password" element={<ResetPassword portal="passenger" />} />

      {/* Auth — driver */}
      <Route path="/driver/login"    element={<PublicRoute preferredRole="driver"><DriverLogin /></PublicRoute>} />
      <Route path="/driver/register" element={<PublicRoute preferredRole="driver"><DriverRegister /></PublicRoute>} />
      <Route path="/driver/forgot-password" element={<PublicRoute preferredRole="driver"><ForgotPassword portal="driver" /></PublicRoute>} />
      <Route path="/driver/reset-password" element={<ResetPassword portal="driver" />} />

      {/* Auth — admin */}
      <Route path="/admin/login" element={<PublicRoute preferredRole="admin"><AdminLogin /></PublicRoute>} />
      {/* Not wrapped in PublicRoute: an invited person may already be signed
          into another portal (or nothing at all), and needs to reach this
          page regardless -- it handles its own auth state internally. */}
      <Route path="/admin/accept-invite" element={<AcceptAdminInvite />} />

      {/* Passenger pages */}
      <Route path="/passenger/dashboard" element={<ProtectedRoute role="passenger"><PassengerDashboard /></ProtectedRoute>} />
      <Route path="/passenger/search"    element={<ProtectedRoute role="passenger"><SearchTrips /></ProtectedRoute>} />
      <Route path="/passenger/trips/:tripId" element={<ProtectedRoute role="passenger"><TripDetails /></ProtectedRoute>} />
      <Route path="/passenger/bookings"  element={<ProtectedRoute role="passenger"><MyBookings /></ProtectedRoute>} />
      <Route path="/passenger/bookings/:bookingId" element={<ProtectedRoute role="passenger"><PassengerBookingDetails /></ProtectedRoute>} />
      <Route path="/passenger/reports"   element={<ProtectedRoute role="passenger"><PassengerMyReports /></ProtectedRoute>} />
      <Route path="/passenger/reports/:reportId" element={<ProtectedRoute role="passenger"><PassengerReportDetails /></ProtectedRoute>} />
      <Route path="/passenger/support"   element={<ProtectedRoute role="passenger"><PassengerSupport /></ProtectedRoute>} />
      <Route path="/passenger/support/:requestId" element={<ProtectedRoute role="passenger"><PassengerSupportDetails /></ProtectedRoute>} />
      <Route path="/passenger/notifications" element={<ProtectedRoute role="passenger"><PassengerNotifications /></ProtectedRoute>} />
      <Route path="/passenger/profile"   element={<ProtectedRoute role="passenger"><PassengerProfile /></ProtectedRoute>} />

      {/* Driver pages */}
      <Route path="/driver/dashboard"    element={<ProtectedRoute role="driver"><DriverDashboard /></ProtectedRoute>} />
      <Route path="/driver/create-trip"  element={<ProtectedRoute role="driver"><CreateTrip /></ProtectedRoute>} />
      <Route path="/driver/trips"        element={<ProtectedRoute role="driver"><ManageTrips /></ProtectedRoute>} />
      <Route path="/driver/bookings"     element={<ProtectedRoute role="driver"><DriverBookings /></ProtectedRoute>} />
      <Route path="/driver/bookings/:bookingId" element={<ProtectedRoute role="driver"><DriverBookingDetails /></ProtectedRoute>} />
      <Route path="/driver/reports"      element={<ProtectedRoute role="driver"><DriverMyReports /></ProtectedRoute>} />
      <Route path="/driver/reports/:reportId" element={<ProtectedRoute role="driver"><DriverReportDetails /></ProtectedRoute>} />
      <Route path="/driver/support"      element={<ProtectedRoute role="driver" allowUnverifiedDriver><DriverSupport /></ProtectedRoute>} />
      <Route path="/driver/support/:requestId" element={<ProtectedRoute role="driver" allowUnverifiedDriver><DriverSupportDetails /></ProtectedRoute>} />
      <Route path="/driver/notifications" element={<ProtectedRoute role="driver" allowUnverifiedDriver><DriverNotifications /></ProtectedRoute>} />
      <Route path="/driver/profile"      element={<ProtectedRoute role="driver" allowUnverifiedDriver><DriverProfile /></ProtectedRoute>} />
      <Route path="/driver/verification" element={<ProtectedRoute role="driver" allowUnverifiedDriver><DriverVerification /></ProtectedRoute>} />

      {/* Admin pages */}
      <Route path="/admin/dashboard"      element={<ProtectedRoute role="admin"><AdminDashboard /></ProtectedRoute>} />
      <Route path="/admin/drivers/review" element={<ProtectedRoute role="admin" adminRoles={['verification_admin']}><DriverReview /></ProtectedRoute>} />
      <Route path="/admin/trips"          element={<ProtectedRoute role="admin"><TripOversight /></ProtectedRoute>} />
      <Route path="/admin/users"          element={<ProtectedRoute role="admin"><UserManagement /></ProtectedRoute>} />
      <Route path="/admin/reports"        element={<ProtectedRoute role="admin"><Reports /></ProtectedRoute>} />
      <Route path="/admin/analytics"      element={<ProtectedRoute role="admin" adminRoles={['reports_admin']}><Analytics /></ProtectedRoute>} />
      <Route path="/admin/reports/:reportId" element={<ProtectedRoute role="admin"><AdminReportDetails /></ProtectedRoute>} />
      <Route path="/admin/support"        element={<ProtectedRoute role="admin" adminRoles={['support_admin']}><AdminSupport /></ProtectedRoute>} />
      <Route path="/admin/support/:requestId" element={<ProtectedRoute role="admin" adminRoles={['support_admin']}><AdminSupportDetails /></ProtectedRoute>} />
      <Route path="/admin/notifications"  element={<ProtectedRoute role="admin"><AdminNotifications /></ProtectedRoute>} />
      <Route path="/admin/profile"        element={<ProtectedRoute role="admin"><AdminProfile /></ProtectedRoute>} />
      <Route path="/admin/settings/support-contacts" element={<ProtectedRoute role="admin"><AdminSupportContacts /></ProtectedRoute>} />
      <Route path="/admin/audit-log"      element={<ProtectedRoute role="admin"><AuditLog /></ProtectedRoute>} />
      <Route path="/admin/admin-management" element={<ProtectedRoute role="admin" requireSuperAdmin><AdminManagement /></ProtectedRoute>} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
