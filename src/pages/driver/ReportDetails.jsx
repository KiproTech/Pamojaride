import DashboardLayout from '../../components/shared/DashboardLayout';
import ReportDetailsView from '../../components/shared/ReportDetailsView';

export default function ReportDetails() {
  return (
    <DashboardLayout title="Report Details">
      <ReportDetailsView portal="driver" />
    </DashboardLayout>
  );
}
