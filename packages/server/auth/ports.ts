/** Server-only records. Never serialize transactions, hashes or credentials to clients. */
export interface OAuthTransaction {
  stateHash: string; browserBindingHash: string; nonce: string; codeVerifier: string;
  createdAt: number; expiresAt: number;
}
export interface AuthUser { userId: string; googleSubject: string; displayName: string }
export interface StoredSession { tokenHash: string; userId: string; createdAt: number; expiresAt: number; revokedAt: number | null }
export interface AuthStore {
  putOAuthTransaction(transaction: OAuthTransaction): Promise<void>;
  /** Atomic conditional delete-and-return; mismatch/expired returns null. Never consume another browser's transaction. */
  consumeOAuthTransaction(stateHash: string, browserBindingHash: string, now: number): Promise<OAuthTransaction | null>;
  /** Atomic upsert by verified Google subject. Creates one private scope/root for a NEW account only. */
  upsertGoogleUser(input: { googleSubject: string; displayName: string }): Promise<AuthUser>;
  getUser(userId: string): Promise<AuthUser | null>;
  listPrivateScopes(userId: string): Promise<Array<{ id: string; label: string }>>;
  putSession(session: StoredSession): Promise<void>;
  getSession(tokenHash: string): Promise<StoredSession | null>;
  revokeSession(tokenHash: string, now: number): Promise<void>;
}
