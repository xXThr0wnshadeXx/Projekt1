import {createHash} from 'node:crypto';
import type {AuthPort} from '../service.js';
import {ServiceError} from '../service.js';
import type {FactActor} from '../facts/contracts.js';
import type {PublicFactsStore} from './contracts.js';
import {validatePublicReview, validatePublicResolution} from './contracts.js';
import {validatePublicStage} from './validation.js';

export class PublicFactsService {
  constructor(private readonly ports: {auth: AuthPort; publicFacts: PublicFactsStore}) {}
  private async actor(credential: unknown): Promise<FactActor> {
    const actor = await this.ports.auth.resolveSession(credential);
    if (!actor || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new ServiceError('UNAUTHENTICATED', 401);
    return {userId: actor.userId, sessionHash: createHash('sha256').update(credential).digest('hex')};
  }
  /** Server-private source/extraction bridge ONLY. Do not expose as a client envelope upload route. */
  async stage(credential: unknown, input: unknown) {
    const actor = await this.actor(credential), request = validatePublicStage(input);
    return this.ports.publicFacts.stage(actor, request);
  }
  async review(credential: unknown, input: unknown) {
    const request = validatePublicReview(input);
    return this.ports.publicFacts.review(await this.actor(credential), request);
  }
  async resolve(credential: unknown, input: unknown) {
    const request = validatePublicResolution(input);
    return this.ports.publicFacts.resolve(await this.actor(credential), request);
  }
}
