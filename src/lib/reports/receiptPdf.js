import { PDFDocument, rgb } from 'pdf-lib';
import {
  COLOR_INK,
  COLOR_MUTED,
  COLOR_PRIMARY,
  COLOR_PRIMARY_DARK,
  COLOR_ACCENT,
  COLOR_BORDER,
  COLOR_ROW_ALT,
  COLOR_WHITE,
  COLOR_DANGER,
  COLOR_GREEN,
  loadReportFonts,
  formatGeneratedAt,
  formatPageLabel,
  drawDocumentFooter,
} from './documentStyle';

// ============================================================================
// Booking Receipt — client-side PDF generation.
//
// Reuses the exact PDF toolkit (pdf-lib) and brand palette already used for
// the Driver Booking Report (see ../reports/driverBookingReport.js) — no new
// PDF dependency is introduced. This is a NEW document (a one-booking
// receipt), not a duplicate of that report: the report is a multi-booking
// manifest for a driver's own records, this is a single booking's receipt
// for either party.
//
// Data in: whatever get_passenger_booking_detail() / get_driver_booking_detail()
// already returned to the caller (see database/booking_history_receipts.sql
// and lib/bookingDetails.js) — this module never queries Supabase itself and
// never receives more than what those ownership-checked RPCs already scoped
// to the signed-in user, so there is no way for a receipt to leak another
// user's booking.
//
// IMPORTANT — no invented payment confirmation: PamojaRide has no online
// payment/transaction table (see the booking/trips schema — only
// bookings.status / bookings.refund_status exist). This receipt therefore
// never claims money was "paid" or "successful" — it states the booking's
// actual status and fare amount, worded as a fare/booking record rather
// than a payment confirmation.
//
// Support footer: the footer's contact line comes from the centralized
// Support Contacts system (src/lib/support/supportContacts.js /
// database/admin_support_contacts_foundation.sql) — the same admin-managed
// email/phone/WhatsApp/Facebook/Twitter shown on the Help & Support pages
// (SupportContactsCard.jsx). Nothing is hardcoded here: the caller fetches
// the current contacts via fetchSupportContacts() and passes them in as
// `supportContacts`; this module passes them straight through to the
// shared drawDocumentFooter() helper (./documentStyle.js), which formats
// them (via formatSupportFooterLine) and draws whatever comes back,
// omitting any channel that isn't set up.
// ============================================================================

const PAGE_WIDTH = 595.28;  // A4 @ 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 44;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Brand palette shared with driverBookingReport.js now lives in
// ./documentStyle.js (imported above). COLOR_AMBER is unique to this
// document (refund-status note) so it stays local.
const COLOR_AMBER = rgb(0.573, 0.251, 0.055);     // #92400E

const BOOKING_STATUS_LABEL = {
  pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed',
  cancelled: 'Cancelled', no_show: 'No-show',
};
const TRIP_STATUS_LABEL = {
  scheduled: 'Scheduled', ongoing: 'Ongoing', completion_pending: 'Awaiting confirmation',
  completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired',
};
const REFUND_STATUS_LABEL = {
  not_applicable: null, pending: 'Refund pending review', processed: 'Refund processed', failed: 'Refund failed',
};

function statusColor(status) {
  if (status === 'cancelled' || status === 'no_show') return COLOR_DANGER;
  if (status === 'completed') return COLOR_GREEN;
  return COLOR_PRIMARY;
}

function fmtKES(amount) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount || 0);
}

function fmtDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// route_distance_km can be null (older trips, or a distance that couldn't be
// computed at creation time — see trip_location_route_validation.sql) — in
// that case the caller simply omits the row rather than showing "— km".
function fmtDistanceKm(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(1)} km`;
}

// driver_avg_rating / driver_rating_count come from get_passenger_booking_detail()
// / get_driver_booking_detail(), aggregated live from public.ratings — a
// driver with no qualifying ratings gets avg_rating = NULL, rating_count = 0.
// Per product decision this reads as "Not yet rated", never a fake "0.0".
// No star glyph: pdf-lib's standard Helvetica font uses WinAnsi encoding,
// which has no glyph for U+2605 and throws at render time — same reason
// routeText below spells out "->" instead of "→".
function formatDriverRatingLine(avgRating, ratingCount) {
  if (avgRating === null || avgRating === undefined) return 'Driver rating: Not yet rated';
  const count = Number(ratingCount) || 0;
  const countLabel = count === 1 ? '1 rating' : `${count} ratings`;
  return `Driver rating: ${Number(avgRating).toFixed(2)}/5 (${countLabel})`;
}

function truncateToWidth(text, font, size, maxWidth) {
  const str = String(text ?? '');
  if (font.widthOfTextAtSize(str, size) <= maxWidth) return str;
  let out = str;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/**
 * Builds the Booking Receipt PDF and returns it as a Uint8Array.
 *
 * @param {Object} params
 * @param {'passenger'|'driver'} params.portal
 * @param {Object} params.booking - row shaped like get_passenger_booking_detail()
 *   or get_driver_booking_detail()'s return type.
 * @param {string} params.viewerName - the signed-in user's own name (for the
 *   "Issued to" line), taken straight from their own profile.
 * @param {Object} [params.supportContacts] - the row resolved by
 *   fetchSupportContacts() (src/lib/support/supportContacts.js), i.e. the
 *   same centrally admin-managed support_email/support_phone/whatsapp_number/
 *   facebook_url/twitter_url used by SupportContactsCard.jsx. This module
 *   never fetches it itself (see file header) — the caller (currently
 *   BookingDetailsView.jsx) fetches once and passes the result straight
 *   through. Safe to omit or pass a fetch failure's fallback value: any
 *   missing/blank field is simply left out of the footer, and if every
 *   field is blank the footer falls back to a generic message rather than
 *   drawing anything broken.
 */
export async function buildBookingReceiptPdf({ portal, booking, viewerName, supportContacts }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`PamojaRide Receipt ${booking.booking_reference || ''}`.trim());
  pdfDoc.setAuthor('PamojaRide');
  pdfDoc.setSubject(`Booking receipt for ${booking.booking_reference || 'booking'}`);
  pdfDoc.setProducer('PamojaRide');

  const { regular, bold, italic } = await loadReportFonts(pdfDoc);

  const generatedAt = new Date();
  const receiptNo = `PR-RCPT-${(booking.booking_reference || booking.booking_id || '').toString().replace(/[^a-zA-Z0-9]/g, '').slice(-10).toUpperCase()}`;

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT;

  // ── header band ─────────────────────────────────────────────────────
  const bandHeight = 92;
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - bandHeight, width: PAGE_WIDTH, height: bandHeight, color: COLOR_PRIMARY_DARK });
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - bandHeight, width: PAGE_WIDTH, height: 4, color: COLOR_ACCENT });

  // Wordmark: "Pamoja" (white) + "Ride" (accent orange) — same two-tone
  // wordmark used everywhere else in the app; there is no separate raster
  // logo file in the project (see driverBookingReport.js for precedent).
  const wmSize = 22;
  const wmY = PAGE_HEIGHT - 42;
  page.drawText('Pamoja', { x: MARGIN, y: wmY, size: wmSize, font: bold, color: COLOR_WHITE });
  const pamojaW = bold.widthOfTextAtSize('Pamoja', wmSize);
  page.drawText('Ride', { x: MARGIN + pamojaW, y: wmY, size: wmSize, font: bold, color: COLOR_ACCENT });
  page.drawText('BOOKING RECEIPT', { x: MARGIN, y: wmY - 22, size: 12, font: bold, color: rgb(0.86, 0.94, 0.97) });

  const ridLabel = `Receipt ${receiptNo}`;
  const ridSize = 9;
  const ridW = regular.widthOfTextAtSize(ridLabel, ridSize);
  page.drawText(ridLabel, { x: PAGE_WIDTH - MARGIN - ridW, y: PAGE_HEIGHT - 30, size: ridSize, font: regular, color: rgb(0.86, 0.94, 0.97) });

  y = PAGE_HEIGHT - bandHeight - 26;

  // ── status ribbon ───────────────────────────────────────────────────
  const statusLabel = BOOKING_STATUS_LABEL[booking.booking_status] || booking.booking_status || '—';
  page.drawText(`Booking status: ${statusLabel}`, {
    x: MARGIN, y, size: 12, font: bold, color: statusColor(booking.booking_status),
  });
  const refundNote = REFUND_STATUS_LABEL[booking.refund_status];
  if (refundNote) {
    const rw = regular.widthOfTextAtSize(refundNote, 10);
    page.drawText(refundNote, { x: PAGE_WIDTH - MARGIN - rw, y: y + 1, size: 10, font: italic, color: COLOR_AMBER });
  }
  y -= 26;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: COLOR_BORDER });
  y -= 22;

  // ── meta block: booking reference / date / issued to / generated ──────
  const metaLines = [
    ['Booking Reference', booking.booking_reference || '—'],
    ['Booking Date', fmtDateTime(booking.booking_created_at)],
    ['Issued To', viewerName || (portal === 'passenger' ? 'Passenger' : 'Driver')],
    ['Generated', formatGeneratedAt(generatedAt)],
  ];
  const metaColWidth = CONTENT_WIDTH / 2;
  metaLines.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * metaColWidth;
    const rowY = y - row * 34;
    page.drawText(label.toUpperCase(), { x, y: rowY, size: 8, font: bold, color: COLOR_MUTED });
    page.drawText(truncateToWidth(value, regular, 11.5, metaColWidth - 10), { x, y: rowY - 15, size: 11.5, font: regular, color: COLOR_INK });
  });
  y -= 34 * Math.ceil(metaLines.length / 2) + 14;

  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: COLOR_BORDER });
  y -= 24;

  // ── Trip Information ───────────────────────────────────────────────
  page.drawText('TRIP INFORMATION', { x: MARGIN, y, size: 10.5, font: bold, color: COLOR_PRIMARY });
  y -= 18;
  // "->" rather than the unicode "→" arrow — pdf-lib's standard Helvetica
  // font uses WinAnsi encoding, which has no glyph for U+2192 and throws at
  // render time (confirmed by testing this module directly against
  // pdf-lib). driverBookingReport.js already made the same choice for
  // exactly this reason.
  const routeText = truncateToWidth(`${booking.origin || '—'}  ->  ${booking.destination || '—'}`, bold, 14, CONTENT_WIDTH);
  page.drawText(routeText, { x: MARGIN, y, size: 14, font: bold, color: COLOR_INK });
  y -= 20;

  const tripRows = [
    ['Departure', fmtDateTime(booking.departure_time)],
    ['Trip status', TRIP_STATUS_LABEL[booking.trip_status] || booking.trip_status || '—'],
    ['Vehicle', [booking.vehicle_make, booking.vehicle_model].filter(Boolean).join(' ') || '—'],
    ['Plate', booking.vehicle_plate || '—'],
  ];
  // route_distance_km is only appended when present — null/undefined
  // (older trips, or a distance OSRM couldn't compute) means the row is
  // omitted entirely rather than showing a placeholder.
  const distanceLabel = fmtDistanceKm(booking.route_distance_km);
  if (distanceLabel) {
    tripRows.push(['Distance', distanceLabel]);
  }
  tripRows.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * metaColWidth;
    const rowY = y - row * 30;
    page.drawText(label.toUpperCase(), { x, y: rowY, size: 8, font: bold, color: COLOR_MUTED });
    page.drawText(truncateToWidth(value, regular, 10.5, metaColWidth - 10), { x, y: rowY - 14, size: 10.5, font: regular, color: COLOR_INK });
  });
  y -= 30 * Math.ceil(tripRows.length / 2) + 8;

  const pickup = booking.booking_pickup_point || booking.trip_pickup_point;
  const dropoff = booking.booking_dropoff_point || booking.trip_dropoff_point;
  if (pickup || dropoff) {
    page.drawText(`Pickup: ${pickup || '—'}    Drop-off: ${dropoff || '—'}`, {
      x: MARGIN, y, size: 9.5, font: regular, color: COLOR_MUTED,
    });
    y -= 20;
  }

  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: COLOR_BORDER });
  y -= 24;

  // ── Counterpart (driver for passenger receipts, passenger for driver) ─
  const counterpartLabel = portal === 'passenger' ? 'DRIVER' : 'PASSENGER';
  const counterpartName = portal === 'passenger' ? booking.driver_name : booking.passenger_name;
  const counterpartPhone = portal === 'passenger' ? booking.driver_phone : booking.passenger_phone;
  page.drawText(counterpartLabel, { x: MARGIN, y, size: 10.5, font: bold, color: COLOR_PRIMARY });
  y -= 18;
  page.drawText(counterpartName || 'Not available', { x: MARGIN, y, size: 12.5, font: bold, color: COLOR_INK });
  y -= 15;
  page.drawText(counterpartPhone || '—', { x: MARGIN, y, size: 10, font: regular, color: COLOR_MUTED });
  y -= 15;

  // Driver rating: passenger receipts only. get_driver_booking_detail()
  // (driver portal) has never returned a passenger rating field, and this
  // change doesn't add one — only the driver's own rating is ever shown,
  // and only on the passenger side.
  if (portal === 'passenger') {
    page.drawText(
      formatDriverRatingLine(booking.driver_avg_rating, booking.driver_rating_count),
      { x: MARGIN, y, size: 10, font: regular, color: COLOR_MUTED }
    );
    y -= 15;
  }

  y -= 11;

  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: COLOR_BORDER });
  y -= 24;

  // ── Fare summary ────────────────────────────────────────────────────
  page.drawText('FARE SUMMARY', { x: MARGIN, y, size: 10.5, font: bold, color: COLOR_PRIMARY });
  y -= 20;

  const fareRowHeight = 20;
  const fareRows = [
    ['Seats booked', String(booking.seats_booked ?? '—')],
    ['Fare per seat', fmtKES(booking.price_per_seat_snapshot)],
  ];
  fareRows.forEach((row, i) => {
    if (i % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - 14, width: CONTENT_WIDTH, height: fareRowHeight, color: COLOR_ROW_ALT });
    }
    page.drawText(row[0], { x: MARGIN + 8, y: y - 8, size: 10.5, font: regular, color: COLOR_INK });
    const vw = regular.widthOfTextAtSize(row[1], 10.5);
    page.drawText(row[1], { x: PAGE_WIDTH - MARGIN - 8 - vw, y: y - 8, size: 10.5, font: regular, color: COLOR_INK });
    y -= fareRowHeight;
  });

  y -= 4;
  page.drawRectangle({ x: MARGIN, y: y - 30, width: CONTENT_WIDTH, height: 30, color: rgb(0.941, 0.980, 0.988) });
  page.drawRectangle({ x: MARGIN, y: y - 30, width: 3, height: 30, color: COLOR_PRIMARY });
  page.drawText('TOTAL FARE', { x: MARGIN + 14, y: y - 20, size: 11, font: bold, color: COLOR_INK });
  const totalText = fmtKES(booking.total_price);
  const totalW = bold.widthOfTextAtSize(totalText, 15);
  page.drawText(totalText, { x: PAGE_WIDTH - MARGIN - 14 - totalW, y: y - 21, size: 15, font: bold, color: COLOR_PRIMARY_DARK });
  y -= 44;

  if (booking.booking_status === 'cancelled') {
    page.drawText(
      truncateToWidth(
        `Cancelled ${fmtDateTime(booking.cancelled_at)}${booking.cancellation_reason ? ` — ${booking.cancellation_reason}` : ''}`,
        italic, 9, CONTENT_WIDTH
      ),
      { x: MARGIN, y, size: 9, font: italic, color: COLOR_MUTED }
    );
    y -= 18;
  }

  // ── honest disclaimer: no online payment system exists ────────────────
  page.drawText(
    'This receipt reflects the fare and status recorded for this booking in the PamojaRide system.',
    { x: MARGIN, y: 96, size: 8.5, font: italic, color: COLOR_MUTED }
  );
  page.drawText(
    'It is not a confirmation of payment made outside the app.',
    { x: MARGIN, y: 84, size: 8.5, font: italic, color: COLOR_MUTED }
  );

  // ── footer ──────────────────────────────────────────────────────────
  drawDocumentFooter({
    page,
    regularFont: regular,
    margin: MARGIN,
    contentWidth: CONTENT_WIDTH,
    pageLabel: formatPageLabel(1),
    supportContacts,
  });

  return pdfDoc.save();
}
