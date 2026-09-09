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
  embedBrandLogo,
  drawBrandLogo,
  logoTextOffset,
} from './documentStyle';

// ============================================================================
// Driver Booking Report — client-side PDF generation.
//
// This runs entirely in the browser (no server/edge function involved): the
// caller (driver/Bookings.jsx) already has the driver's own bookings loaded
// via the get_driver_trip_bookings() RPC (see
// src/database/driver_booking_passenger_visibility.sql /
// driver_booking_report_fields.sql), which itself only ever returns rows
// where trips.driver_id = the calling driver. This module never queries
// Supabase itself and never receives more than what that RPC already
// scoped to the signed-in driver, so there's no additional way for a
// driver to end up with someone else's data in a report.
//
// Deliberately excluded: total_price / price_per_seat / any payment
// figures — the report is a booking/passenger manifest, not a financial
// statement, per the "no payment info" requirement.
// ============================================================================

const PAGE_WIDTH = 595.28;  // A4 @ 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Brand palette shared with receiptPdf.js now lives in ./documentStyle.js
// (imported above) so the report reads as the same product, not a generic
// template.

const BOOKING_STATUS_LABEL = {
  pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed',
  cancelled: 'Cancelled', no_show: 'No-show',
};
const TRIP_STATUS_LABEL = {
  scheduled: 'Scheduled', ongoing: 'Ongoing', completed: 'Completed',
  cancelled: 'Cancelled', expired: 'Expired',
};

function fmtDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortRef(id) {
  return id ? `TRIP-${id.slice(0, 8).toUpperCase()}` : '—';
}

