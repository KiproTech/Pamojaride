import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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
// ============================================================================

const PAGE_WIDTH = 595.28;  // A4 @ 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 44;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Brand palette — matches src/styles/global.css / driverBookingReport.js
const COLOR_INK = rgb(0.06, 0.09, 0.16);          // #0F172A
const COLOR_MUTED = rgb(0.39, 0.45, 0.55);        // #64748B
const COLOR_PRIMARY = rgb(0.055, 0.455, 0.565);   // #0E7490
const COLOR_PRIMARY_DARK = rgb(0.084, 0.369, 0.459); // #155E75
const COLOR_ACCENT = rgb(0.976, 0.451, 0.086);    // #F97316
const COLOR_BORDER = rgb(0.886, 0.910, 0.941);    // #E2E8F0
const COLOR_ROW_ALT = rgb(0.973, 0.980, 0.988);   // #F8FAFC
const COLOR_WHITE = rgb(1, 1, 1);
const COLOR_DANGER = rgb(0.937, 0.267, 0.267);    // #EF4444
const COLOR_GREEN = rgb(0.086, 0.639, 0.290);     // #16A34A
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
 */
export async function buildBookingReceiptPdf({ portal, booking, viewerName }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`PamojaRide Receipt ${booking.booking_reference || ''}`.trim());
  pdfDoc.setAuthor('PamojaRide');
  pdfDoc.setSubject(`Booking receipt for ${booking.booking_reference || 'booking'}`);
  pdfDoc.setProducer('PamojaRide');

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

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
    ['Generated', fmtDateTime(generatedAt)],
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
  y -= 26;

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
  const footerY = 34;
  page.drawLine({ start: { x: MARGIN, y: footerY + 16 }, end: { x: PAGE_WIDTH - MARGIN, y: footerY + 16 }, thickness: 0.75, color: COLOR_BORDER });
  page.drawText('PamojaRide · Need help with a booking? support@pamojaride.co.ke', {
    x: MARGIN, y: footerY, size: 8.5, font: regular, color: COLOR_MUTED,
  });
  const pageLabel = 'Page 1';
  const pw = regular.widthOfTextAtSize(pageLabel, 8.5);
  page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - pw, y: footerY, size: 8.5, font: regular, color: COLOR_MUTED });

  return pdfDoc.save();
}
