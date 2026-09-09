import { PDFDocument, rgb } from 'pdf-lib';
import {
  COLOR_INK, COLOR_MUTED, COLOR_PRIMARY, COLOR_PRIMARY_DARK, COLOR_ACCENT,
  COLOR_BORDER, COLOR_ROW_ALT, COLOR_WHITE, COLOR_DANGER, COLOR_GREEN,
  loadReportFonts, formatGeneratedAt, embedBrandLogo, drawBrandLogo,
  logoTextOffset, createPagedReport,
} from './documentStyle';

// ============================================================================
// Admin Analytics — downloadable PDF reports (Platform Summary, Driver
// Performance, Trip Performance, Booking Report). Same PDF toolkit
// (pdf-lib), brand palette, fonts, footer, and logo treatment as
// receiptPdf.js / driverBookingReport.js (via ./documentStyle.js) — no new
// PDF dependency, and every table is built from rows the caller already
// fetched from the admin_performance_analytics.sql RPCs (this module never
// queries Supabase itself), so a report can never contain more than what
// those admin-only, read-only RPCs already returned.
// ============================================================================

const PAGE_WIDTH = 841.89;  // A4 landscape @ 72dpi — these are wide tables
const PAGE_HEIGHT = 595.28;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BAND_HEIGHT_FIRST = 78;
const BAND_HEIGHT_NEXT = 48;

function truncateToWidth(text, font, size, maxWidth) {
  const str = String(text ?? '—');
  if (font.widthOfTextAtSize(str, size) <= maxWidth) return str;
  let out = str;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function fmtKES(amount) {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount);
}

function fmtDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtPercent(value) {
  return value === null || value === undefined ? 'Not enough data' : `${value}%`;
}

function fmtNumber(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function fmtRating(avg, count) {
  if (!count) return 'No ratings yet';
  return `${avg} ★ (${count})`;
}

const VERIFICATION_LABEL = {
  verified: 'Verified', pending_verification: 'Pending', under_review: 'Under review', rejected: 'Rejected',
};
const ACCOUNT_STATUS_LABEL = { active: 'Active', suspended: 'Suspended', banned: 'Banned' };
const TRIP_STATUS_LABEL = {
  scheduled: 'Scheduled', ongoing: 'Ongoing', completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired',
};
const BOOKING_STATUS_LABEL = {
  pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};

// ── shared header/meta building blocks ─────────────────────────────────────

function makeHeaderDrawer({ regular, bold, logoImage, docLabel, reportId }) {
  return function drawHeader({ page, pageNum, isFirstPage }) {
    const bandHeight = isFirstPage ? BAND_HEIGHT_FIRST : BAND_HEIGHT_NEXT;
    page.drawRectangle({ x: 0, y: PAGE_HEIGHT - bandHeight, width: PAGE_WIDTH, height: bandHeight, color: COLOR_PRIMARY_DARK });
    page.drawRectangle({ x: 0, y: PAGE_HEIGHT - bandHeight, width: PAGE_WIDTH, height: 4, color: COLOR_ACCENT });

    const wmSize = isFirstPage ? 20 : 15;
    const wmY = PAGE_HEIGHT - (isFirstPage ? 34 : 26);
    const boxSize = isFirstPage ? 30 : 22;
    const textX = MARGIN + (logoImage ? logoTextOffset(boxSize, 8) : 0);
    drawBrandLogo({ page, logoImage, x: MARGIN, centerY: wmY + 7, boxSize });
    page.drawText('Pamoja', { x: textX, y: wmY, size: wmSize, font: bold, color: COLOR_WHITE });
    const pamojaW = bold.widthOfTextAtSize('Pamoja', wmSize);
    page.drawText('Ride', { x: textX + pamojaW, y: wmY, size: wmSize, font: bold, color: COLOR_ACCENT });

    if (isFirstPage) {
      page.drawText(docLabel, { x: textX, y: wmY - 20, size: 11, font: bold, color: rgb(0.86, 0.94, 0.97) });
    } else {
      page.drawText(`${docLabel} (continued)`, { x: textX, y: wmY - 14, size: 8.5, font: regular, color: rgb(0.86, 0.94, 0.97) });
    }

    const ridLabel = `Report ${reportId}  ·  Page ${pageNum}`;
    const ridSize = 8.5;
    const ridW = regular.widthOfTextAtSize(ridLabel, ridSize);
    page.drawText(ridLabel, {
      x: PAGE_WIDTH - MARGIN - ridW, y: PAGE_HEIGHT - (isFirstPage ? 24 : 20),
      size: ridSize, font: regular, color: rgb(0.86, 0.94, 0.97),
    });

    return PAGE_HEIGHT - bandHeight - 20;
  };
}

function drawMetaBlock({ pager, regular, bold, lines }) {
  pager.ensureSpace(50);
  const page = pager.getPage();
  let y = pager.getY();
  const colWidth = CONTENT_WIDTH / lines.length > 160 ? CONTENT_WIDTH / lines.length : CONTENT_WIDTH / 2;
  const perRow = Math.max(1, Math.floor(CONTENT_WIDTH / colWidth));
  lines.forEach(([label, value], i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = MARGIN + col * colWidth;
    const rowY = y - row * 32;
    page.drawText(label.toUpperCase(), { x, y: rowY, size: 7.5, font: bold, color: COLOR_MUTED });
    page.drawText(truncateToWidth(value, regular, 11, colWidth - 10), { x, y: rowY - 14, size: 11, font: regular, color: COLOR_INK });
  });
  y -= 32 * Math.ceil(lines.length / perRow) + 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: COLOR_BORDER });
  y -= 18;
  pager.setY(y);
}

