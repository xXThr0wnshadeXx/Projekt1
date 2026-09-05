import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceError } from '../service.js';
export interface CredentialBinding { ownerUserId: string; scopeId: string; sourceId: string; googleSubject: string }
export type CredentialKind = 'access' | 'refresh';
/** AES-256-GCM with a new 96-bit IV per encryption and owner/source/type bound additional data. */
export class ProviderTokenCipher {
  private readonly key: Buffer;
  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, 'base64url');
    if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey) || key.length !== 32 || key.toString('base64url') !== encodedKey) throw new ServiceError('SOURCE_UNAVAILABLE', 502);
    this.key = key;
  }
  private aad(binding: CredentialBinding, kind: CredentialKind): Buffer {
    return Buffer.from(JSON.stringify(['projekt1-google-contacts-v1', binding.ownerUserId, binding.scopeId, binding.sourceId, binding.googleSubject, kind]));
  }
  encrypt(value: string, binding: CredentialBinding, kind: CredentialKind): string {
    if (!value || value.length > 16384) throw new ServiceError('SOURCE_UNAVAILABLE', 502);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(binding, kind));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }
  decrypt(value: string, binding: CredentialBinding, kind: CredentialKind): string {
    try {
      const parts = value.split('.'); if (parts.length !== 4 || parts[0] !== 'v1' || value.length > 24000) throw new Error();
      const [iv, tag, encrypted] = parts.slice(1).map(part => {
        if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
        const result = Buffer.from(part, 'base64url'); if (result.toString('base64url') !== part) throw new Error(); return result;
      });
      if (!iv || !tag || !encrypted || iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAAD(this.aad(binding, kind)); decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      if (!plaintext || plaintext.length > 16384) throw new Error(); return plaintext;
    } catch { throw new ServiceError('SOURCE_UNAVAILABLE', 502); }
  }
}
