import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createAuthGateway, type AuthSession } from './auth';
import { GraphViewport } from './components/GraphViewport';
import './styles.css';

const auth = createAuthGateway();

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    void auth.currentSession()
      .then(setSession)
      .catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'We could not check your session.'))
      .finally(() => setAuthLoading(false));
  }, []);
  const initials = useMemo(() => session?.actor.displayName.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(), [session]);

  async function signOut() {
    setBusy(true);
    setAuthError('');
    try {
      await auth.signOut();
      setSession(null);
      setNotice('You’re signed out.');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'We could not sign you out.');
    } finally { setBusy(false); }
  }
  async function google() {
    setBusy(true);
    setAuthError('');
    try { await auth.beginGoogleSignIn(); }
    catch (error) { setAuthError(error instanceof Error ? error.message : 'Google sign-in could not start.'); setBusy(false); }
  }
  async function email(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setAuthError('');
    try {
      if (!auth.signUpWithEmail) throw new Error('Email sign-up is not configured yet.');
      setSession(await auth.signUpWithEmail({ name: String(data.get('name')), email: String(data.get('email')) }));
      setShowAuth(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'We could not create your workspace.');
    } finally { setBusy(false); }
  }

  return <main>
    <nav className="nav">
      <a className="brand" href="#top" aria-label="WarmPath home"><span className="brand-mark">W</span> WarmPath</a>
      <div className="nav-actions">
        <a href="#how-it-works">How it works</a>
        {authLoading ? <span className="session-status">Checking session…</span>
          : session ? <><span className="avatar" title={session.actor.email ?? session.actor.displayName}>{initials}</span><button className="text-button" disabled={busy} onClick={() => void signOut()}>Sign out</button></>
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
      <GraphViewport snapshot={null} />
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
    {authError && <div className="toast" role="alert">{authError}</div>}
    {showAuth && <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="auth-title" onMouseDown={(e) => e.target === e.currentTarget && setShowAuth(false)}>
      <section className="auth-card">
        <button className="close" aria-label="Close" onClick={() => setShowAuth(false)}>×</button>
        <span className="brand-mark">W</span><h2 id="auth-title">Start with your network.</h2><p>Create your workspace. You’ll decide what data to connect later.</p>
        {auth.capabilities.googleSignIn && <button className="google" disabled={busy} onClick={() => void google()}><span className="google-g">G</span> Continue with Google</button>}
        {auth.capabilities.googleSignIn && auth.capabilities.emailSignup && <div className="divider"><span>or use your email</span></div>}
        {auth.capabilities.emailSignup ? <form onSubmit={(e) => void email(e)}>
          <label>Name<input required name="name" autoComplete="name" placeholder="Your name" /></label>
          <label>Email<input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></label>
          <button className="primary full" disabled={busy}>{busy ? 'Creating workspace…' : 'Continue with email'} <span>→</span></button>
        </form> : <small>Email sign-up will be available when the server account flow is configured.</small>}
        <small>This app stores authentication and provider credentials only on the server. Local preview is explicitly opt-in for UI development.</small>
      </section>
    </div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
