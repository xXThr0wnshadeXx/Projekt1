import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createAuthGateway, type AuthSession } from './auth';
import { GraphViewport } from './components/GraphViewport';
import { GraphApiError, loadGraph, searchGraph } from './api/graphClient';
import type { GraphSnapshot, OpportunityPath, SearchEvent, SearchResult } from '../contracts/index';
import './styles.css';

const auth = createAuthGateway();
type DiscoveryIntent = {
  company: string;
  recruiter: string;
  location: string;
  field: string;
  linkedinUrl: string;
  instagramUrl: string;
};

function safeSelectedPathIds(result: SearchResult, snapshot: GraphSnapshot): string[] | null {
  if (result.scopeId !== snapshot.scopeId || result.graphVersion !== snapshot.graphVersion || !Array.isArray(result.events)) return null;
  const resultPathIds = new Set(result.paths.map((path) => path.id));
  const selected: string[] = [];
  for (let index = 0; index < result.events.length; index += 1) {
    const event = result.events[index] as Partial<SearchEvent>;
    if (event.scopeId !== result.scopeId || event.graphVersion !== result.graphVersion || event.searchId !== result.searchId || event.seq !== index + 1 || !isSafeEvent(event)) return null;
    if (event.type === 'PATH_SELECTED') {
      const pathId = (event as Extract<SearchEvent, { type: 'PATH_SELECTED' }>).pathId;
      if (typeof pathId !== 'string' || !resultPathIds.has(pathId) || selected.includes(pathId)) return null;
      selected.push(pathId);
    }
  }
  return selected;
}

function isSafeEvent(event: Partial<SearchEvent>): boolean {
  if (!event.type || !['SEARCH_STARTED', 'NODE_VISITED', 'EDGE_EXPLORED', 'PATH_PRUNED', 'TARGET_FOUND', 'PATH_CANDIDATE', 'PATH_SELECTED', 'SEARCH_COMPLETED', 'SEARCH_FAILED'].includes(event.type)) return false;
  if (event.type === 'NODE_VISITED' || event.type === 'PATH_PRUNED') return Array.isArray(event.prefixPersonIds) && event.prefixPersonIds.every((id) => typeof id === 'string');
  if (event.type === 'EDGE_EXPLORED') return typeof event.fromPersonId === 'string' && typeof event.toPersonId === 'string' && typeof event.edgeId === 'string';
  if (event.type === 'TARGET_FOUND') return typeof event.personId === 'string';
  if (event.type === 'PATH_SELECTED') return typeof event.pathId === 'string';
  return true;
}

function peopleForEvent(event: SearchEvent): string[] {
  if (event.type === 'NODE_VISITED' || event.type === 'PATH_PRUNED') return event.prefixPersonIds;
  if (event.type === 'EDGE_EXPLORED') return [event.fromPersonId, event.toPersonId];
  if (event.type === 'TARGET_FOUND') return [event.personId];
  return [];
}

