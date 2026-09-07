import DashboardLayout from '../../components/shared/DashboardLayout';
import SupportRequestDetailsView from '../../components/shared/SupportRequestDetailsView';

export default function SupportDetails() {
  return (
    <DashboardLayout title="Support Request">
      <SupportRequestDetailsView portal="driver" />
    </DashboardLayout>
  );
}
