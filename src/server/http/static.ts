/** Раздача статики с защитой от traversal и корректными MIME. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from '../env.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * CSP: разрешаем только собственные ресурсы. Инлайн-стили нужны для
 * динамического рендера, скриптов инлайн нет.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

export function serveStatic(pathname: string, method: string): Response | null {
  if (method !== 'GET' && method !== 'HEAD') return null;

  const webRoot = resolve(config.webDir);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let filePath = resolve(join(webRoot, safePath));

  // Защита от выхода за пределы web/: сравнение по реальному корню.
  if (filePath !== webRoot && !filePath.startsWith(webRoot + sep)) return null;
  if (!existsSync(filePath)) {
    // SPA-фолбэк: неизвестный путь без расширения отдаём как index.html.
    if (!extname(safePath)) filePath = join(webRoot, 'index.html');
    if (!existsSync(filePath)) return null;
  }

  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    const indexPath = join(filePath, 'index.html');
    if (!existsSync(indexPath)) return null;
    filePath = indexPath;
  }

  const ext = extname(filePath).toLowerCase();
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': String(statSync(filePath).size),
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'content-security-policy': CSP,
    ...SECURITY_HEADERS,
  };

  if (method === 'HEAD') return new Response(null, { status: 200, headers });

  const stream = createReadStream(filePath);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      stream.on('end', () => controller.close());
      stream.on('error', (error) => controller.error(error));
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(body, { status: 200, headers });
}