function drawSectionTitle({ pager, bold, title }) {
  pager.ensureSpace(28);
  const page = pager.getPage();
  const y = pager.getY();
  page.drawText(title, { x: MARGIN, y, size: 13, font: bold, color: COLOR_INK });
  pager.setY(y - 22);
}

/** Small KPI stat grid — used on the Platform Summary report. */
function drawStatGrid({ pager, regular, bold, stats, perRow = 4 }) {
  const cellWidth = CONTENT_WIDTH / perRow;
  const cellHeight = 46;
  for (let i = 0; i < stats.length; i += perRow) {
    pager.ensureSpace(cellHeight + 8);
    const page = pager.getPage();
    const y = pager.getY();
    const rowStats = stats.slice(i, i + perRow);
    rowStats.forEach(([label, value], j) => {
      const x = MARGIN + j * cellWidth;
      page.drawRectangle({ x, y: y - cellHeight, width: cellWidth - 10, height: cellHeight, color: COLOR_ROW_ALT, borderColor: COLOR_BORDER, borderWidth: 1 });
      page.drawText(truncateToWidth(String(value), bold, 16, cellWidth - 24), { x: x + 10, y: y - 22, size: 16, font: bold, color: COLOR_PRIMARY });
      page.drawText(truncateToWidth(label, regular, 8, cellWidth - 24), { x: x + 10, y: y - 38, size: 8, font: regular, color: COLOR_MUTED });
    });
    pager.setY(y - cellHeight - 10);
  }
}

/**
 * Generic striped table with a repeating column-header row across page
 * breaks (via pager.ensureSpace's onBreak).
 *
 * @param {Array<{label: string, width: number, align?: 'left'|'right', format: (row) => string, color?: (row) => import('pdf-lib').Color}>} columns
 */
