import { Link } from 'react-router-dom';

function Logo({ size = 28, dark = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{
        width: size + 8, height: size + 8,
        background: 'linear-gradient(135deg, #0E7490, #155E75)',
        borderRadius: '10px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        boxShadow: '0 2px 8px rgba(14,116,144,0.35)',
      }}>
        <svg width={size - 4} height={size - 4} viewBox="0 0 24 24" fill="none">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="white" opacity="0.9"/>
          <circle cx="12" cy="9" r="2.5" fill="#F97316"/>
          <path d="M6 19 Q12 16 18 19" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.6"/>
        </svg>
      </div>
      <span style={{
        fontFamily: 'var(--font-display)',
        fontSize: size,
        fontWeight: 800,
        color: dark ? 'white' : 'var(--text)',
        letterSpacing: '-0.5px',
        lineHeight: 1,
      }}>
        Pamoja<span style={{ color: 'var(--accent)' }}>Ride</span>
      </span>
    </div>
  );
}

function StatPill({ value, label }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '16px 24px',
      background: 'rgba(255,255,255,0.12)',
      borderRadius: '12px',
      border: '1px solid rgba(255,255,255,0.2)',
      minWidth: '120px',
    }}>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 800, color: 'white' }}>{value}</span>
      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.75)', marginTop: '2px', textAlign: 'center' }}>{label}</span>
    </div>
  );
}

function FeatureCard({ icon, title, desc }) {
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border)',
      borderRadius: '14px', padding: '28px 24px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
    }}>
      <div style={{
        width: '48px', height: '48px', background: 'var(--primary-xlight)',
        borderRadius: '12px', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: '24px', marginBottom: '16px',
      }}>{icon}</div>
      <h3 style={{ fontSize: '17px', fontWeight: 700, marginBottom: '8px' }}>{title}</h3>
      <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.7 }}>{desc}</p>
    </div>
  );
}

function StepCard({ number, title, desc, forRole }) {
  const isDriver = forRole === 'driver';
  return (
    <div style={{
      display: 'flex', gap: '20px', alignItems: 'flex-start',
      padding: '20px', background: 'white',
      border: '1px solid var(--border)', borderRadius: '14px',
      borderLeft: '4px solid ' + (isDriver ? 'var(--accent)' : 'var(--primary)'),
    }}>
      <div style={{
        width: '36px', height: '36px', flexShrink: 0,
        background: isDriver ? 'var(--accent-light)' : 'var(--primary-xlight)',
        borderRadius: '50%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: 'var(--font-display)',
        fontWeight: 800, fontSize: '15px',
        color: isDriver ? 'var(--accent)' : 'var(--primary)',
      }}>{number}</div>
      <div>
        <h4 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>{title}</h4>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6 }}>{desc}</p>
      </div>
    </div>
  );
}

function CorridorBadge({ from, to }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px',
      padding: '8px 16px', background: 'var(--primary-xlight)',
      border: '1px solid var(--primary-light)', borderRadius: '99px',
      fontSize: '13px', fontWeight: 600, color: 'var(--primary-dark)',
    }}>
      <span>{from}</span>
      <span style={{ color: 'var(--accent)' }}>→</span>
      <span>{to}</span>
    </div>
  );
}

