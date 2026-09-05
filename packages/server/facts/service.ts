import { createHash } from 'node:crypto';
import type { AuthPort } from '../service.js';
import { ServiceError } from '../service.js';
import type { FactStore, FactActor } from './contracts.js';
import { validateConfirmFacts, validateFactReview } from './contracts.js';

/** HTTP composition supplies a real server session credential and bounded request bodies. */
export class FactReviewService {
  constructor(private readonly ports: {auth: AuthPort; facts: FactStore}) {}
  private async actor(credential: unknown): Promise<FactActor> {
    const actor = await this.ports.auth.resolveSession(credential);
    if (!actor || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new ServiceError('UNAUTHENTICATED', 401);
    return {userId: actor.userId, sessionHash: createHash('sha256').update(credential).digest('hex')};
  }
  async review(credential: unknown, input: unknown) {
    const request = validateFactReview(input);
    return this.ports.facts.review(await this.actor(credential), request);
  }
  async confirm(credential: unknown, input: unknown) {
    const request = validateConfirmFacts(input);
    return this.ports.facts.confirm(await this.actor(credential), request);
  }
}
