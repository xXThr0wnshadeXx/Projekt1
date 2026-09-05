import { AuthGatewayError, type AuthGateway, type AuthSession } from './session';

const defaultApiBase = '/api';

function apiUrl(path: string, apiBase = defaultApiBase) {
  return `${apiBase.replace(/\/$/, '')}${path}`;
}

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `Request failed (${response.status}).`;
}

/**
 * Browser adapter for the server-owned session API. Google authentication is
 * deliberately a full-page server redirect so the browser never receives an
 * OAuth credential. Route names are the architecture's provisional boundary.
 */
export function createHttpAuthGateway(apiBase = defaultApiBase): AuthGateway {
  return {
    capabilities: { emailSignup: false, googleSignIn: true },
    async currentSession(): Promise<AuthSession | null> {
      const response = await fetch(apiUrl('/session', apiBase), { credentials: 'include' });
      if (response.status === 401) return null;
      if (!response.ok) throw new AuthGatewayError(await readError(response));
      return response.json() as Promise<AuthSession>;
    },
    async beginGoogleSignIn() {
      // The backend owns state, callback validation, token exchange and cookie creation.
      window.location.assign(apiUrl('/auth/google/start', apiBase));
    },
    async signOut() {
      const response = await fetch(apiUrl('/auth/logout', apiBase), {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) throw new AuthGatewayError(await readError(response));
    }
  };
}
