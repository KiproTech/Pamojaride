/**
 * Shows the generated Driver Booking Report PDF inline (via the browser's
 * native PDF viewer, embedded in an <iframe>) so the driver can check it
 * looks right before saving it — rather than a report landing straight in
 * their downloads folder unseen.
 *
 * `previewUrl` is an object URL for a Blob the caller already built
 * (see driver/Bookings.jsx) — this component only displays it and offers
 * a "Download" action; it never (re)generates the PDF itself.
 */
export default function ReportPreviewModal({ previewUrl, onDownload, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: 17 }}>Booking report preview</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 16 }}>
          {previewUrl ? (
            <iframe
              src={previewUrl}
              title="Booking report preview"
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          ) : (
            <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-primary btn-sm" disabled={!previewUrl} onClick={onDownload}>
            ⬇ Download PDF
          </button>
        </div>
      </div>
    </div>
  );
}
