/**
 * Secure-payment / anti-off-platform-payment notice. Shown wherever a
 * passenger can see a driver's contact details and/or is about to book or
 * confirm a trip, so they're warned before any payment conversation
 * happens — not after. Purely informational; PamojaRide does not yet
 * process payments itself (no escrow/in-app payment exists in this
 * codebase), so this never claims a transaction is protected today, only
 * that direct/off-platform payment isn't.
 *
 * `variant="compact"` renders a shorter one-paragraph version for tight
 * spaces (e.g. inside the booking confirmation modal); the default
 * renders the fuller version used on Trip Details / Driver Details.
 */
export default function SecurePaymentNotice({ variant = 'full' }) {
  if (variant === 'compact') {
    return (
      <div className="alert alert-amber" style={{ padding: '10px 12px', fontSize: 12.5 }}>
        ⚠️ <strong>Keep your booking protected.</strong> Don't pay the driver directly (cash, mobile
        money, bank transfer, or otherwise) outside PamojaRide. Once secure in-app payments are
        available, always pay through the official PamojaRide payment system — payments made
        outside the platform aren't tracked by PamojaRide and may not qualify for reimbursement or
        dispute support.
      </div>
    );
  }

  return (
    <div className="alert alert-amber" style={{ padding: '12px 14px', fontSize: 13 }}>
      <strong>⚠️ Secure Payment Notice</strong>
      <p style={{ margin: '6px 0 0' }}>
        For your security, do not send money directly to the driver through cash, mobile money,
        bank transfer, or any other payment method outside PamojaRide.
      </p>
      <p style={{ margin: '6px 0 0' }}>
        When secure in-app payments become available, always use the official PamojaRide payment
        system to protect your booking and payment.
      </p>
      <p style={{ margin: '6px 0 0' }}>
        Payments made directly to a driver or outside the PamojaRide platform are not protected by
        PamojaRide and may not be eligible for reimbursement or dispute support.
      </p>
    </div>
  );
}
