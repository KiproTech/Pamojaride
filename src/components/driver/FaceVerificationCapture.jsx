import { useEffect, useRef, useState } from 'react';

// ============================================================================
// Live face capture via the browser's standard camera API
// (navigator.mediaDevices.getUserMedia). The camera is NEVER started
// automatically — only after the driver clicks "Start Face Verification".
//
// What this honestly is: a single still frame, captured client-side and
// handed to the parent as a normal File (same shape uploadVerificationDocument
// already expects for any other document), for a HUMAN admin to visually
// compare against the driver's ID during KYC review.
//
// What this is NOT: this project has no biometric face-matching or
// liveness-detection service, so this component does not claim to perform
// one. The "presence check" below is a basic client-side sanity check
// (rejects an all-black/frozen frame — e.g. a blocked lens or a photo of a
// blank surface) — not identity verification. Do not extend this to claim
// automated matching without an actual biometric service behind it.
//
// Privacy: no video is recorded or uploaded — only the single captured
// frame ever leaves the browser, and the getUserMedia stream is stopped
// the moment a frame is captured (or the component unmounts).
// ============================================================================

const CAPTURE_WIDTH = 480;
const CAPTURE_HEIGHT = 480;

export default function FaceVerificationCapture({ onCaptured, existingLabel, disabled }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [phase, setPhase] = useState('idle'); // idle | starting | live | captured | error
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => stopStream, []); // safety net: always release the camera on unmount

  function stopStream() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }

  async function startCamera() {
    setError('');
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase('live');
    } catch (err) {
      setPhase('error');
      setError(
        err?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Please allow camera access and try again.'
          : err?.name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : 'Could not access the camera. Please try again.'
      );
    }
  }

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width = CAPTURE_WIDTH;
    canvas.height = CAPTURE_HEIGHT;
    const ctx = canvas.getContext('2d');
    // Crop to a centred square so every capture matches CAPTURE_WIDTH x
    // CAPTURE_HEIGHT regardless of the camera's native aspect ratio.
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);

    // Basic presence sanity check — NOT biometric verification. Rejects an
    // obviously blank/blocked capture (near-uniform brightness across a
    // sample of pixels) so a driver doesn't accidentally submit a frame
    // with the lens covered.
    const sample = ctx.getImageData(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT).data;
    let min = 255, max = 0;
    for (let i = 0; i < sample.length; i += 40) { // sparse sample, plenty for a variance check
      const lum = (sample[i] + sample[i + 1] + sample[i + 2]) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    if (max - min < 12) {
      setError("That capture looks blank — make sure your face is visible and there's enough light, then try again.");
      return;
    }

    stopStream();
    canvas.toBlob(blob => {
      if (!blob) { setError('Capture failed — please try again.'); return; }
      const file = new File([blob], `face-verification-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setPreviewUrl(URL.createObjectURL(blob));
      setPhase('captured');
      onCaptured(file);
    }, 'image/jpeg', 0.9);
  }

  function retake() {
    setPreviewUrl(null);
    setError('');
    onCaptured(null);
    startCamera();
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
        Please complete a short face verification using your camera. This helps PamojaRide confirm that the
        person submitting this verification is a real person — an admin reviews it alongside your documents.
      </p>

      {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div style={{
          position: 'relative', width: 220, height: 220, borderRadius: '50%', overflow: 'hidden',
          background: 'var(--bg-alt)', border: `3px solid ${phase === 'captured' ? 'var(--green)' : 'var(--border)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {phase === 'captured' && previewUrl ? (
            <img src={previewUrl} alt="Captured face verification" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : phase === 'live' || phase === 'starting' ? (
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          ) : existingLabel ? (
            <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)', padding: 12 }}>
              🪪<br />{existingLabel}
            </div>
          ) : (
            <span style={{ fontSize: 44 }}>🪪</span>
          )}
          {phase === 'live' && (
            <div style={{ position: 'absolute', inset: 10, borderRadius: '50%', border: '2px dashed rgba(255,255,255,0.7)', pointerEvents: 'none' }} />
          )}
        </div>

        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {phase === 'idle' || phase === 'error' ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={startCamera}>
            📷 Start Face Verification
          </button>
        ) : phase === 'starting' ? (
          <span className="spinner" />
        ) : phase === 'live' ? (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10 }}>Position your face inside the circle, then capture.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={capture}>Capture</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <span className="badge badge-green">✓ Captured</span>
            <button type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={retake}>Retake</button>
          </div>
        )}
      </div>
    </div>
  );
}
