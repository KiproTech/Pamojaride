import DashboardLayout from '../../components/shared/DashboardLayout';
import BookingDetailsView from '../../components/shared/BookingDetailsView';

export default function BookingDetails() {
  return (
    <DashboardLayout title="Booking Details">
      <BookingDetailsView portal="driver" />
    </DashboardLayout>
  );
}
