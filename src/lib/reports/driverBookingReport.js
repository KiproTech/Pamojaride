import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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

// Brand palette — matches src/styles/global.css (--primary / --accent / --text)
// so the report reads as the same product, not a generic template.
const COLOR_INK = rgb(0.06, 0.09, 0.16);        // #0F172A
const COLOR_MUTED = rgb(0.39, 0.45, 0.55);      // #64748B
const COLOR_PRIMARY = rgb(0.055, 0.455, 0.565); // #0E7490
const COLOR_PRIMARY_DARK = rgb(0.084, 0.369, 0.459); // #155E75
const COLOR_ACCENT = rgb(0.976, 0.451, 0.086);  // #F97316
const COLOR_BORDER = rgb(0.886, 0.910, 0.941);  // #E2E8F0
const COLOR_ROW_ALT = rgb(0.973, 0.980, 0.988); // #F8FAFC
const COLOR_WHITE = rgb(1, 1, 1);
const COLOR_DANGER = rgb(0.937, 0.267, 0.267);  // #EF4444
const COLOR_GREEN = rgb(0.086, 0.639, 0.290);   // #16A34A

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

function fmtDate(value) {
  return new Date(value).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortRef(id) {
  return id ? `TRIP-${id.slice(0, 8).toUpperCase()}` : '—';
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
 */
export async function buildDriverBookingReportPdf({ driverName, driverPhone, filterLabel, bookings }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('PamojaRide Driver Booking Report');
  pdfDoc.setAuthor('PamojaRide');
  pdfDoc.setSubject(`Driver booking report for ${driverName || 'driver'}`);
  pdfDoc.setProducer('PamojaRide');

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

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

    // Wordmark: "Pamoja" (white) + "Ride" (accent orange) — the same
    // two-tone wordmark used across the app's own headers/login pages,
    // there being no separate raster logo file in the project.
    const wmSize = isFirstPage ? 22 : 16;
    const wmY = PAGE_HEIGHT - (isFirstPage ? 42 : 32);
    page.drawText('Pamoja', { x: MARGIN, y: wmY, size: wmSize, font: bold, color: COLOR_WHITE });
    const pamojaW = bold.widthOfTextAtSize('Pamoja', wmSize);
    page.drawText('Ride', { x: MARGIN + pamojaW, y: wmY, size: wmSize, font: bold, color: COLOR_ACCENT });

    if (isFirstPage) {
      page.drawText('DRIVER BOOKING REPORT', {
        x: MARGIN, y: wmY - 22, size: 12, font: bold, color: rgb(0.86, 0.94, 0.97),
      });
    } else {
      page.drawText('Driver Booking Report (continued)', {
        x: MARGIN, y: wmY - 16, size: 9, font: regular, color: rgb(0.86, 0.94, 0.97),
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
    const footerY = 34;
    page.drawLine({ start: { x: MARGIN, y: footerY + 16 }, end: { x: PAGE_WIDTH - MARGIN, y: footerY + 16 }, thickness: 0.75, color: COLOR_BORDER });
    page.drawText('PamojaRide · Need help with a booking? support@pamojaride.co.ke', {
      x: MARGIN, y: footerY, size: 8.5, font: regular, color: COLOR_MUTED,
    });
    const pageLabel = `Page ${pageNum}`;
    const pw = regular.widthOfTextAtSize(pageLabel, 8.5);
    page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - pw, y: footerY, size: 8.5, font: regular, color: COLOR_MUTED });
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
    [`Generated`, fmtDate(generatedAt)],
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
    // ── trip section header (3 rows: route/status, pickup/departure, ref) ──
    ensureSpace(TRIP_BLOCK_HEIGHT + 18);
    page.drawRectangle({ x: MARGIN, y: y - TRIP_BLOCK_HEIGHT, width: CONTENT_WIDTH, height: TRIP_BLOCK_HEIGHT, color: rgb(0.941, 0.980, 0.988) });
    page.drawRectangle({ x: MARGIN, y: y - TRIP_BLOCK_HEIGHT, width: 3, height: TRIP_BLOCK_HEIGHT, color: COLOR_PRIMARY });

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

    page.drawText(shortRef(trip.trip_id), { x: MARGIN + 12, y: y - 45, size: 8, font: regular, color: COLOR_MUTED });

    y -= TRIP_BLOCK_HEIGHT + 14;

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
