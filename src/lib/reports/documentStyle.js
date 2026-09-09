import { StandardFonts, rgb } from 'pdf-lib';
import { formatSupportFooterLine } from '../support/supportContacts';

// ============================================================================
// Shared PDF brand palette — used by both receiptPdf.js and
// driverBookingReport.js so the two client-side generated PDF documents
// (Booking Receipt / Driver Booking Report) read as the same product.
//
// Matches src/styles/global.css (--primary / --accent / --text).
//
// This file holds ONLY the color constants that were duplicated across both
// PDF modules. Anything not shared between the two (e.g. receiptPdf.js's
// COLOR_AMBER, used solely for its refund-status note) stays local to the
// file that uses it.
// ============================================================================

export const COLOR_INK = rgb(0.06, 0.09, 0.16);          // #0F172A
export const COLOR_MUTED = rgb(0.39, 0.45, 0.55);        // #64748B
export const COLOR_PRIMARY = rgb(0.055, 0.455, 0.565);   // #0E7490
export const COLOR_PRIMARY_DARK = rgb(0.084, 0.369, 0.459); // #155E75
export const COLOR_ACCENT = rgb(0.976, 0.451, 0.086);    // #F97316
export const COLOR_BORDER = rgb(0.886, 0.910, 0.941);    // #E2E8F0
export const COLOR_ROW_ALT = rgb(0.973, 0.980, 0.988);   // #F8FAFC
export const COLOR_WHITE = rgb(1, 1, 1);
export const COLOR_DANGER = rgb(0.937, 0.267, 0.267);    // #EF4444
export const COLOR_GREEN = rgb(0.086, 0.639, 0.290);     // #16A34A

// ============================================================================
// Shared font loading — both PDF modules embed the exact same three
// StandardFonts. Centralized here so there's one place that defines "what
// the PamojaRide document font stack is".
// ============================================================================

/**
 * Embeds and returns the standard Helvetica family used by every PamojaRide
 * PDF document.
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @returns {Promise<{regular: import('pdf-lib').PDFFont, bold: import('pdf-lib').PDFFont, italic: import('pdf-lib').PDFFont}>}
 */
export async function loadReportFonts(pdfDoc) {
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  return { regular, bold, italic };
}

// ============================================================================
// Shared "generated at" date / page-label formatting — the small pieces of
// text formatting logic that were duplicated (functionally identically)
// between receiptPdf.js's "Generated" meta line + single "Page 1" label and
// driverBookingReport.js's "Generated" meta line + per-page "Page N" label.
// ============================================================================

/**
 * Formats a Date for a document's "Generated" meta line, e.g.
 * "7 Sep 2026, 14:05".
 */
export function formatGeneratedAt(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Formats the footer page-number label, e.g. "Page 1". */
export function formatPageLabel(pageNum) {
  return `Page ${pageNum}`;
}

// ============================================================================
// Shared logo embedding — the PamojaRide logo asset is /Vite.svg (see
// pages/Landing.jsx's <Logo> component: "Vite.svg is the only logo asset;
// nothing new is created here", and database/vite_svg_logo_no_db_changes.sql).
// pdf-lib cannot embed SVG directly, so this rasterizes it to PNG once (via
// an offscreen <canvas>) and caches the bytes at module scope for the life
// of the page, so generating several PDFs in one session (e.g. a driver
// downloading multiple booking reports) only fetches/rasterizes once.
// ============================================================================

let cachedLogoBytesPromise = null;

async function rasterizeLogoSvgToPngBytes(size = 256) {
  const res = await fetch('/Vite.svg');
  if (!res.ok) throw new Error(`Failed to fetch logo asset (/Vite.svg): ${res.status}`);
  const svgText = await res.text();
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to rasterize logo asset (/Vite.svg)'));
    });
    img.src = svgUrl;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