// route_distance_km can still be null/undefined (older trips, or a distance
// that couldn't be computed at creation time — see
// trip_location_route_validation.sql). get_driver_trip_bookings() now
// selects this column (see database/driver_trip_bookings_route_distance.sql)
// so it's populated whenever it's available; either way the caller omits
// the row rather than showing a placeholder.
function fmtDistanceKm(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(1)} km`;
}

// Greedy word-wrap using actual glyph widths for the given font/size.
function wrapText(text, font, size, maxWidth) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
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
 * Builds the Driver Booking Report PDF and returns it as a Uint8Array.
 *
 * @param {Object} params
 * @param {string} params.driverName
 * @param {string} [params.driverPhone]
 * @param {string} [params.filterLabel] - human-readable description of the
 *   active filter this report reflects (e.g. "Confirmed bookings",
 *   "All bookings", "This trip only") so the document is honest about scope.
 * @param {Array}  params.bookings - rows shaped like get_driver_trip_bookings()'s
 *   return type (booking_reference, trip_id, passenger_name, passenger_phone, seats_booked,
 *   status, refund_status, cancellation_reason, cancelled_at, origin,
 *   destination, pickup_point, dropoff_point, departure_time, trip_status).
 *   An optional `route_distance_km` per row is rendered under Trip
 *   Information when present and simply omitted when null/undefined —
 *   get_driver_trip_bookings() selects this column as of
 *   database/driver_trip_bookings_route_distance.sql (see fmtDistanceKm
 *   above).
 * @param {Object} [params.supportContacts] - the row resolved by
 *   fetchSupportContacts() (src/lib/support/supportContacts.js), i.e. the
 *   same centrally admin-managed support_email/support_phone/whatsapp_number/
 *   facebook_url/twitter_url used by SupportContactsCard.jsx. This module
 *   never fetches it itself (see file header) — the caller (currently
 *   driver/Bookings.jsx) fetches once and passes the result straight
 *   through. Safe to omit or pass a fetch failure's fallback value: any
 *   missing/blank field is simply left out of the footer, and if every
 *   field is blank the footer falls back to a generic message rather than
 *   drawing anything broken.
 */
export async function buildDriverBookingReportPdf({ driverName, driverPhone, filterLabel, bookings, supportContacts }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('PamojaRide Driver Booking Report');
  pdfDoc.setAuthor('PamojaRide');
  pdfDoc.setSubject(`Driver booking report for ${driverName || 'driver'}`);
  pdfDoc.setProducer('PamojaRide');

  const { regular, bold, italic } = await loadReportFonts(pdfDoc);
  const logoImage = await embedBrandLogo(pdfDoc);

  const generatedAt = new Date();
  const reportId = `PR-RPT-${generatedAt.getFullYear()}${String(generatedAt.getMonth() + 1).padStart(2, '0')}${String(generatedAt.getDate()).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT;
  let pageNum = 1;
  const pages = [page];

  // ── header band (repeated, condensed, on every page) ──────────────────
  function drawHeader(isFirstPage) {
    const bandHeight = isFirstPage ? 92 : 56;
    page.drawRectangle({ x: 0, y: PAGE_HEIGHT - bandHeight, width: PAGE_WIDTH, height: bandHeight, color: COLOR_PRIMARY_DARK });
    page.drawRectangle({ x: 0, y: PAGE_HEIGHT - bandHeight, width: PAGE_WIDTH, height: 4, color: COLOR_ACCENT });

    // Logo glyph (in a white box) + "Pamoja" (white) / "Ride" (accent
    // orange) wordmark — same treatment as the app's own <Logo> component
    // (pages/Landing.jsx, reused by Sidebar.jsx and every auth page).
    // Falls back to the wordmark alone if the logo asset couldn't be loaded.
    const wmSize = isFirstPage ? 22 : 16;
    const wmY = PAGE_HEIGHT - (isFirstPage ? 42 : 32);
    const boxSize = isFirstPage ? 34 : 24;
    const textX = MARGIN + (logoImage ? logoTextOffset(boxSize, isFirstPage ? 10 : 8) : 0);
    drawBrandLogo({ page, logoImage, x: MARGIN, centerY: wmY + (isFirstPage ? 8 : 6), boxSize });
    page.drawText('Pamoja', { x: textX, y: wmY, size: wmSize, font: bold, color: COLOR_WHITE });
    const pamojaW = bold.widthOfTextAtSize('Pamoja', wmSize);
    page.drawText('Ride', { x: textX + pamojaW, y: wmY, size: wmSize, font: bold, color: COLOR_ACCENT });

    if (isFirstPage) {
      page.drawText('DRIVER BOOKING REPORT', {
        x: textX, y: wmY - 22, size: 12, font: bold, color: rgb(0.86, 0.94, 0.97),
      });
    } else {
      page.drawText('Driver Booking Report (continued)', {
        x: textX, y: wmY - 16, size: 9, font: regular, color: rgb(0.86, 0.94, 0.97),
      });
    }

    // Report id, top-right
    const ridLabel = `Report ${reportId}`;
    const ridSize = 9;
    const ridW = regular.widthOfTextAtSize(ridLabel, ridSize);
    page.drawText(ridLabel, {
      x: PAGE_WIDTH - MARGIN - ridW, y: PAGE_HEIGHT - (isFirstPage ? 30 : 24),
      size: ridSize, font: regular, color: rgb(0.86, 0.94, 0.97),
    });

    y = PAGE_HEIGHT - bandHeight - 20;
  }

  function drawFooter() {
    drawDocumentFooter({
      page,
      regularFont: regular,
      margin: MARGIN,
      contentWidth: CONTENT_WIDTH,
      pageLabel: formatPageLabel(pageNum),
      supportContacts,
    });
  }

  function newPage() {
    drawFooter();
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    pageNum += 1;
    drawHeader(false);
  }

  // If drawing `height` more points would run past the footer, starts a
  // fresh page first. `onBreak`, if given, re-draws whatever context
  // (e.g. the column header row) should repeat at the top of the new
  // page so a table split across pages stays readable.
  function ensureSpace(height, onBreak) {
    if (y - height < 60) {
      newPage();
      onBreak?.();
    }
  }

  drawHeader(true);

  // ── meta block ──────────────────────────────────────────────────────
  ensureSpace(70);
  const metaLines = [
    [`Driver`, driverName || '—'],
    [`Contact`, driverPhone || '—'],
    [`Generated`, formatGeneratedAt(generatedAt)],
    [`Scope`, filterLabel || 'All bookings'],
  ];
  const metaColWidth = CONTENT_WIDTH / 2;
  metaLines.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * metaColWidth;
    const rowY = y - row * 32;
    page.drawText(label.toUpperCase(), { x, y: rowY, size: 8, font: bold, color: COLOR_MUTED });
    page.drawText(truncateToWidth(value, regular, 11, metaColWidth - 10), { x, y: rowY - 14, size: 11, font: regular, color: COLOR_INK });
  });
  y -= 32 * Math.ceil(metaLines.length / 2) + 14;

  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: COLOR_BORDER });
  y -= 22;

  // ── group bookings by trip ──────────────────────────────────────────
  const tripGroups = new Map();
  for (const b of bookings) {
    if (!tripGroups.has(b.trip_id)) {
      tripGroups.set(b.trip_id, {
        trip_id: b.trip_id, origin: b.origin, destination: b.destination,
        pickup_point: b.pickup_point, dropoff_point: b.dropoff_point,
        departure_time: b.departure_time, trip_status: b.trip_status,
        // Optional — present whenever the trip has a computed distance
        // (see fmtDistanceKm's note above). Same value on every booking
        // row for the same trip, so the first row seen wins.
        route_distance_km: b.route_distance_km,
        rows: [],
      });
    }
    tripGroups.get(b.trip_id).rows.push(b);
  }
  const trips = Array.from(tripGroups.values()).sort(
    (a, b) => new Date(b.departure_time) - new Date(a.departure_time)
  );

  if (trips.length === 0) {
    ensureSpace(60);
    page.drawText('No bookings match this report.', { x: MARGIN, y, size: 12, font: italic, color: COLOR_MUTED });
    y -= 20;
  }

  const COL = {
    num: MARGIN,
    passenger: MARGIN + 24,
    phone: MARGIN + 160,
    ref: MARGIN + 258,
    seats: MARGIN + 352,
    status: MARGIN + 392,
  };
  const NOTE_INDENT = MARGIN + 26;

  const TRIP_BLOCK_HEIGHT = 56;
  const LEFT_COL_WIDTH = CONTENT_WIDTH * 0.6 - 20; // left-aligned text budget
  const RIGHT_COL_WIDTH = CONTENT_WIDTH * 0.4 - 20; // right-aligned text budget

  for (const trip of trips) {
    // ── trip section header (route/status, pickup/departure, [distance], ref) ──
    // Block height grows by one line only when a distance is available for
    // this trip — with no distance (the common case today, see the
    // fmtDistanceKm note above), the block is identical to before.
    const distanceLabel = fmtDistanceKm(trip.route_distance_km);
    const hasDistance = Boolean(distanceLabel);
    const blockHeight = TRIP_BLOCK_HEIGHT + (hasDistance ? 14 : 0);

    ensureSpace(blockHeight + 18);
    page.drawRectangle({ x: MARGIN, y: y - blockHeight, width: CONTENT_WIDTH, height: blockHeight, color: rgb(0.941, 0.980, 0.988) });
    page.drawRectangle({ x: MARGIN, y: y - blockHeight, width: 3, height: blockHeight, color: COLOR_PRIMARY });

    const routeText = truncateToWidth(`${trip.origin || '—'}  ->  ${trip.destination || '—'}`, bold, 12, LEFT_COL_WIDTH);
    page.drawText(routeText, { x: MARGIN + 12, y: y - 16, size: 12, font: bold, color: COLOR_INK });

    const tripStatusLabel = TRIP_STATUS_LABEL[trip.trip_status] || trip.trip_status || '—';
    const tsColor = trip.trip_status === 'cancelled' ? COLOR_DANGER
      : trip.trip_status === 'completed' ? COLOR_GREEN
      : COLOR_PRIMARY;
    const tsText = `Trip: ${tripStatusLabel}`;
    const tsW = bold.widthOfTextAtSize(tsText, 9);
    page.drawText(tsText, { x: PAGE_WIDTH - MARGIN - 12 - tsW, y: y - 16, size: 9, font: bold, color: tsColor });

    const pickupLine = truncateToWidth(
      `Pickup: ${trip.pickup_point || '—'}   Drop-off: ${trip.dropoff_point || '—'}`,
      regular, 9, LEFT_COL_WIDTH
    );
    page.drawText(pickupLine, { x: MARGIN + 12, y: y - 31, size: 9, font: regular, color: COLOR_INK });

    const departureText = fmtDateTime(trip.departure_time);
    const depW = regular.widthOfTextAtSize(departureText, 9);
    page.drawText(departureText, { x: PAGE_WIDTH - MARGIN - 12 - depW, y: y - 31, size: 9, font: regular, color: COLOR_MUTED });

    // Distance line only occupies its own row when present; the ref line
    // below shifts down 14pt to make room, otherwise it stays exactly
    // where it was (y - 45).
    if (hasDistance) {
      page.drawText(`Distance: ${distanceLabel}`, { x: MARGIN + 12, y: y - 45, size: 9, font: regular, color: COLOR_INK });
    }
    const refY = hasDistance ? y - 59 : y - 45;
    page.drawText(shortRef(trip.trip_id), { x: MARGIN + 12, y: refY, size: 8, font: regular, color: COLOR_MUTED });

    y -= blockHeight + 14;

    // ── table header row (also re-drawn via onBreak if the table splits) ──
    function drawColumnHeader() {
      page.drawText(`${trip.origin || '—'} -> ${trip.destination || '—'} (continued)`, {
        x: MARGIN, y, size: 8.5, font: italic, color: COLOR_MUTED,
      });
      y -= 14;
      page.drawText('#', { x: COL.num, y, size: 8.5, font: bold, color: COLOR_MUTED });
      page.drawText('PASSENGER', { x: COL.passenger, y, size: 8.5, font: bold, color: COLOR_MUTED });
      page.drawText('PHONE', { x: COL.phone, y, size: 8.5, font: bold, color: COLOR_MUTED });
      page.drawText('BOOKING REF', { x: COL.ref, y, size: 8.5, font: bold, color: COLOR_MUTED });
      page.drawText('SEATS', { x: COL.seats, y, size: 8.5, font: bold, color: COLOR_MUTED });
      page.drawText('STATUS', { x: COL.status, y, size: 8.5, font: bold, color: COLOR_MUTED });
      y -= 8;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: COLOR_BORDER });
      y -= 14;
    }

    ensureSpace(24);
    page.drawText('#', { x: COL.num, y, size: 8.5, font: bold, color: COLOR_MUTED });
    page.drawText('PASSENGER', { x: COL.passenger, y, size: 8.5, font: bold, color: COLOR_MUTED });
    page.drawText('PHONE', { x: COL.phone, y, size: 8.5, font: bold, color: COLOR_MUTED });
    page.drawText('BOOKING REF', { x: COL.ref, y, size: 8.5, font: bold, color: COLOR_MUTED });
    page.drawText('SEATS', { x: COL.seats, y, size: 8.5, font: bold, color: COLOR_MUTED });
    page.drawText('STATUS', { x: COL.status, y, size: 8.5, font: bold, color: COLOR_MUTED });
    y -= 8;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: COLOR_BORDER });
    y -= 14;

    trip.rows.forEach((b, idx) => {
      const hasNote = b.status === 'cancelled' && (b.cancellation_reason || b.cancelled_at);
      const rowHeight = 16 + (hasNote ? 12 : 0);
      ensureSpace(rowHeight + 6, drawColumnHeader);

      if (idx % 2 === 1) {
        page.drawRectangle({ x: MARGIN, y: y - rowHeight + 12, width: CONTENT_WIDTH, height: rowHeight, color: COLOR_ROW_ALT });
      }

      page.drawText(String(idx + 1), { x: COL.num, y, size: 9.5, font: regular, color: COLOR_INK });
      page.drawText(truncateToWidth(b.passenger_name || 'Unknown passenger', regular, 9.5, COL.phone - COL.passenger - 8), {
        x: COL.passenger, y, size: 9.5, font: regular, color: COLOR_INK,
      });
      page.drawText(truncateToWidth(b.passenger_phone || '—', regular, 9, COL.ref - COL.phone - 8), {
        x: COL.phone, y, size: 9, font: regular, color: COLOR_INK,
      });
      page.drawText(b.booking_reference || '—', { x: COL.ref, y, size: 9, font: regular, color: COLOR_INK });
      page.drawText(String(b.seats_booked ?? '—'), { x: COL.seats, y, size: 9.5, font: regular, color: COLOR_INK });

      const statusLabel = BOOKING_STATUS_LABEL[b.status] || b.status || '—';
      const statusColor = b.status === 'cancelled' || b.status === 'no_show' ? COLOR_DANGER
        : b.status === 'completed' ? COLOR_GREEN
        : COLOR_PRIMARY;
      page.drawText(statusLabel, { x: COL.status, y, size: 9, font: bold, color: statusColor });

      y -= 14;

      if (hasNote) {
        const bits = [];
        if (b.cancelled_at) bits.push(`cancelled ${fmtDateTime(b.cancelled_at)}`);
        if (b.cancellation_reason) bits.push(b.cancellation_reason);
        const note = truncateToWidth(bits.join(' — '), italic, 8.5, CONTENT_WIDTH - (NOTE_INDENT - MARGIN));
        page.drawText(note, { x: NOTE_INDENT, y, size: 8.5, font: italic, color: COLOR_MUTED });
        y -= 12;
      }
    });

    y -= 12;
  }

  drawFooter();

  const bytes = await pdfDoc.save();
  return bytes;
}

/**
 * Triggers a browser download of the generated PDF bytes.
 */
export function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
