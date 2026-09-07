import { Link } from 'react-router-dom'
export default function AuthLayout({ children, title, subtitle, switchText, switchLink, switchLabel }) {
  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'linear-gradient(135deg, #f0fdff 0%, #fff 100%)', padding:'2rem 1rem' }}>
      <div style={{ width:'100%', maxWidth:420 }}>
        <div style={{ textAlign:'center', marginBottom:'2rem' }}>
          <Link to="/" style={{ fontFamily:'var(--font-display)', fontSize:'1.75rem', fontWeight:800, color:'var(--primary)' }}>
            Pamoja<span style={{ color:'var(--accent)' }}>Ride</span>
          </Link>
          <h1 style={{ fontSize:'1.25rem', fontWeight:700, marginTop:'1.5rem', color:'var(--text)' }}>{title}</h1>
          {subtitle && <p style={{ color:'var(--text-muted)', fontSize:'0.9rem', marginTop:'0.25rem' }}>{subtitle}</p>}
        </div>
        <div className="card" style={{ padding:'2rem' }}>{children}</div>
        {switchText && (
          <p style={{ textAlign:'center', marginTop:'1.25rem', fontSize:'0.875rem', color:'var(--text-muted)' }}>
            {switchText}{' '}<Link to={switchLink} style={{ color:'var(--primary)', fontWeight:600 }}>{switchLabel}</Link>
          </p>
        )}
        <p style={{ textAlign:'center', marginTop:'0.75rem', fontSize:'0.8125rem' }}>
          <Link to="/" style={{ color:'var(--text-muted)' }}>← Back to home</Link>
        </p>
      </div>
    </div>
  )
}