function drawTable({ pager, regular, bold, columns, rows, emptyMessage, italic }) {
  const ROW_HEIGHT = 22;
  const HEADER_HEIGHT = 22;

  function drawColumnHeader() {
    const page = pager.getPage();
    const y = pager.getY();
    page.drawRectangle({ x: MARGIN, y: y - HEADER_HEIGHT, width: CONTENT_WIDTH, height: HEADER_HEIGHT, color: COLOR_PRIMARY_DARK });
    let x = MARGIN;
    columns.forEach((col) => {
      const tx = col.align === 'right' ? x + col.width - 8 - bold.widthOfTextAtSize(col.label, 8.5) : x + 8;
      page.drawText(col.label, { x: tx, y: y - 15, size: 8.5, font: bold, color: COLOR_WHITE });
      x += col.width;
    });
    pager.setY(y - HEADER_HEIGHT);
  }

  pager.ensureSpace(HEADER_HEIGHT + ROW_HEIGHT);
  drawColumnHeader();

  if (rows.length === 0) {
    pager.ensureSpace(30);
    const page = pager.getPage();
    const y = pager.getY();
    page.drawText(emptyMessage || 'No data for this period.', { x: MARGIN, y: y - 18, size: 10.5, font: italic, color: COLOR_MUTED });
    pager.setY(y - 30);
    return;
  }

  rows.forEach((row, i) => {
    pager.ensureSpace(ROW_HEIGHT, drawColumnHeader);
    const page = pager.getPage();
    const y = pager.getY();
    if (i % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: CONTENT_WIDTH, height: ROW_HEIGHT, color: COLOR_ROW_ALT });
    }
    let x = MARGIN;
    columns.forEach((col) => {
      const text = truncateToWidth(col.format(row), regular, 9, col.width - 16);
      const color = col.color ? col.color(row) : COLOR_INK;
      const tw = regular.widthOfTextAtSize(text, 9);
      const tx = col.align === 'right' ? x + col.width - 8 - tw : x + 8;
      page.drawText(text, { x: tx, y: y - 15, size: 9, font: regular, color });
      x += col.width;
    });
    pager.setY(y - ROW_HEIGHT);
  });
  pager.setY(pager.getY() - 8);
}

