import DashboardLayout from '../../components/shared/DashboardLayout';
import MyReportsList from '../../components/shared/MyReportsList';

export default function MyReports() {
  return (
    <DashboardLayout title="My Reports">
      <MyReportsList portal="driver" />
    </DashboardLayout>
  );
}
