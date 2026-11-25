/**
 * HTTP-клиент для обращения к внешним API (LLM, поиск).
 *
 * Возможности: жёсткий таймаут, ограничение размера ответа, безопасные
 * сообщения об ошибках (тело ответа не попадает в текст ошибки целиком),
 * разбор Retry-After, отмена через AbortSignal.
 */
import { AppError, classifyUpstreamStatus } from './errors.ts';
import { log } from './logger.ts';

export interface HttpJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Метка провайдера для сообщений об ошибках. */
  label: string;
  /** Не логировать тело запроса (по умолчанию true). */
  sensitive?: boolean;
}

export interface HttpJsonResult<T> {
  data: T;
  status: number;
  headers: Headers;
  durationMs: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('UPSTREAM_ERROR', `Ответ превысил лимит ${maxBytes} байт`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** Извлекает человекочитаемое сообщение об ошибке из тела ответа API. */
export function extractUpstreamMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return error.slice(0, 300);
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message.slice(0, 300);
    }
    if (typeof parsed.message === 'string') return parsed.message.slice(0, 300);
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 300);
  } catch {
    /* тело не JSON */
  }
  return body.slice(0, 300);
}

export async function httpJson<T>(url: string, options: HttpJsonOptions): Promise<HttpJsonResult<T>> {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
    label,
    sensitive = true,
  } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new AppError('REQUEST_TIMEOUT', `${label}: таймаут ${timeoutMs} мс`)), timeoutMs);

  const onExternalAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      throw new AppError('CANCELLED', 'Запрос отменён');
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow',
    });

    const text = await readLimited(response, maxBytes);
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const detail = extractUpstreamMessage(text);
      log.warn('upstream request failed', {
        label,
        status: response.status,
        durationMs,
        ...(sensitive ? {} : { requestBody: body }),
        detail,
      });
      const error = classifyUpstreamStatus(response.status, label);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw new AppError(error.code, detail ? `${error.message}: ${detail}` : error.message, {
        retryAfterMs,
        details: { status: response.status },
      });
    }

    let data: T;
    try {
      data = text ? (JSON.parse(text) as T) : ({} as T);
    } catch (error) {
      throw new AppError('UPSTREAM_ERROR', `${label}: ответ не является JSON`, {
        cause: error,
        details: { snippet: text.slice(0, 200) },
      });
    }

    return { data, status: response.status, headers: response.headers, durationMs };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === 'AbortError') {
      const reason = controller.signal.reason;
      if (reason instanceof AppError) throw reason;
      throw new AppError('CANCELLED', 'Запрос отменён');
    }
    throw new AppError('PROVIDER_UNAVAILABLE', `${label}: сетевая ошибка — ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Задержка с поддержкой отмены. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('CANCELLED', 'Запрос отменён'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('CANCELLED', 'Запрос отменён'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
