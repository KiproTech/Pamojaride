import { supabase } from './supabase';

// Data-fetching helpers for Trip/Booking History detail pages + Receipts.
// Both RPCs are ownership-checked server-side (see
// database/booking_history_receipts.sql) — requesting a booking id that
// doesn't exist, or that belongs to someone else, returns zero rows in
// both cases. That's deliberate: it's what makes editing the id straight
// in the URL (e.g. /passenger/bookings/123 -> /passenger/bookings/124)
// safe. This module never distinguishes the two cases either — both
// surface to the caller as `booking: null`.

// Passenger: full booking + trip + driver detail for one booking.
export async function fetchPassengerBookingDetail(bookingId) {
  const { data, error } = await supabase.rpc('get_passenger_booking_detail', { p_booking_id: bookingId });
  if (error) {
    console.error('fetchPassengerBookingDetail error:', error);
    return { booking: null, error };
  }
  const booking = Array.isArray(data) ? data[0] || null : null;
  return { booking, error: null };
}

// Driver: full booking + trip + passenger detail for one booking.
export async function fetchDriverBookingDetail(bookingId) {
  const { data, error } = await supabase.rpc('get_driver_booking_detail', { p_booking_id: bookingId });
  if (error) {
    console.error('fetchDriverBookingDetail error:', error);
    return { booking: null, error };
  }
  const booking = Array.isArray(data) ? data[0] || null : null;
  return { booking, error: null };
}
