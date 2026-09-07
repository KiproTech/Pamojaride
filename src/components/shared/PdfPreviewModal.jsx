/**
 * Generic PDF preview modal — shows a browser-generated PDF (via the
 * native PDF viewer, embedded in an <iframe>) so the user can check it
 * before saving, rather than a file landing straight in their downloads
 * folder unseen. Same UI pattern as components/driver/ReportPreviewModal.jsx,
 * generalized with a `title` prop so it can be reused for receipts without
 * duplicating the driver-report-specific copy in that component.
 *
 * `previewUrl` is an object URL for a Blob the caller already built
 * (see lib/reports/receiptPdf.js) — this component only displays it and
 * offers a "Download" action; it never (re)generates the PDF itself.
 */
export default function PdfPreviewModal({ title = 'Document preview', previewUrl, onDownload, onClose }) {
  let iframeRef = null;

  // Prints straight from the loaded PDF in the iframe (the browser's own
  // PDF viewer handles pagination/margins) — no separate print stylesheet
  // or duplicate render is needed since the PDF itself is already the
  // print-ready document.
  function handlePrint() {
    if (!iframeRef) return;
    try {
      iframeRef.contentWindow.focus();
      iframeRef.contentWindow.print();
    } catch {
      // Some browsers restrict scripting into a same-origin blob iframe's
      // PDF viewer; falling back to opening it in a new tab still lets the
      // user print from there via their browser's own PDF controls.
      window.open(previewUrl, '_blank');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>{title}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 16 }}>
          {previewUrl ? (
            <iframe
              ref={el => { iframeRef = el; }}
              src={previewUrl}
              title={title}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          ) : (
            <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-outline btn-sm" disabled={!previewUrl} onClick={handlePrint}>
            🖨 Print
          </button>
          <button className="btn btn-primary btn-sm" disabled={!previewUrl} onClick={onDownload}>
            ⬇ Download PDF
          </button>
        </div>
      </div>
    </div>
  );
}
