import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createAuthGateway, type User } from './auth';
import './styles.css';

const auth = createAuthGateway();

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => { void auth.currentUser().then(setUser); }, []);
  const initials = useMemo(() => user?.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(), [user]);

  async function signOut() { await auth.signOut(); setUser(null); setNotice('You’re signed out.'); }
  async function google() {
    setBusy(true);
    try { setUser(await auth.signInWithGoogle()); setShowAuth(false); }
    finally { setBusy(false); }
  }
  async function email(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      setUser(await auth.signUpWithEmail({ name: String(data.get('name')), email: String(data.get('email')) }));
      setShowAuth(false);
    } finally { setBusy(false); }
  }

  return <main>
    <nav className="nav">
      <a className="brand" href="#top" aria-label="WarmPath home"><span className="brand-mark">W</span> WarmPath</a>
      <div className="nav-actions">
        <a href="#how-it-works">How it works</a>
        {user ? <><span className="avatar" title={user.email}>{initials}</span><button className="text-button" onClick={() => void signOut()}>Sign out</button></>
          : <button className="primary small" onClick={() => setShowAuth(true)}>Get started <span>→</span></button>}
      </div>
    </nav>

    <section id="top" className="hero">
      <div className="hero-copy">
        <p className="eyebrow"><i /> YOUR NETWORK, MADE ACTIONABLE</p>
        <h1>Find your way <em>in.</em></h1>
        <p className="lede">Turn a job post into the strongest, most human path to the person who can help.</p>
        <div className="hero-buttons">
          <button className="primary" onClick={() => setShowAuth(true)}>Build your first path <span>→</span></button>
          <a className="secondary" href="#how-it-works">See how it works <span>↓</span></a>
        </div>
        <p className="privacy-note">✦ Your network stays private. You choose what to connect.</p>
      </div>
      <div className="constellation" aria-label="Illustration of connected people and a highlighted introduction path">
        <svg viewBox="0 0 620 480" role="img">
          <defs><radialGradient id="glow"><stop stopColor="#b5e7df" stopOpacity=".25"/><stop offset="1" stopColor="#b5e7df" stopOpacity="0"/></radialGradient></defs>
          <circle cx="320" cy="245" r="220" fill="url(#glow)" />
          <g className="faint-lines"><path d="M102 104L251 184 418 103 521 186 451 342 270 384 92 285Z"/><path d="M102 104L92 285 251 184 270 384 418 103 451 342 521 186"/><path d="M251 184L451 342M92 285L418 103"/></g>
          <g className="route-line"><path d="M102 104L251 184 451 342 521 186"/></g>
          <g className="nodes"><circle cx="102" cy="104" r="22"/><circle cx="251" cy="184" r="26"/><circle cx="418" cy="103" r="18"/><circle cx="521" cy="186" r="25"/><circle cx="451" cy="342" r="28"/><circle cx="270" cy="384" r="20"/><circle cx="92" cy="285" r="18"/></g>
          <g className="route-nodes"><circle cx="102" cy="104" r="12"/><circle cx="251" cy="184" r="13"/><circle cx="451" cy="342" r="14"/><circle cx="521" cy="186" r="12"/></g>
          <g className="labels"><text x="60" y="65">YOU</text><text x="205" y="145">PROFESSOR</text><text x="400" y="385">ALUMNI</text><text x="465" y="150">RECRUITER</text></g>
        </svg>
        <aside className="path-card"><span>BEST PATH FOUND</span><strong>4 introductions</strong><p>High relationship strength · Same school</p></aside>
      </div>
    </section>

    <section id="how-it-works" className="steps">
      <div className="section-heading"><p className="eyebrow"><i /> HOW IT WORKS</p><h2>From opportunity to introduction.</h2></div>
      <div className="step-grid">
        <article><b>01</b><div className="icon">⌑</div><h3>Share the opportunity</h3><p>Upload a job post or add a role you’re excited about.</p></article>
        <article><b>02</b><div className="icon">⌘</div><h3>See the path</h3><p>We weigh your real connections to find the strongest route.</p></article>
        <article><b>03</b><div className="icon">✦</div><h3>Make the ask</h3><p>Get thoughtful, personalized outreach for every step.</p></article>
      </div>
    </section>
    <section className="promise"><p>“LinkedIn tells you who you know. We tell you the best path to the person who can actually help.”</p></section>

    {notice && <div className="toast">{notice}</div>}
    {showAuth && <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="auth-title" onMouseDown={(e) => e.target === e.currentTarget && setShowAuth(false)}>
      <section className="auth-card">
        <button className="close" aria-label="Close" onClick={() => setShowAuth(false)}>×</button>
        <span className="brand-mark">W</span><h2 id="auth-title">Start with your network.</h2><p>Create your workspace. You’ll decide what data to connect later.</p>
        <button className="google" disabled={busy} onClick={() => void google()}><span className="google-g">G</span> Continue with Google</button>
        <div className="divider"><span>or use your email</span></div>
        <form onSubmit={(e) => void email(e)}>
          <label>Name<input required name="name" autoComplete="name" placeholder="Your name" /></label>
          <label>Email<input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></label>
          <button className="primary full" disabled={busy}>{busy ? 'Creating workspace…' : 'Continue with email'} <span>→</span></button>
        </form>
        <small>Development mode: this saves a local browser session only. Connect a backend before using real accounts or network data.</small>
      </section>
    </div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
