/**
 * Display-safe session data returned by the application server. Provider
 * credentials, OAuth tokens, and raw source data never belong in this DTO.
 */
export interface AuthorizedScope {
  id: string;
  label: string;
}

export interface SessionActor {
  id: string;
  displayName: string;
  email?: string;
}

export interface AuthSession {
  actor: SessionActor;
  scopes: AuthorizedScope[];
}

export interface AuthCapabilities {
  emailSignup: boolean;
  googleSignIn: boolean;
}

export interface AuthGateway {
  readonly capabilities: AuthCapabilities;
  currentSession(): Promise<AuthSession | null>;
  signUpWithEmail?(input: { name: string; email: string }): Promise<AuthSession>;
  beginGoogleSignIn(): Promise<void>;
  signOut(): Promise<void>;
}

export class AuthGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthGatewayError';
  }
}
