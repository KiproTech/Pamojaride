// Fixed set of driver trip-cancellation reasons.
//
// `value` is the category key sent to the `cancel_trip` RPC as
// `p_reason_category` — it is validated against this same fixed list on the
// backend (see src/database/driver_trip_cancellation_reasons.sql), so a
// driver can never sneak arbitrary text in as if it were a standard reason.
// Only 'other' accepts free text, and even then the backend requires that
// free text to be non-empty.
//
// `label` is the human-readable text that gets stored in
// `trips.cancellation_reason` (and copied onto affected bookings /
// passenger notifications) whenever a non-'other' category is chosen.
export const CANCELLATION_REASONS = [
  { value: 'vehicle_problem', label: 'Vehicle problem/breakdown' },
  { value: 'personal_emergency', label: 'Personal emergency' },
  { value: 'change_of_plans', label: 'Change of plans' },
  { value: 'weather_conditions', label: 'Road/weather conditions' },
  { value: 'unable_to_continue', label: 'Unable to continue the trip' },
  { value: 'other', label: 'Other' },
];

export const CANCELLATION_REASON_OTHER = 'other';

export function cancellationReasonLabel(value) {
  return CANCELLATION_REASONS.find(r => r.value === value)?.label || value;
}
