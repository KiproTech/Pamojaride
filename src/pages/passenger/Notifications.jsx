import DashboardLayout from '../../components/shared/DashboardLayout';
import NotificationsList from '../../components/shared/NotificationsList';

export default function Notifications() {
  return (
    <DashboardLayout title="Notifications">
      <NotificationsList portal="passenger" />
    </DashboardLayout>
  );
}