// Fetches + rasterizes the logo once, caching the resolved bytes (or the
// failure) at module scope. A fetch/rasterize failure (e.g. offline) is
// swallowed here — every caller treats a null result as "skip the glyph,
// keep the text wordmark", never as a reason to fail the whole document.
function getLogoPngBytes() {
  if (!cachedLogoBytesPromise) {
    cachedLogoBytesPromise = rasterizeLogoSvgToPngBytes().catch((err) => {
      console.error('PamojaRide logo embed failed, falling back to wordmark only:', err);
      cachedLogoBytesPromise = null;
      return null;
    });
  }
  return cachedLogoBytesPromise;
}

/**
 * Embeds the PamojaRide logo (/Vite.svg, rasterized) into `pdfDoc` and
 * returns the embedded PDFImage, or null if the asset couldn't be loaded.
 * Call once per document, right after `PDFDocument.create()`, and pass the
 * result to `drawBrandLogo()` wherever the header is drawn (once per page
 * for multi-page documents).
 *
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @returns {Promise<import('pdf-lib').PDFImage|null>}
 */
export async function embedBrandLogo(pdfDoc) {
  const bytes = await getLogoPngBytes();
  if (!bytes) return null;
  try {
    return await pdfDoc.embedPng(bytes);
  } catch (err) {
    console.error('PamojaRide logo embed failed, falling back to wordmark only:', err);
    return null;
  }
}

/**
 * Draws the PamojaRide logo glyph inside a white box — the same "glyph in a
 * white box beside the wordmark" treatment used by the app's own <Logo>
 * component (pages/Landing.jsx, reused by Sidebar.jsx and every auth page).
 * No-ops if `logoImage` is null (embedBrandLogo() couldn't load the asset),
 * so a missing/broken logo file never breaks receipt/report generation —
 * documents simply fall back to the text-only wordmark next to it.
 *
 * @param {Object} params
 * @param {import('pdf-lib').PDFPage} params.page
 * @param {import('pdf-lib').PDFImage|null} params.logoImage
 * @param {number} params.x - left edge of the white box
 * @param {number} params.centerY - vertical center of the box
 * @param {number} [params.boxSize=34]
 */
export function drawBrandLogo({ page, logoImage, x, centerY, boxSize = 34 }) {
  if (!logoImage) return;
  const pad = boxSize * 0.16;
  const glyphSize = boxSize - pad * 2;
  page.drawRectangle({ x, y: centerY - boxSize / 2, width: boxSize, height: boxSize, color: COLOR_WHITE });
  page.drawImage(logoImage, { x: x + pad, y: centerY - boxSize / 2 + pad, width: glyphSize, height: glyphSize });
}

/** Standard left offset for header text once the logo box (see
 * drawBrandLogo) sits at the header's left margin — box width + gap. */
export function logoTextOffset(boxSize = 34, gap = 10) {
  return boxSize + gap;
}

// ============================================================================
// Shared multi-page pagination scaffold — factors out the "header band on
// every page, footer on every page, start a new page when a section won't
// fit" logic that receiptPdf.js/driverBookingReport.js each hand-wrote
// locally (see driverBookingReport.js's drawHeader/drawFooter/newPage/
// ensureSpace closures). New multi-page admin reports (adminPerformanceReports.js)
// use this instead of re-deriving it a third/fourth/fifth time; the two
// existing documents are left exactly as they were (per the brief's "do not
// redesign the existing PDFs") beyond the logo addition above.
// ============================================================================

/**
 * Creates a paginated report "pager" that owns page creation, the repeated
 * header band, and the repeated footer.
 *
 * @param {Object} params
 * @param {import('pdf-lib').PDFDocument} params.pdfDoc
 * @param {number} params.pageWidth
 * @param {number} params.pageHeight
 * @param {number} params.margin
 * @param {number} params.contentWidth
 * @param {import('pdf-lib').PDFFont} params.regularFont
 * @param {Object} [params.supportContacts]
 * @param {(ctx: {page: import('pdf-lib').PDFPage, pageNum: number, isFirstPage: boolean}) => number} params.drawHeader
 *   Draws the header band for the given page and returns the y coordinate
 *   content should start at.
 * @param {number} [params.bottomMargin=60] - content never drawn below this y.
 */
