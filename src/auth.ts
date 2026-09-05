export type AuthProvider = 'email' | 'google';

export interface User {
  id: string;
  name: string;
  email: string;
  provider: AuthProvider;
}

export interface AuthGateway {
  currentUser(): Promise<User | null>;
  signUpWithEmail(input: { name: string; email: string }): Promise<User>;
  signInWithGoogle(): Promise<User>;
  signOut(): Promise<void>;
}

const storageKey = 'warmpath.dev-user';

/**
 * Development-only adapter. Swap this factory for a server-backed adapter when
 * authentication and persistence are selected. It intentionally does not store
 * passwords, OAuth tokens, contacts, or graph data in the browser.
 */
export function createAuthGateway(): AuthGateway {
  const read = (): User | null => {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as User) : null;
  };
  const write = (user: User) => window.localStorage.setItem(storageKey, JSON.stringify(user));

  return {
    async currentUser() { return read(); },
    async signUpWithEmail({ name, email }) {
      const user = { id: crypto.randomUUID(), name: name.trim(), email: email.trim().toLowerCase(), provider: 'email' as const };
      write(user);
      return user;
    },
    async signInWithGoogle() {
      // Replace with a server-initiated OAuth redirect. A local identity is only
      // used to let the unfinished UI be explored without credentials.
      const user = { id: crypto.randomUUID(), name: 'Google user', email: 'google-user@local.preview', provider: 'google' as const };
      write(user);
      return user;
    },
    async signOut() { window.localStorage.removeItem(storageKey); }
  };
}
