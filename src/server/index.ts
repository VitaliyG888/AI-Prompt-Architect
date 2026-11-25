/**
 * Точка входа HTTP-сервера.
 *
 * node:http + web Request/Response. Без внешних зависимостей.
 * Слушает только 127.0.0.1 по умолчанию; наружу — только с APP_TOKEN.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { config } from './env.ts';
import { createApp, type CreateAppOptions } from './app.ts';
import { Router } from './http/router.ts';
import { json, errorResponse } from './http/respond.ts';
import { serveStatic } from './http/static.ts';
import { assertAuthorized } from './api/helpers.ts';
import { registerProjectRoutes } from './api/projects.ts';
import { registerSkillRoutes } from './api/skills.ts';
import { registerConfigRoutes } from './api/config.ts';
import { log } from './core/logger.ts';
import { toAppError } from './core/errors.ts';

export function buildRouter(app: ReturnType<typeof createApp>): Router {
  const router = new Router();
  registerProjectRoutes(router, { app });
  registerSkillRoutes(router, { app });
  registerConfigRoutes(router, { app });
  return router;
}

function toWebRequest(req: IncomingMessage, origin: string): Request {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else headers.set(key, String(value));
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // Требуется Node для duplex-стримов.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
  res.end();
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  app: ReturnType<typeof createApp>;
}

export async function startServer(options: CreateAppOptions & { port?: number; host?: string } = {}): Promise<RunningServer> {
  const app = createApp(options);
  const router = buildRouter(app);
  const port = options.port ?? config.port;
  const host = options.host ?? config.host;

  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
    const pathname = (() => {
      try {
        return new URL(req.url ?? '/', origin).pathname;
      } catch {
        return '/';
      }
    })();

    void (async () => {
      try {
        // Статика не требует токена: это локальный интерфейс.
        const isApi = pathname.startsWith('/api/');
        if (!isApi) {
          const staticResponse = serveStatic(pathname, (req.method ?? 'GET').toUpperCase());
          if (staticResponse) {
            await writeWebResponse(res, staticResponse);
            return;
          }
          // Неизвестный не-API путь: отдаём интерфейс (SPA), а не 404 JSON.
          const fallback = serveStatic('/', 'GET');
          if (fallback) {
            await writeWebResponse(res, fallback);
            return;
          }
        }

        const request = toWebRequest(req, origin);
        assertAuthorized(request);

        const match = router.match(request.method, pathname);
        if (!match) {
          if (router.hasPath(pathname)) {
            await writeWebResponse(res, json({ error: { code: 'BAD_REQUEST', message: 'Метод не поддерживается' } }, 405));
            return;
          }
          await writeWebResponse(res, json({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден' } }, 404));
          return;
        }

        const url = new URL(request.url);
        const response = await match.handler({
          params: match.params,
          query: url.searchParams,
          request,
          url,
        });
        await writeWebResponse(res, response);
      } catch (error) {
        const appError = toAppError(error);
        if (!res.headersSent) {
          await writeWebResponse(res, errorResponse(appError));
        } else {
          log.error('error after headers sent', { code: appError.code });
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  log.info('server listening', { url });

  return {
    url,
    port: actualPort,
    app,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          app.close();
          resolve();
        });
      }),
  };
}

// Запуск при прямом вызове файла.
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('src/server/index.ts');
if (isMain) {
  startServer().catch((error) => {
    log.error('failed to start server', { message: toAppError(error).message });
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info('shutting down', { signal });
      process.exit(0);
    });
  }
}
