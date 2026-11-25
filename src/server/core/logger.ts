/**
 * Журналирование без утечки секретов. Все сообщения проходят через
 * redact(): ключи, токены, bearer-заголовки и query-параметры с ключами
 * вырезаются до записи.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_-]{12,})/g, 'sk-***'],
  [/(sk-ant-[A-Za-z0-9_-]{8,})/g, 'sk-ant-***'],
  [/(AIza[0-9A-Za-z_-]{20,})/g, 'AIza***'],
  [/(Bearer\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi, '$1***'],
  [/\b(api[_-]?key|apikey|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi, '$1$2***'],
  [/([?&](?:key|api_key|apikey|token|access_token)=)([^&\s]+)/gi, '$1***'],
];

export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api_?key|apikey|authorization|token|secret|password)$/i.test(key)) {
        out[key] = '***';
      } else {
        out[key] = redactDeep(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: redact(message),
    ...(meta ? { meta: redactDeep(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
