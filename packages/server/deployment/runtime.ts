import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';

export interface RuntimeConfig {
  production: boolean; host: string; port: number; browserOrigin: string;
  googleRedirectUri: string; webRoot: string;
}

/** Only deployment settings are read here. Secret values are never returned/logged. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === 'production';
  const origin = env.APP_ORIGIN ?? (production ? '' : 'http://127.0.0.1:5173');
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('APP_ORIGIN must be an absolute application origin.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.origin !== origin ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !production))) {
    throw new Error('APP_ORIGIN must be HTTPS without a path, credentials, query or trailing slash; local HTTP is development-only.');
  }
  const googleRedirectUri = `${origin}/api/auth/google/callback`;
  if (env.GOOGLE_REDIRECT_URI !== undefined && env.GOOGLE_REDIRECT_URI !== googleRedirectUri) {
    throw new Error('GOOGLE_REDIRECT_URI must equal APP_ORIGIN plus /api/auth/google/callback.');
  }
  const host = env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
  if (host !== 'localhost' && !isIP(host)) throw new Error('HOST must be an IP address or localhost.');
  const portText = env.PORT ?? (production ? '10000' : '3001');
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return { production, host, port: Number(portText), browserOrigin: origin, googleRedirectUri, webRoot: resolve('dist/web') };
}

export interface ProductionHandlerOptions {
  apiHandler: RequestListener;
  webRoot: string;
  /** Check DB/migrations and required adapter installation; do not probe Google per request. */
  readiness?: (signal: AbortSignal) => Promise<boolean>;
  readinessTimeoutMs?: number;
}
const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};
function reply(response: ServerResponse, status: number, text: string, head = false) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(head ? undefined : JSON.stringify({ status: text }));
}
function isInside(root: string, file: string) {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function pathname(request: IncomingMessage): string | null {
  const raw = request.url ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#')) return null;
  try {
    // Parse before URL normalization: encoded dot segments must never reach the filesystem.
    const value = decodeURIComponent(raw.split('?')[0]!);
    if (/[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('//') ||
        value.split('/').some(part => part.startsWith('.'))) return null;
    return value;
  } catch { return null; }
}

/** One-origin routing. Unknown /api routes always stay with the API, never index.html. */
export async function createProductionHandler(options: ProductionHandlerOptions): Promise<RequestListener> {
  const root = await realpath(options.webRoot);
  const indexPath = await realpath(resolve(root, 'index.html'));
  if (!isInside(root, indexPath)) throw new Error('Built web entrypoint escapes the web root.');
  const indexFile = await open(indexPath, 'r');
  try { if (!(await indexFile.stat()).isFile()) throw new Error('Built web entrypoint must be a file.'); }
  finally { await indexFile.close(); }
  const timeoutMs = options.readinessTimeoutMs ?? 1500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new Error('Readiness timeout must be 1–3000 ms.');
  // Share a concurrent probe so host checks cannot exhaust the database pool.
  let pendingProbe: Promise<boolean> | undefined;
  const ready = (): Promise<boolean> => {
    if (pendingProbe) return pendingProbe;
    pendingProbe = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => options.readiness?.(controller.signal) ?? false).then(value => value === true, () => false),
          new Promise<false>(done => { timer = setTimeout(() => { controller.abort(); done(false); }, timeoutMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); pendingProbe = undefined; }
    })();
    return pendingProbe;
  };
  return async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const path = pathname(request), method = request.method ?? 'GET', head = method === 'HEAD';
    if (path === null) { reply(response, 400, 'bad_request', head); return; }
    try {
      if ((method === 'GET' || head) && path === '/api/health') { reply(response, 200, 'ok', head); return; }
      if ((method === 'GET' || head) && path === '/api/ready') {
        const isReady = await ready();
        reply(response, isReady ? 200 : 503, isReady ? 'ready' : 'unavailable', head); return;
      }
      if (path === '/api' || path.startsWith('/api/')) { await options.apiHandler(request, response); return; }
      if (method !== 'GET' && !head) { response.setHeader('Allow', 'GET, HEAD'); reply(response, 405, 'method_not_allowed'); return; }
      let filePath: string;
      try { filePath = await realpath(resolve(root, `.${path}`)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        const wantsHtml = (request.headers.accept ?? '').split(',').some(value => value.trim().split(';')[0] === 'text/html');
        if (!wantsHtml || extname(path) || path === '/assets' || path.startsWith('/assets/')) { reply(response, 404, 'not_found', head); return; }
        filePath = indexPath;
      }
      if (path === '/') filePath = indexPath;
      if (!isInside(root, filePath) || !contentTypes[extname(filePath)]) { reply(response, 404, 'not_found', head); return; }
      const file = await open(filePath, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) { reply(response, 404, 'not_found', head); return; }
        const hashedAsset = path.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path);
        response.writeHead(200, {
          'Content-Type': contentTypes[extname(filePath)]!, 'Content-Length': stat.size,
          'Cache-Control': extname(filePath) === '.html' ? 'no-store' : hashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
        });
        if (head) response.end();
        else {
          // FileHandle stays owned until stream closes, including disconnected clients.
          await new Promise<void>((done, reject) => {
            const stream = file.createReadStream({ autoClose: false });
            const stop = () => stream.destroy();
            response.once('close', stop);
            stream.once('error', reject);
            stream.once('close', () => { response.off('close', stop); done(); });
            stream.once('end', () => stream.destroy());
            stream.pipe(response);
          });
        }
      } finally { await file.close(); }
    } catch {
      if (!response.headersSent) reply(response, 500, 'internal_error', head);
      else response.destroy();
    }
  };
}