function App() {
  useScrollReveal();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState('');
  const [goalText, setGoalText] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<OpportunityPath[]>([]);
  const [activePersonIds, setActivePersonIds] = useState<string[]>([]);
  const [intentStatus, setIntentStatus] = useState('');
  const replayTimer = useRef<number | null>(null);

  useEffect(() => {
    void auth.currentSession()
      .then(setSession)
      .catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'We could not check your session.'))
      .finally(() => setAuthLoading(false));
  }, []);
  useEffect(() => {
    const firstScope = session?.scopes[0]?.id ?? '';
    setScopeId(firstScope);
    setSnapshot(null);
    setSelectedPaths([]);
    setSearchResult(null);
    setGraphError('');
    setIntentStatus('');
  }, [session]);
  useEffect(() => {
    if (!session || !scopeId) return;
    let cancelled = false;
    setGraphLoading(true);
    setGraphError('');
    void loadGraph(scopeId).then((next) => {
      if (!cancelled) setSnapshot(next);
    }).catch((error: unknown) => {
      if (!cancelled) setGraphError(error instanceof Error ? error.message : 'We could not load this graph.');
    }).finally(() => { if (!cancelled) setGraphLoading(false); });
    return () => { cancelled = true; };
  }, [session, scopeId]);
  useEffect(() => () => { if (replayTimer.current !== null) window.clearTimeout(replayTimer.current); }, []);
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
  function replay(result: SearchResult, pathIds: string[]) {
    if (replayTimer.current !== null) window.clearTimeout(replayTimer.current);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const paths = pathIds.map((id) => result.paths.find((path) => path.id === id)).filter((path): path is OpportunityPath => Boolean(path));
    setSelectedPaths([]);
    setActivePersonIds([]);
    if (reducedMotion || result.events.length === 0) { setSelectedPaths(paths); return; }
    let index = 0;
    const next = () => {
      const event = result.events[index++];
      if (!event) return;
      setActivePersonIds(peopleForEvent(event));
      if (event.type === 'PATH_SELECTED') setSelectedPaths((current) => [...current, paths.find((path) => path.id === event.pathId)!].filter(Boolean));
      replayTimer.current = window.setTimeout(next, 350);
    };
    next();
  }
  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !scopeId || !snapshot || !goalText.trim()) return;
    setSearching(true); setSearchError(''); setSearchResult(null); setSelectedPaths([]);
    try {
      const result = await searchGraph({ scopeId, expectedGraphVersion: snapshot.graphVersion, goalText: goalText.trim() });
      const pathIds = safeSelectedPathIds(result, snapshot);
      if (pathIds === null) throw new Error('The search response could not be safely replayed. Reload the graph and try again.');
      setSearchResult(result);
      replay(result, pathIds);
    } catch (error) {
      const message = error instanceof GraphApiError && error.code === 'VERSION_CONFLICT' ? 'Your graph changed. Reload it and run the search again.' : error instanceof Error ? error.message : 'We could not search this graph.';
      setSearchError(message);
    } finally { setSearching(false); }
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
  function saveIntent(intent: DiscoveryIntent) {
    if (!session) { setShowAuth(true); return; }
    const routeGoal = [intent.company, intent.recruiter, intent.location, intent.field]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(' ');
    setGoalText(routeGoal);
    setIntentStatus('Goal added to Route Search. Connect an authorized source before finding supported paths.');
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
      <div className="hero-copy scroll-reveal scroll-reveal--left">
        <p className="eyebrow"><i /> YOUR NETWORK, MADE ACTIONABLE</p>
        <h1>Find your way <em>in.</em></h1>
        <p className="lede">Turn a job post into the strongest, most human path to the person who can help.</p>
        <div className="hero-buttons">
          <button className="primary" onClick={() => setShowAuth(true)}>Build your first path <span>→</span></button>
          <a className="secondary" href="#how-it-works">See how it works <span>↓</span></a>
        </div>
        <p className="privacy-note">✦ Your network stays private. You choose what to connect.</p>
      </div>
      <div className="scroll-reveal scroll-reveal--right"><GraphViewport snapshot={snapshot} loading={graphLoading} error={graphError} selectedPaths={selectedPaths} activePersonIds={activePersonIds} /></div>
    </section>

    <DiscoveryIntentForm signedIn={Boolean(session)} resetKey={`${session?.actor.id ?? 'signed-out'}:${scopeId}`} onSignIn={() => setShowAuth(true)} onSave={saveIntent} onClear={() => setIntentStatus('')} status={intentStatus} />

    <section className="search-panel scroll-reveal scroll-reveal--rise" aria-labelledby="search-title">
      <div><p className="eyebrow"><i /> ROUTE SEARCH</p><h2 id="search-title">Explore a supported path.</h2><p>Once discovery has returned an authorized graph, the server resolves your goal and selects routes. WarmPath only displays returned facts and paths.</p></div>
      {session && session.scopes.length > 0 ? <form onSubmit={(event) => void submitSearch(event)}>
        <label>Authorized graph scope<select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>{session.scopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label>
        <label>Your goal<input value={goalText} onChange={(event) => setGoalText(event.target.value)} placeholder="e.g. PayPal early talent recruiter" required /></label>
        <button className="primary" disabled={searching || graphLoading || !snapshot}>{searching ? 'Finding paths…' : 'Find authorized paths'} <span>→</span></button>
      </form> : <p className="search-disabled" role="status">Sign in and connect at least one authorized scope before searching. This app will not search a graph it cannot access.</p>}
      {searchError && <p className="search-error" role="alert">{searchError}</p>}
      {searchResult && <SearchSummary result={searchResult} selectedPaths={selectedPaths} snapshot={snapshot} />}
    </section>

    <section id="how-it-works" className="steps">
      <div className="section-heading scroll-reveal scroll-reveal--left"><p className="eyebrow"><i /> HOW IT WORKS</p><h2>From opportunity to introduction.</h2></div>
      <div className="step-grid">
        <article className="scroll-reveal scroll-reveal--rise"><b>01</b><div className="icon">⌑</div><h3>Share the opportunity</h3><p>Upload a job post or add a role you’re excited about.</p></article>
        <article className="scroll-reveal scroll-reveal--rise scroll-reveal--delay-1"><b>02</b><div className="icon">⌘</div><h3>See the path</h3><p>We weigh your real connections to find the strongest route.</p></article>
        <article className="scroll-reveal scroll-reveal--rise scroll-reveal--delay-2"><b>03</b><div className="icon">✦</div><h3>Make the ask</h3><p>Get thoughtful, personalized outreach for every step.</p></article>
      </div>
    </section>
    <section className="promise scroll-reveal scroll-reveal--pop"><p>“LinkedIn tells you who you know. We tell you the best path to the person who can actually help.”</p></section>

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

function DiscoveryIntentForm({ signedIn, resetKey, onSignIn, onSave, onClear, status }: { signedIn: boolean; resetKey: string; onSignIn: () => void; onSave: (intent: DiscoveryIntent) => void; onClear: () => void; status: string }) {
  const emptyIntent = (): DiscoveryIntent => ({ company: '', recruiter: '', location: '', field: '', linkedinUrl: '', instagramUrl: '' });
  const [intent, setIntent] = useState<DiscoveryIntent>(emptyIntent);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => { setIntent(emptyIntent()); setErrors([]); }, [resetKey]);
  const change = (field: keyof DiscoveryIntent) => (event: ChangeEvent<HTMLInputElement>) => {
    setIntent((current) => ({ ...current, [field]: event.target.value }));
    setErrors([]);
    onClear();
  };
  function clear() { setIntent(emptyIntent()); setErrors([]); onClear(); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateDiscoveryIntent(intent);
    if (nextErrors.length > 0) { setErrors(nextErrors); return; }
    onSave(intent);
  }
  return <section className="intent-panel scroll-reveal scroll-reveal--rise" aria-labelledby="intent-title">
    <div className="intent-heading"><p className="eyebrow"><i /> START A CONNECTION QUEST</p><h2 id="intent-title">What do you want to do?</h2><p>Tell us who or what you want to get closer to. We will only look for evidence the secure service is authorized to use.</p></div>
    <form className="intent-form" onSubmit={(event) => void submit(event)}>
      <label>Company<input value={intent.company} onChange={change('company')} placeholder="e.g. PayPal" /></label>
      <label>Recruiter or person<input value={intent.recruiter} onChange={change('recruiter')} placeholder="Name or “early talent recruiter”" /></label>
      <label>Location<input value={intent.location} onChange={change('location')} placeholder="e.g. San Jose, CA" /></label>
      <label>Field or role<input value={intent.field} onChange={change('field')} placeholder="e.g. product design internship" /></label>
      <fieldset className="profile-links"><legend>Optional profile links — not used for discovery yet</legend><label>LinkedIn profile<input value={intent.linkedinUrl} onChange={change('linkedinUrl')} type="url" placeholder="https://linkedin.com/in/..." /></label><label>Instagram profile<input value={intent.instagramUrl} onChange={change('instagramUrl')} type="url" placeholder="https://instagram.com/..." /></label></fieldset>
      {signedIn ? <button className="primary intent-submit">Save this connection goal <span>→</span></button> : <button type="button" className="primary intent-submit" onClick={onSignIn}>Sign in to start <span>→</span></button>}
      <button type="button" className="text-button intent-clear" onClick={clear}>Clear this goal</button>
      <p className="intent-privacy">Add a company or person target to prepare Route Search. Profile links are optional, not sent to discovery, and will only support an explicit reviewed export flow when that feature is available. We do not scrape private networks or retain this draft after you leave the page.</p>
      {errors.length > 0 && <div className="intent-errors" role="alert"><strong>Before discovery can start:</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      {status && <p className="intent-status" role="status">{status}</p>}
    </form>
  </section>;
}

function validateDiscoveryIntent(intent: DiscoveryIntent): string[] {
  const errors: string[] = [];
  const targetProvided = Boolean(intent.company.trim() || intent.recruiter.trim());
  if (!targetProvided) errors.push('Add a company or recruiter/person target.');
  const linkedinError = optionalProfileUrlError(intent.linkedinUrl, 'linkedin.com', 'LinkedIn');
  const instagramError = optionalProfileUrlError(intent.instagramUrl, 'instagram.com', 'Instagram');
  if (linkedinError) errors.push(linkedinError);
  if (instagramError) errors.push(instagramError);
  return errors;
}

function optionalProfileUrlError(value: string, domain: string, label: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    const validHost = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    const hasProfilePath = url.pathname.split('/').filter(Boolean).length > 0;
    return url.protocol === 'https:' && validHost && hasProfilePath ? null : `Use a complete https ${label} profile URL.`;
  } catch { return `Use a complete https ${label} profile URL.`; }
}

function useScrollReveal() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('.scroll-reveal'));
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || !('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add('is-in-view'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => entry.target.classList.toggle('is-in-view', entry.isIntersecting));
    }, { threshold: 0.14, rootMargin: '0px 0px -4% 0px' });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);
}

