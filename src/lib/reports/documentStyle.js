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

