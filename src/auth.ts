import { createHttpAuthGateway } from './auth/httpGateway';
import { createLocalPreviewAuthGateway } from './auth/localPreviewGateway';

export * from './auth/session';

/**
 * HTTP is the default in every environment. Local preview must be explicitly
 * requested with VITE_AUTH_MODE=local-preview; it is never a production fallback.
 */
export function createAuthGateway() {
  const mode = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_AUTH_MODE;
  return mode === 'local-preview'
    ? createLocalPreviewAuthGateway()
    : createHttpAuthGateway();
}
