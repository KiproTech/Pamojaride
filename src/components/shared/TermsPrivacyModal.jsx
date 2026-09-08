import { Link } from 'react-router-dom';
import { TERMS_SECTIONS, TERMS_VERSION, TERMS_LAST_UPDATED } from '../../lib/legal/termsContent';

// Reused from every place the full Terms & Conditions / Privacy Policy need
// to be readable: the "I agree..." link on PassengerRegister.jsx and
// DriverRegister.jsx, and the "Read Terms & Privacy Policy" links on
// LegalConsentCard.jsx (Profile pages) and Sidebar.jsx. Uses the app's
// existing .modal-overlay/.modal-box-lg classes (global.css) — the same
// pattern every other modal in this codebase already follows (see
// ReportModal.jsx) — so it renders consistently wherever it's opened,
// including the auth pages (global.css is loaded app-wide via main.jsx).
//
// The exact same content also lives at the standalone route /legal/terms
// (src/pages/legal/TermsAndPrivacy.jsx) for anyone who wants a permalink,
// wants to open it in a new tab, or reaches it from the landing-page
// footer before ever starting registration.
export default function TermsPrivacyModal({ onClose, highlightSectionId }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Terms & Conditions and Privacy Policy</h3>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              Version {TERMS_VERSION} · Last updated {TERMS_LAST_UPDATED}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ overflowY: 'auto', paddingRight: 4, flex: 1 }}>
          {TERMS_SECTIONS.map(section => (
            <section
              key={section.id}
              id={section.id}
              style={{
                marginBottom: 22,
                ...(highlightSectionId === section.id
                  ? { background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: 14 }
                  : {}),
              }}
            >
              <h4 style={{ fontSize: 14, margin: '0 0 8px', color: 'var(--text)' }}>{section.title}</h4>
              {section.paragraphs.map((p, i) => (
                <p key={i} style={{ fontSize: 13.5, lineHeight: 1.7, color: '#475569', margin: '0 0 10px' }}>
                  {p}
                </p>
              ))}
            </section>
          ))}

          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Prefer a standalone page? <Link to="/legal/terms" target="_blank" rel="noopener noreferrer">Open Terms & Privacy Policy in a new tab</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
