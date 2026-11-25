/** Помощники HTTP-ответов: JSON, ошибки, разбор тела, безопасные заголовки. */
import { AppError, toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
};

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function errorResponse(error: unknown): Response {
  const appError = toAppError(error);
  if (appError.status >= 500) {
    log.error('request failed', { code: appError.code, message: appError.message });
  }
  return json(appError.toPublic(), appError.status);
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new AppError('BAD_REQUEST', 'Ожидается Content-Type: application/json');
  }

  const reader = request.body?.getReader();
  if (!reader) return {};

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('BAD_REQUEST', `Тело запроса превышает ${MAX_BODY_BYTES} байт`);
    }
    chunks.push(value);
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('BAD_REQUEST', 'Тело запроса должно быть JSON-объектом');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('BAD_REQUEST', 'Некорректный JSON в теле запроса');
  }
}

/** Разбор SSE-подобного потока не нужен: прогресс отдаётся событиями NDJSON. */
export function streamEvents(): {
  stream: ReadableStream<Uint8Array>;
  send: (event: unknown) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  return {
    stream,
    send(event: unknown) {
      if (closed || !controller) return;
      try {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed || !controller) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* уже закрыт */
      }
    },
  };
}

export function ndjsonStreamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    },
  });
}
