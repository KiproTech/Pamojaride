// Fixed set of reasons a DRIVER can pick from when cancelling a single
// passenger's booking (as opposed to cancelling the whole trip — see
// cancellationReasons.js for that separate list).
//
// `value` is the category key sent to the `cancel_booking` RPC as
// `p_reason_category` — it is validated against this same fixed list on the
// backend (see src/database/driver_passenger_booking_cancellation.sql), so a
// driver can never sneak arbitrary text in as if it were a standard reason.
// Only 'other' accepts free text, and even then the backend requires that
// free text to be non-empty.
//
// `label` is the human-readable text that gets stored in
// `bookings.cancellation_reason` and included in the passenger's
// notification whenever a non-'other' category is chosen.
export const BOOKING_CANCELLATION_REASONS = [
  { value: 'passenger_requested', label: 'Passenger requested cancellation' },
  { value: 'could_not_reach', label: 'Passenger could not be reached' },
  { value: 'info_incorrect', label: 'Booking information is incorrect' },
  { value: 'safety_concern', label: 'Safety or trip-related concern' },
  { value: 'capacity_issue', label: 'Vehicle/trip capacity issue' },
  { value: 'other', label: 'Other' },
];

export const BOOKING_CANCELLATION_REASON_OTHER = 'other';

export function bookingCancellationReasonLabel(value) {
  return BOOKING_CANCELLATION_REASONS.find(r => r.value === value)?.label || value;
}