export default function Landing() {
  return (
    <div style={{ background: 'var(--white)', minHeight: '100vh' }}>

      {/* Navbar */}
      <nav style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 48px', height: '68px',
        borderBottom: '1px solid var(--border)',
        position: 'sticky', top: 0,
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(10px)', zIndex: 100,
      }}>
        <Logo size={22} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Link to="/passenger/login"><button className="btn btn-ghost btn-sm">Passenger Login</button></Link>
          <Link to="/driver/login"><button className="btn btn-outline btn-sm">Driver Login</button></Link>
          <Link to="/passenger/register"><button className="btn btn-primary btn-sm">Get Started Free</button></Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{
        background: 'linear-gradient(135deg, #0E7490 0%, #155E75 60%, #0F172A 100%)',
        padding: '80px 48px 100px', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: '-80px', right: '-80px', width: '400px', height: '400px',
          background: 'radial-gradient(circle, rgba(249,115,22,0.15) 0%, transparent 70%)',
          borderRadius: '50%',
        }} />
        <div style={{ maxWidth: '1100px', margin: '0 auto', position: 'relative' }}>
          <div style={{
            display: 'inline-block', background: 'rgba(249,115,22,0.2)',
            border: '1px solid rgba(249,115,22,0.4)', color: '#FED7AA',
            padding: '4px 14px', borderRadius: '99px',
            fontSize: '13px', fontWeight: 600, marginBottom: '24px',
          }}>
            🇰🇪 Kenya's Intercity Ride-Sharing Marketplace
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 'clamp(38px, 6vw, 68px)',
            fontWeight: 800, color: 'white', lineHeight: 1.05,
            marginBottom: '24px', maxWidth: '700px',
          }}>
            Share the Road.<br />
            <span style={{ color: '#FDBA74' }}>Split the Cost.</span><br />
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.75em' }}>Travel Smarter.</span>
          </h1>
          <p style={{
            fontSize: '18px', color: 'rgba(255,255,255,0.80)',
            maxWidth: '560px', lineHeight: 1.75, marginBottom: '40px',
          }}>
            PamojaRide connects passengers with verified drivers on scheduled intercity routes
            across Kenya. Book a seat, pay via M-Pesa, and travel with confidence — Nairobi
            to Mombasa, Kisumu, Nakuru, Eldoret and beyond.
          </p>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '56px' }}>
            <Link to="/passenger/register">
              <button className="btn btn-lg" style={{ background: 'var(--accent)', color: 'white', boxShadow: '0 4px 16px rgba(249,115,22,0.4)' }}>
                🚌 Find a Ride Now
              </button>
            </Link>
            <Link to="/driver/register">
              <button className="btn btn-lg" style={{ background: 'rgba(255,255,255,0.12)', color: 'white', border: '1.5px solid rgba(255,255,255,0.3)' }}>
                🚗 Earn as a Driver
              </button>
            </Link>
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <StatPill value="5+" label="Major Corridors" />
            <StatPill value="M-Pesa" label="Native Payments" />
            <StatPill value="Verified" label="Drivers Only" />
            <StatPill value="Real-time" label="Booking Updates" />
          </div>
        </div>
      </section>

      {/* Corridors */}
      <section style={{ padding: '28px 48px', background: 'var(--bg-alt)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Routes:</span>
          <CorridorBadge from="Nairobi" to="Mombasa" />
          <CorridorBadge from="Nairobi" to="Kisumu" />
          <CorridorBadge from="Nairobi" to="Nakuru" />
          <CorridorBadge from="Nairobi" to="Eldoret" />
          <CorridorBadge from="Mombasa" to="Malindi" />
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>+ more expanding daily</span>
        </div>
      </section>

      {/* About */}
      <section style={{ padding: '80px 48px', maxWidth: '1100px', margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '64px', alignItems: 'center' }}>
          <div>
            <div style={{
              display: 'inline-block', background: 'var(--primary-light)', color: 'var(--primary-dark)',
              fontSize: '12px', fontWeight: 700, padding: '4px 12px', borderRadius: '99px',
              marginBottom: '16px', textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>About PamojaRide</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '36px', lineHeight: 1.15, marginBottom: '20px' }}>
              The smarter way to travel between Kenyan cities
            </h2>
            <p style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: '16px' }}>
              Kenya's intercity transport has always been served by matatus and buses — crowded,
              unscheduled, and unpredictable. PamojaRide brings structure: pre-booked seats,
              verified drivers, transparent pricing, and digital M-Pesa payments.
            </p>
            <p style={{ color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: '24px' }}>
              Think of it as <strong style={{ color: 'var(--text)' }}>BlaBlaCar meets Bolt</strong> — built specifically
              for Kenya's roads, networks, and payment systems. Drivers offset fuel costs by
              filling empty seats. Passengers get a comfortable, affordable, safe alternative.
            </p>
            {[
              '✅ All drivers are KYC-verified before they can post a single trip',
              '✅ Seats reserved atomically — no double-booking ever possible',
              '✅ M-Pesa STK Push payments — no cash, no risk',
              '✅ Real-time notifications when your trip starts or changes',
            ].map(item => (
              <div key={item} style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.5, marginBottom: '10px' }}>{item}</div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {[
              { icon: '🛡️', label: 'Safety First', desc: 'Every driver submits National ID, selfie, licence, and vehicle documents before approval.' },
              { icon: '📱', label: 'M-Pesa Native', desc: 'STK Push payment directly to your phone. No cash changes hands between passenger and driver.' },
              { icon: '🌍', label: 'Offline Tolerant', desc: "Built for Kenya's network conditions. Works on slow connections. Data cached locally when connectivity drops." },
              { icon: '⭐', label: 'Trust System', desc: 'Drivers earn trust levels 1–5 based on completed trips and ratings. Higher trust = more capacity.' },
            ].map(({ icon, label, desc }) => (
              <div key={label} style={{
                display: 'flex', gap: '16px', alignItems: 'flex-start',
                padding: '20px', background: 'var(--bg-alt)',
                border: '1px solid var(--border)', borderRadius: '12px',
              }}>
                <span style={{ fontSize: '28px', lineHeight: 1 }}>{icon}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '4px' }}>{label}</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6 }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section style={{ padding: '80px 48px', background: 'var(--bg-alt)' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '56px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '36px', marginBottom: '12px' }}>
              Everything you need for intercity travel
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '16px', maxWidth: '540px', margin: '0 auto' }}>
              A full-stack marketplace designed for Kenya's transport context.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
            <FeatureCard icon="🔍" title="Smart Trip Search" desc="Filter by route, date, and seat count. See driver rating, vehicle type, and price before booking." />
            <FeatureCard icon="💺" title="Instant Seat Booking" desc="Seats locked atomically in the database. Two passengers can never book the same seat simultaneously." />
            <FeatureCard icon="💳" title="M-Pesa STK Push" desc="Pay directly from your Safaricom number. No app downloads or card details. Just enter your PIN." />
            <FeatureCard icon="🔔" title="Live Trip Updates" desc="Get notified the moment your driver starts the trip. Powered by real-time WebSockets." />
            <FeatureCard icon="🗺️" title="Route Templates" desc="Drivers who travel the same route weekly set templates. Trips auto-create 7 days ahead." />
            <FeatureCard icon="⭐" title="Ratings & Reviews" desc="Rate your driver after every trip. Ratings feed into the trust system to keep quality high." />
            <FeatureCard icon="🛡️" title="KYC Verification" desc="Drivers submit National ID, selfie, driving licence, and vehicle logbook. Admins review before activation." />
            <FeatureCard icon="📊" title="Driver Earnings" desc="Track completed trips and pending payouts. Funds released after the dispute window closes." />
            <FeatureCard icon="🚨" title="Safety Reporting" desc="Flag a driver or trip anytime. Two or more reports auto-suspend the trip pending admin review." />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section style={{ padding: '80px 48px', maxWidth: '1100px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '56px' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '36px', marginBottom: '12px' }}>How it works</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '16px' }}>Two different experiences — one platform.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px' }}>
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px',
              padding: '16px 20px', background: 'var(--primary-xlight)',
              border: '1px solid var(--primary-light)', borderRadius: '12px',
            }}>
              <span style={{ fontSize: '32px' }}>🚌</span>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', color: 'var(--primary-dark)' }}>For Passengers</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Sign up in under 60 seconds. No ID required.</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <StepCard number="1" forRole="passenger" title="Create your account" desc="Enter your name, phone number, and verify with a 6-digit OTP. No ID, no waiting." />
              <StepCard number="2" forRole="passenger" title="Search for a trip" desc="Pick your route and travel date. Browse trips with driver ratings, vehicle info, and price per seat." />
              <StepCard number="3" forRole="passenger" title="Book & pay via M-Pesa" desc="Select seats. An M-Pesa STK Push arrives on your phone — enter your PIN to confirm." />
              <StepCard number="4" forRole="passenger" title="Travel & rate" desc="Get notified when driver starts. After arrival, rate your experience in one tap." />
            </div>
            <div style={{ marginTop: '24px' }}>
              <Link to="/passenger/register">
                <button className="btn btn-primary btn-full">Book Your First Ride →</button>
              </Link>
            </div>
          </div>
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px',
              padding: '16px 20px', background: 'var(--accent-light)',
              border: '1px solid #FED7AA', borderRadius: '12px',
            }}>
              <span style={{ fontSize: '32px' }}>🚗</span>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', color: '#92400E' }}>For Drivers</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Earn on every trip you already make.</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <StepCard number="1" forRole="driver" title="Register & submit KYC" desc="Provide National ID, selfie, driving licence, and vehicle documents. Reviewed within 24 hours." />
              <StepCard number="2" forRole="driver" title="Get verified & post trips" desc="Once approved, post your route with departure time, seats, and price per seat." />
              <StepCard number="3" forRole="driver" title="Passengers book your seats" desc="See bookings come in with passenger details. Start the trip when ready — all passengers notified." />
              <StepCard number="4" forRole="driver" title="Complete & get paid" desc="Mark the trip complete on arrival. Funds released to M-Pesa after dispute window closes." />
            </div>
            <div style={{ marginTop: '24px' }}>
              <Link to="/driver/register">
                <button className="btn btn-accent btn-full">Start Earning as a Driver →</button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Trust levels */}
      <section style={{ padding: '80px 48px', background: 'linear-gradient(135deg, #0F172A 0%, #155E75 100%)' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '36px', color: 'white', marginBottom: '12px' }}>
            Safety is not optional
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '16px', maxWidth: '540px', margin: '0 auto 48px' }}>
            Every driver is KYC-verified before carrying a single passenger. Our trust system
            ensures only proven drivers get full platform access.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>
            {[
              { level: '1', label: 'New Driver',   trips: '0–4 trips',   seats: 'Max 2 seats', color: '#64748B' },
              { level: '2', label: 'Building',     trips: '5–14 trips',  seats: 'Max 4 seats', color: '#0E7490' },
              { level: '3', label: 'Established',  trips: '15–29 trips', seats: 'Max 6 seats', color: '#16A34A' },
              { level: '4', label: 'Trusted',      trips: '30–59 trips', seats: 'Full car',    color: '#F59E0B' },
              { level: '5', label: 'Elite',        trips: '60+ trips',   seats: 'Unlimited',   color: '#F97316' },
            ].map(({ level, label, trips, seats, color }) => (
              <div key={level} style={{
                background: 'rgba(255,255,255,0.08)', border: '1px solid ' + color + '40',
                borderTop: '3px solid ' + color, borderRadius: '12px', padding: '20px 16px', textAlign: 'center',
              }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '28px', color, marginBottom: '4px' }}>L{level}</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'white', marginBottom: '8px' }}>{label}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>{trips}</div>
                <div style={{ fontSize: '12px', color, fontWeight: 600 }}>{seats}</div>
              </div>
            ))}
          </div>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', marginTop: '20px' }}>
            Trust levels upgrade automatically as drivers complete trips and maintain high ratings.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section style={{ padding: '80px 48px', textAlign: 'center', background: 'var(--bg-alt)' }}>
        <div style={{ maxWidth: '600px', margin: '0 auto' }}>
          <Logo size={26} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '36px', margin: '24px 0 12px' }}>
            Ready to travel smarter?
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '16px', marginBottom: '36px', lineHeight: 1.7 }}>
            Join PamojaRide today. Passengers sign up free.
            Drivers get verified and start earning within 24 hours.
          </p>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/passenger/register"><button className="btn btn-primary btn-lg">I need a ride</button></Link>
            <Link to="/driver/register"><button className="btn btn-accent btn-lg">I want to drive</button></Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{
        padding: '32px 48px', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px',
      }}>
        <Logo size={18} />
        <div style={{ display: 'flex', gap: '24px', fontSize: '13px' }}>
          <Link to="/passenger/register" style={{ color: 'var(--text-muted)' }}>Passenger Sign Up</Link>
          <Link to="/driver/register"    style={{ color: 'var(--text-muted)' }}>Driver Sign Up</Link>
          <Link to="/passenger/login"    style={{ color: 'var(--text-muted)' }}>Login</Link>
        </div>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>© 2026 PamojaRide · Built for Kenya 🇰🇪</span>
      </footer>

    </div>
  );
}