import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { getSignedDocumentUrl, DOCUMENT_TYPES } from '../../lib/verificationDocuments';

const DOC_LABELS = Object.fromEntries(DOCUMENT_TYPES.map(d => [d.key, d.label]));
const IMAGE_DOC_TYPES = new Set(DOCUMENT_TYPES.filter(d => d.imageOnly).map(d => d.key));

// Renders a driver's uploaded KYC documents (driver.kyc_documents — an
// array of { type, path, file_name, size, mime_type, uploaded_at }).
// Documents live in the private "driver-documents" Storage bucket, so
// previews/opens always go through a short-lived signed URL generated on
// demand rather than a static <img src> — this component never assumes
// the bucket is public.
//
// Shared by:
//   - components/admin/KYCReviewer.jsx (pending-review queue)
//   - components/admin/DriverDetailsModal.jsx (View Driver Details, used
//     from Manage Users — available for ANY driver regardless of
//     verification status, so documents stay reachable after approval)
// One rendering path for both, instead of duplicating the thumbnail/
// signed-URL logic in two places.
//
// A doc type no longer collected going forward (e.g. an old "logbook" or
// "insurance" entry uploaded before the 4-document cap) still renders
// fine here — it just falls back to its raw key as a label, since a
// historical upload should never disappear from an admin's view just
// because the current DOCUMENT_TYPES list moved on.
export default function DriverDocumentsGallery({ documents }) {
  const [openingDoc, setOpeningDoc] = useState(null);
  const [thumbs, setThumbs] = useState({});

  const docs = Array.isArray(documents) ? documents : [];
  const imageDocuments = docs.filter(d => IMAGE_DOC_TYPES.has(d.type));
  const paperDocuments = docs.filter(d => !IMAGE_DOC_TYPES.has(d.type));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const doc of imageDocuments) {
        if (thumbs[doc.path]) continue;
        const { url } = await getSignedDocumentUrl(supabase, doc.path);
        if (!cancelled && url) setThumbs(prev => ({ ...prev, [doc.path]: url }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents]);

  async function openDocument(doc) {
    setOpeningDoc(doc.path);
    const { url, error } = await getSignedDocumentUrl(supabase, doc.path);
    setOpeningDoc(null);
    if (error || !url) { alert('Could not open this document — it may have been removed.'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  if (docs.length === 0) {
    return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No documents uploaded.</p>;
  }

  return (
    <div>
      {imageDocuments.length > 0 && (
        <div style={{ marginBottom: paperDocuments.length > 0 ? 16 : 0 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {imageDocuments.map(doc => (
              <button
                key={doc.path}
                type="button"
                onClick={() => openDocument(doc)}
                title={`Open ${DOC_LABELS[doc.type] || doc.type} full size`}
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'center' }}
              >
                <div style={{
                  width: 96, height: 96, borderRadius: doc.type === 'face_verification' ? '50%' : 10,
                  overflow: 'hidden', background: 'var(--bg-alt)', border: '1.5px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {thumbs[doc.path] ? (
                    <img src={thumbs[doc.path]} alt={DOC_LABELS[doc.type] || doc.type} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span className="spinner" />
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{DOC_LABELS[doc.type] || doc.type}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {paperDocuments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {paperDocuments.map(doc => (
            <button
              key={doc.path}
              type="button"
              className="btn btn-outline btn-sm"
              disabled={openingDoc === doc.path}
              onClick={() => openDocument(doc)}
            >
              {openingDoc === doc.path ? <span className="spinner" /> : `📄 ${DOC_LABELS[doc.type] || doc.type}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
