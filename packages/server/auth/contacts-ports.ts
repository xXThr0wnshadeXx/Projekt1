import type { OAuthTransaction } from './ports.js';
/** Server-private only. Epoch milliseconds. Separate table/purpose from login OAuth. */
export interface ContactsTransaction extends OAuthTransaction {
  purpose: 'GOOGLE_CONTACTS'; actorUserId: string; sessionHash: string;
  scopeId: string; sourceId: string; googleSubject: string;
}
export interface ContactsGrant {
  ownerUserId: string; scopeId: string; sourceId: string; googleSubject: string;
  grantedScopes: string[]; accessTokenCiphertext: string; accessExpiresAt: number;
  refreshTokenCiphertext: string | null; refreshExpiresAt: number | null;
  createdAt: number; updatedAt: number; revokedAt: number | null;
  /** Random opaque version, compare-and-swap prevents a refresh overwriting newer consent/revocation. */
  version: string;
}
export interface ContactsStore {
  putContactsTransaction(transaction: ContactsTransaction): Promise<void>;
  /** Atomic delete-and-return only when all bindings match and unexpired; never consume a different actor/browser/session. */
  consumeContactsTransaction(input: {stateHash: string; browserBindingHash: string; sessionHash: string; actorUserId: string; now: number}): Promise<ContactsTransaction | null>;
  /** Recheck the initiating session and private scope ownership inside the write transaction.
   * Lock session before scope, serializing with logout; check expiry after lock waits.
   * Atomically enable/provision the bound Google source and store credentials.
   * Preserve one source per (ownerUserId, scopeId, googleSubject). No graph relationships are inferred here.
   */
  commitContactsGrant(grant: ContactsGrant, sessionHash: string): Promise<void>;
  /** MUST join/check current source and private-scope ownership/enabled state; no cross-owner lookup. */
  getContactsGrant(ownerUserId: string, sourceId: string): Promise<ContactsGrant | null>;
  /** Conditional update under owner/source/version + not revoked; recheck current scope/source enabled. */
  replaceContactsGrant(grant: ContactsGrant, expectedVersion: string): Promise<boolean>;
  /** Conditional credential revocation only; does not delete already imported evidence. */
  revokeContactsGrant(ownerUserId: string, sourceId: string, expectedVersion: string, now: number): Promise<boolean>;
}