function SearchSummary({ result, selectedPaths, snapshot }: { result: SearchResult; selectedPaths: OpportunityPath[]; snapshot: GraphSnapshot | null }) {
  const name = (id: string) => snapshot?.people.find((person) => person.id === id)?.displayName ?? 'Unknown person';
  return <section className="search-summary" aria-live="polite"><p><strong>Server search:</strong> {result.stats.expansions} expansions in {result.stats.elapsedMs}ms · {result.stats.stop.replaceAll('_', ' ').toLowerCase()}.</p>
    {selectedPaths.length > 0 ? <><h3>Selected server routes</h3><ol>{selectedPaths.map((path) => <li key={path.id}><strong>{path.personIds.map(name).join(' → ')}</strong><span>{path.explanation.summary}</span>{path.explanation.uncertainties.length > 0 && <small>Uncertainties: {path.explanation.uncertainties.join(' ')}</small>}</li>)}</ol></> : <p>No route has been selected by the server yet.</p>}
    {[...result.warnings, ...(result.stats.traceTruncated ? [`Search trace omitted ${result.stats.omittedTraceEvents} events.`] : [])].map((warning, index) => <p className="search-warning" key={`${warning}-${index}`}>{warning}</p>)}</section>;
}

createRoot(document.getElementById('root')!).render(<App />);