async function startReport({ title, subject, docLabel, supportContacts }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`PamojaRide — ${title}`);
  pdfDoc.setAuthor('PamojaRide');
  pdfDoc.setSubject(subject);
  pdfDoc.setProducer('PamojaRide');

  const { regular, bold, italic } = await loadReportFonts(pdfDoc);
  const logoImage = await embedBrandLogo(pdfDoc);
  const generatedAt = new Date();
  const reportId = `PR-ADM-${generatedAt.getFullYear()}${String(generatedAt.getMonth() + 1).padStart(2, '0')}${String(generatedAt.getDate()).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const drawHeader = makeHeaderDrawer({ regular, bold, logoImage, docLabel, reportId });
  const pager = createPagedReport({
    pdfDoc, pageWidth: PAGE_WIDTH, pageHeight: PAGE_HEIGHT, margin: MARGIN,
    contentWidth: CONTENT_WIDTH, regularFont: regular, drawHeader, supportContacts,
  });

  return { pdfDoc, regular, bold, italic, pager, generatedAt, reportId };
}

// ============================================================================
// 1. Platform Summary Report
// ============================================================================

/**
 * @param {Object} params
 * @param {Object} params.overview - fetchPlatformOverview()'s result
 * @param {Object} params.tripPerformance - fetchTripPerformance()'s result
 * @param {Object} params.bookingPerformance - fetchBookingPerformance()'s result
 * @param {number} params.driverCount - drivers with activity in the period (fetchDriverPerformance().length)
 * @param {string} params.periodLabel - e.g. "Last 30 days"
 * @param {string} [params.adminName] - the generating admin's own name
 * @param {Object} [params.supportContacts]
 */
export async function buildPlatformSummaryReportPdf({
  overview, tripPerformance, bookingPerformance, driverCount, periodLabel, adminName, supportContacts,
}) {
  const { regular, bold, pager, generatedAt, pdfDoc } = await startReport({
    title: 'Platform Summary Report', subject: `Platform summary for ${periodLabel}`, docLabel: 'PLATFORM SUMMARY REPORT', supportContacts,
  });

  drawMetaBlock({
    pager, regular, bold,
    lines: [
      ['Report period', periodLabel],
      ['Generated', formatGeneratedAt(generatedAt)],
      ['Generated by', adminName || 'Administrator'],
      ['Scope', 'Platform-wide'],
    ],
  });

  drawSectionTitle({ pager, bold, title: 'Platform statistics (all-time)' });
  drawStatGrid({
    pager, regular, bold,
    stats: [
      ['Total registered users', fmtNumber(overview?.total_users)],
      ['Total passengers', fmtNumber(overview?.total_passengers)],
      ['Total drivers', fmtNumber(overview?.total_drivers)],
      ['Verified drivers', fmtNumber(overview?.verified_drivers)],
      ['Pending driver verifications', fmtNumber(overview?.pending_driver_verifications)],
      ['Suspended accounts', fmtNumber(overview?.suspended_accounts)],
      ['Banned accounts', fmtNumber(overview?.banned_accounts)],
      ['Total trips (all-time)', fmtNumber(overview?.total_trips)],
    ],
  });

  drawSectionTitle({ pager, bold, title: `Trip statistics (${periodLabel})` });
  drawStatGrid({
    pager, regular, bold,
    stats: [
      ['Trips created', fmtNumber(tripPerformance?.trips_created)],
      ['Trips completed', fmtNumber(tripPerformance?.trips_completed)],
      ['Trips cancelled', fmtNumber(tripPerformance?.trips_cancelled)],
      ['Currently active (of these)', fmtNumber(tripPerformance?.trips_active)],
      ['Completion rate', fmtPercent(tripPerformance?.completion_rate)],
      ['Booking rate', fmtPercent(tripPerformance?.booking_rate)],
      ['Avg bookings / trip', tripPerformance?.avg_bookings_per_trip ?? 'Not enough data'],
      ['Total bookings on these trips', fmtNumber(tripPerformance?.total_bookings)],
    ],
  });

  drawSectionTitle({ pager, bold, title: `Booking statistics (${periodLabel})` });
  drawStatGrid({
    pager, regular, bold,
    stats: [
      ['Total bookings', fmtNumber(bookingPerformance?.total_bookings)],
      ['Completed', fmtNumber(bookingPerformance?.completed_bookings)],
      ['Cancelled', fmtNumber(bookingPerformance?.cancelled_bookings)],
      ['Active (pending/confirmed)', fmtNumber(bookingPerformance?.active_bookings)],
      ['No-shows', fmtNumber(bookingPerformance?.no_show_bookings)],
      ['Completion rate', fmtPercent(bookingPerformance?.completion_rate)],
      ['Repeat booking rate', fmtPercent(bookingPerformance?.repeat_booking_rate)],
      ['Unique passengers who booked', fmtNumber(bookingPerformance?.unique_passengers)],
    ],
  });

  drawSectionTitle({ pager, bold, title: `Driver statistics (${periodLabel})` });
  drawStatGrid({
    pager, regular, bold, perRow: 2,
    stats: [
      ['Drivers with activity in this period', fmtNumber(driverCount)],
      ['Verified drivers (all-time)', fmtNumber(overview?.verified_drivers)],
    ],
  });

  pager.finish();
  return pdfDoc.save();
}

// ============================================================================
// 2. Driver Performance Report
// ============================================================================

/** @param {Object} params @param {Array} params.drivers - fetchDriverPerformance()'s rows @param {string} params.periodLabel */
export async function buildDriverPerformanceReportPdf({ drivers, periodLabel, adminName, supportContacts }) {
  const { regular, bold, italic, pager, generatedAt, pdfDoc } = await startReport({
    title: 'Driver Performance Report', subject: `Driver performance for ${periodLabel}`, docLabel: 'DRIVER PERFORMANCE REPORT', supportContacts,
  });

  drawMetaBlock({
    pager, regular, bold,
    lines: [
      ['Report period', periodLabel],
      ['Generated', formatGeneratedAt(generatedAt)],
      ['Generated by', adminName || 'Administrator'],
      ['Drivers listed', String(drivers.length)],
    ],
  });

  drawTable({
    pager, regular, bold, italic,
    emptyMessage: 'No drivers had trip activity in this period.',
    columns: [
      { label: 'Driver', width: 150, format: r => r.driver_name || '—' },
      { label: 'Verification', width: 90, format: r => VERIFICATION_LABEL[r.verification_status] || r.verification_status || '—' },
      { label: 'Account', width: 80, format: r => ACCOUNT_STATUS_LABEL[r.account_status] || r.account_status || '—' },
      { label: 'Trips', width: 60, align: 'right', format: r => fmtNumber(r.trips_created) },
      { label: 'Completed', width: 80, align: 'right', format: r => fmtNumber(r.trips_completed) },
      { label: 'Cancelled', width: 80, align: 'right', format: r => fmtNumber(r.trips_cancelled) },
      { label: 'Bookings', width: 80, align: 'right', format: r => fmtNumber(r.bookings_received) },
      { label: 'Bookings completed', width: 110, align: 'right', format: r => fmtNumber(r.bookings_completed) },
      { label: 'Rating', width: 122, align: 'right', format: r => fmtRating(r.avg_rating, r.rating_count) },
    ],
    rows: drivers,
  });

  pager.finish();
  return pdfDoc.save();
}

// ============================================================================
// 3. Trip Performance Report
// ============================================================================

/** @param {Object} params @param {Array} params.trips - fetchTripPerformanceReport()'s rows @param {string} params.periodLabel */
export async function buildTripPerformanceReportPdf({ trips, periodLabel, adminName, supportContacts }) {
  const { regular, bold, italic, pager, generatedAt, pdfDoc } = await startReport({
    title: 'Trip Performance Report', subject: `Trip performance for ${periodLabel}`, docLabel: 'TRIP PERFORMANCE REPORT', supportContacts,
  });

  drawMetaBlock({
    pager, regular, bold,
    lines: [
      ['Report period', periodLabel],
      ['Generated', formatGeneratedAt(generatedAt)],
      ['Generated by', adminName || 'Administrator'],
      ['Trips listed', String(trips.length)],
    ],
  });

  drawTable({
    pager, regular, bold, italic,
    emptyMessage: 'No trips were created in this period.',
    columns: [
      { label: 'Driver', width: 110, format: r => r.driver_name || '—' },
      { label: 'Route', width: 190, format: r => `${r.origin || '—'} -> ${r.destination || '—'}` },
      { label: 'Departure', width: 110, format: r => fmtDateTime(r.departure_time) },
      {
        label: 'Status', width: 75, format: r => TRIP_STATUS_LABEL[r.status] || r.status || '—',
        color: r => (r.status === 'cancelled' || r.status === 'expired' ? COLOR_DANGER : r.status === 'completed' ? COLOR_GREEN : COLOR_INK),
      },
      { label: 'Seats', width: 55, align: 'right', format: r => `${(r.total_seats ?? 0) - (r.available_seats ?? 0)}/${r.total_seats ?? '—'}` },
      { label: 'Bookings', width: 65, align: 'right', format: r => fmtNumber(r.bookings_count) },
      { label: 'Completed', width: 70, align: 'right', format: r => fmtNumber(r.completed_bookings_count) },
      { label: 'Cancelled', width: 65, align: 'right', format: r => fmtNumber(r.cancelled_bookings_count) },
      { label: 'Created', width: 90, align: 'right', format: r => fmtDate(r.created_at) },
    ],
    rows: trips,
  });

  pager.finish();
  return pdfDoc.save();
}

// ============================================================================
// 4. Booking Report
// ============================================================================

/** @param {Object} params @param {Array} params.bookings - fetchBookingReport()'s rows @param {string} params.periodLabel */
export async function buildBookingReportPdf({ bookings, periodLabel, adminName, supportContacts }) {
  const { regular, bold, italic, pager, generatedAt, pdfDoc } = await startReport({
    title: 'Booking Report', subject: `Booking report for ${periodLabel}`, docLabel: 'BOOKING REPORT', supportContacts,
  });

  drawMetaBlock({
    pager, regular, bold,
    lines: [
      ['Report period', periodLabel],
      ['Generated', formatGeneratedAt(generatedAt)],
      ['Generated by', adminName || 'Administrator'],
      ['Bookings listed', String(bookings.length)],
    ],
  });

  drawTable({
    pager, regular, bold, italic,
    emptyMessage: 'No bookings were made in this period.',
    columns: [
      { label: 'Reference', width: 90, format: r => r.booking_reference || '—' },
      { label: 'Route', width: 170, format: r => `${r.origin || '—'} -> ${r.destination || '—'}` },
      { label: 'Driver', width: 100, format: r => r.driver_name || '—' },
      { label: 'Passenger', width: 100, format: r => r.passenger_name || '—' },
      {
        label: 'Status', width: 75, format: r => BOOKING_STATUS_LABEL[r.status] || r.status || '—',
        color: r => (r.status === 'cancelled' || r.status === 'no_show' ? COLOR_DANGER : r.status === 'completed' ? COLOR_GREEN : COLOR_INK),
      },
      { label: 'Seats', width: 50, align: 'right', format: r => fmtNumber(r.seats_booked) },
      { label: 'Fare', width: 70, align: 'right', format: r => fmtKES(r.total_price) },
      { label: 'Booked', width: 100, align: 'right', format: r => fmtDateTime(r.created_at) },
    ],
    rows: bookings,
  });

  pager.finish();
  return pdfDoc.save();
}
