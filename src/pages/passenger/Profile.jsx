import { useAuth } from '../../context/AuthContext';
import DashboardLayout from '../../components/shared/DashboardLayout';
import ChangePasswordCard from '../../components/shared/ChangePasswordCard';
import PersonalInfoCard from '../../components/shared/PersonalInfoCard';
import LegalConsentCard from '../../components/shared/LegalConsentCard';

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
        <LegalConsentCard profile={profile} updateProfile={updateProfile} />
      </div>
    </DashboardLayout>
  );
}
