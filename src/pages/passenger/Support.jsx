import DashboardLayout from '../../components/shared/DashboardLayout';
import SupportPage from '../../components/shared/SupportPage';

export default function Support() {
  return (
    <DashboardLayout title="Help & Support">
      <SupportPage portal="passenger" />
    </DashboardLayout>
  );
}
