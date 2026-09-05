import { AuthGatewayError, type AuthGateway, type AuthSession } from './session';

const storageKey = 'warmpath.local-preview-session';

/**
 * Development-only UI preview. It is selected only with VITE_AUTH_MODE set to
 * "local-preview" and never represents a Google-authenticated account.
 */
export function createLocalPreviewAuthGateway(): AuthGateway {
  const read = (): AuthSession | null => {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) as AuthSession : null;
  };
  const write = (session: AuthSession) => window.localStorage.setItem(storageKey, JSON.stringify(session));

  return {
    capabilities: { emailSignup: true, googleSignIn: false },
    async currentSession() { return read(); },
    async signUpWithEmail({ name, email }) {
      const normalizedName = name.trim();
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedName || !normalizedEmail) throw new AuthGatewayError('Enter a name and email to preview the workspace.');
      const session: AuthSession = {
        actor: { id: crypto.randomUUID(), displayName: normalizedName, email: normalizedEmail },
        scopes: []
      };
      write(session);
      return session;
    },
    async beginGoogleSignIn() {
      throw new AuthGatewayError('Google sign-in requires the server authentication setup.');
    },
    async signOut() { window.localStorage.removeItem(storageKey); }
  };
}
