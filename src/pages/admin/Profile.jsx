import { useAuth } from '../../context/AuthContext';
import DashboardLayout from '../../components/shared/DashboardLayout';
import ChangePasswordCard from '../../components/shared/ChangePasswordCard';
import PersonalInfoCard from '../../components/shared/PersonalInfoCard';

// Admin's own account settings — previously missing entirely (the Navbar's
// "My Profile" link pointed admins at /admin/dashboard instead). Reuses the
// exact same PersonalInfoCard/ChangePasswordCard used by the passenger and
// driver Profile pages, so an admin edits their own name/phone/photo and
// password through the identical, already-audited path — same
// updateProfile() call scoped to auth.uid(), same trg_protect_profile_
// privileged_columns trigger guarding is_admin/trips_completed/
// phone_verified underneath it. Admins have no driver_profiles/
// passenger_profiles row, so there's no verification or trip-history card
// here — just identity + security, which is all an admin account has.
export default function Profile() {
  const { profile, updateProfile } = useAuth();

  return (
    <DashboardLayout title="Profile">
      <div className="page-header">
        <h1>Your Profile</h1>
        <p>Manage your personal details and account security.</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}>
        <PersonalInfoCard profile={profile} updateProfile={updateProfile} />
        <ChangePasswordCard />
      </div>
    </DashboardLayout>
  );
}