export function createPagedReport({
  pdfDoc, pageWidth, pageHeight, margin, contentWidth, regularFont,
  supportContacts, drawHeader, bottomMargin = 60,
}) {
  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let pageNum = 1;
  let y = drawHeader({ page, pageNum, isFirstPage: true });

  function drawFooterNow() {
    drawDocumentFooter({
      page, regularFont, margin, contentWidth,
      pageLabel: formatPageLabel(pageNum), supportContacts,
    });
  }

  function newPage() {
    drawFooterNow();
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    pageNum += 1;
    y = drawHeader({ page, pageNum, isFirstPage: false });
  }

  /** Starts a new page first if drawing `height` more points would run
   * past the footer. `onBreak()`, if given, re-draws anything (e.g. a
   * table's column header row) that should repeat at the top of the new
   * page. */
  function ensureSpace(height, onBreak) {
    if (y - height < bottomMargin) {
      newPage();
      onBreak?.();
    }
  }

  return {
    getPage: () => page,
    getY: () => y,
    setY: (v) => { y = v; },
    ensureSpace,
    finish: () => drawFooterNow(),
  };
}

// ============================================================================
// Shared footer drawing — identical footer treatment used at the bottom of
// every page of both documents: a top border rule, the centralized Support
// Contacts line on the left (via formatSupportFooterLine/fetchSupportContacts
// — see src/lib/support/supportContacts.js), and the page label on the
// right, truncating the support line so it never collides with the page
// label.
// ============================================================================

// Local truncation helper (kept private to this module — each report file
// keeps its own copy for its own, broader truncation needs elsewhere in the
// document; this one exists solely so the shared footer is self-contained).
function truncateFooterText(text, font, size, maxWidth) {
  const str = String(text ?? '');
  if (font.widthOfTextAtSize(str, size) <= maxWidth) return str;
  let out = str;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/**
 * Draws the standard PamojaRide document footer onto `page`.
 *
 * @param {Object} params
 * @param {import('pdf-lib').PDFPage} params.page
 * @param {import('pdf-lib').PDFFont} params.regularFont
 * @param {number} params.margin
 * @param {number} params.contentWidth
 * @param {string} params.pageLabel - e.g. via formatPageLabel(pageNum)
 * @param {Object} [params.supportContacts] - the row resolved by
 *   fetchSupportContacts() (src/lib/support/supportContacts.js). Any
 *   missing/blank field is simply left out of the footer by
 *   formatSupportFooterLine; if every field is blank the footer falls back
 *   to a generic message rather than drawing anything broken.
 * @param {number} [params.footerY=34]
 */
export function drawDocumentFooter({ page, regularFont, margin, contentWidth, pageLabel, supportContacts, footerY = 34 }) {
  const rightX = margin + contentWidth;
  page.drawLine({ start: { x: margin, y: footerY + 16 }, end: { x: rightX, y: footerY + 16 }, thickness: 0.75, color: COLOR_BORDER });

  const pw = regularFont.widthOfTextAtSize(pageLabel, 8.5);
  // Reserve room for the page-number label plus a gap so a long footer
  // (several contact channels configured) truncates with an ellipsis
  // instead of ever overlapping/overflowing past it.
  const footerMaxWidth = contentWidth - pw - 16;
  const footerText = truncateFooterText(formatSupportFooterLine(supportContacts), regularFont, 8.5, footerMaxWidth);

  page.drawText(footerText, { x: margin, y: footerY, size: 8.5, font: regularFont, color: COLOR_MUTED });
  page.drawText(pageLabel, { x: rightX - pw, y: footerY, size: 8.5, font: regularFont, color: COLOR_MUTED });
}

