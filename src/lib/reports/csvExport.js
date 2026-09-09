// Small, dependency-free CSV export helper. No existing CSV utility was
// found anywhere in the project, and CSV generation from an array of plain
// objects doesn't warrant pulling in a library (papaparse etc.) — this is
// ~20 lines of quoting logic used by every admin report export.

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Quote whenever the cell contains a comma, quote, or newline; double up
  // any embedded quotes, per RFC 4180.
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Builds a CSV string from an array of row objects.
 *
 * @param {Array<{label: string, key: string, format?: (row: any) => any}>} columns
 * @param {Array<Object>} rows
 * @returns {string}
 */
export function buildCsv(columns, rows) {
  const header = columns.map(c => escapeCsvCell(c.label)).join(',');
  const lines = rows.map(row => columns
    .map(c => escapeCsvCell(c.format ? c.format(row) : row[c.key]))
    .join(','));
  // Leading BOM so Excel (incl. on Windows) reliably detects UTF-8 instead
  // of mis-rendering non-ASCII names.
  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

/** Triggers a browser download of `content` as a file named `filename`. */
export function downloadTextFile(content, filename, mimeType = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Builds a CSV from `columns`/`rows` and immediately triggers its download. */
export function downloadCsv(columns, rows, filename) {
  downloadTextFile(buildCsv(columns, rows), filename);
}
