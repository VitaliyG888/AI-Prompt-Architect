/**
 * Структурированные ошибки приложения. Каждая ошибка имеет машинный код,
 * HTTP-статус и безопасное для клиента сообщение. Внутренние детали
 * (включая тела ответов провайдеров и секреты) остаются в логах.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'REQUEST_TIMEOUT'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNSUPPORTED_FEATURE'
  | 'BLOCKED_URL'
  | 'SEARCH_NOT_CONFIGURED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL'
  | 'CANCELLED';

const statusByCode: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PROVIDER_NOT_CONFIGURED: 400,
  PROVIDER_AUTH_FAILED: 502,
  PROVIDER_UNAVAILABLE: 502,
  MODEL_NOT_FOUND: 502,
  RATE_LIMITED: 429,
  REQUEST_TIMEOUT: 504,
  UNSUPPORTED_PROTOCOL: 400,
  UNSUPPORTED_FEATURE: 400,
  BLOCKED_URL: 400,
  SEARCH_NOT_CONFIGURED: 400,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
  CANCELLED: 499,
};

/** Какие ошибки имеет смысл повторять (временные/устранимые). */
const retryableCodes = new Set<ErrorCode>([
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
  'UPSTREAM_ERROR',
]);

/** Какие ошибки оправдывают переключение на резервный маршрут. */
const fallbackCodes = new Set<ErrorCode>([
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
  'UPSTREAM_ERROR',
  'MODEL_NOT_FOUND',
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = statusByCode[code] ?? 500;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return retryableCodes.has(this.code);
  }

  get allowsFallback(): boolean {
    return fallbackCodes.has(this.code);
  }

  toPublic(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Приводит любую ошибку к AppError, не теряя исходную причину. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new AppError('CANCELLED', 'Запрос отменён', { cause: error });
    }
    if (error.name === 'TimeoutError') {
      return new AppError('REQUEST_TIMEOUT', 'Истекло время ожидания запроса', { cause: error });
    }
    return new AppError('INTERNAL', error.message, { cause: error });
  }
  return new AppError('INTERNAL', 'Неизвестная ошибка', { cause: error });
}

/** Классифицирует HTTP-ответ провайдера в понятный код ошибки. */
export function classifyUpstreamStatus(status: number, providerLabel: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError('PROVIDER_AUTH_FAILED', `${providerLabel}: аутентификация отклонена (${status})`);
  }
  if (status === 404) {
    return new AppError('MODEL_NOT_FOUND', `${providerLabel}: endpoint или модель не найдены (404)`);
  }
  if (status === 408 || status === 504) {
    return new AppError('REQUEST_TIMEOUT', `${providerLabel}: провайдер не ответил вовремя (${status})`);
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', `${providerLabel}: превышен лимит запросов (429)`);
  }
  if (status >= 500) {
    return new AppError('PROVIDER_UNAVAILABLE', `${providerLabel}: сбой на стороне провайдера (${status})`);
  }
  return new AppError('UPSTREAM_ERROR', `${providerLabel}: запрос отклонён (${status})`);
}
