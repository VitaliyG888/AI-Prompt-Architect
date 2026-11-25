/** Общие помощники адаптеров: параметры, заголовки, оценка токенов. */
import type { Capabilities, ChatMessage, GenerationParams, TokenUsage } from '../types.ts';
import type { ProviderConnection } from '../types.ts';

export const BASE_CAPABILITIES: Capabilities = {
  text: true,
  systemMessages: false,
  streaming: false,
  jsonMode: false,
  structuredOutput: false,
  tools: false,
  images: false,
  temperature: true,
  topP: true,
  frequencyPenalty: true,
  presencePenalty: true,
  seed: false,
  reasoningEffort: false,
  maxOutputTokens: true,
  usageReporting: true,
  modelListing: false,
};

/** Грубая оценка токенов, когда провайдер не вернул usage. ~4 символа/токен. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateUsage(messages: ChatMessage[], output: string): TokenUsage {
  const input = messages.reduce((acc, m) => acc + estimateTokens(m.content) + 4, 0);
  return { inputTokens: input, outputTokens: estimateTokens(output), estimated: true };
}

export function splitSystem(messages: ChatMessage[]): { system: string[]; rest: ChatMessage[] } {
  const system: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') system.push(message.content);
    else rest.push(message);
  }
  return { system, rest };
}

/** Убирает undefined-параметры, чтобы не отправлять лишние поля. */
export function compactParams(params: GenerationParams | undefined): GenerationParams {
  const out: GenerationParams = {};
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Заголовки авторизации по протоколу. */
export function authHeaders(connection: ProviderConnection): Record<string, string> {
  const headers: Record<string, string> = { ...connection.customHeaders };
  const key = connection.apiKey.trim();
  switch (connection.protocol) {
    case 'anthropic-messages':
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'gemini':
      if (key) headers['x-goog-api-key'] = key;
      break;
    default:
      if (key) headers.authorization = `Bearer ${key}`;
  }
  if (connection.organizationId) headers['openai-organization'] = connection.organizationId;
  return headers;
}

/**
 * Пользовательские заголовки не должны переопределять критические
 * заголовки безопасности и авторизации без явного контроля.
 */
export const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

export function sanitizeCustomHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    if (/[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Проверяет доступность опции у протокола; возвращает null, если нельзя. */
export function pickSupported<K extends keyof GenerationParams>(
  capabilities: Capabilities,
  params: GenerationParams | undefined,
  mapping: Partial<Record<keyof GenerationParams, keyof Capabilities>>,
): GenerationParams {
  const source = compactParams(params);
  const out: GenerationParams = {};
  for (const [paramKey, value] of Object.entries(source)) {
    const capabilityKey = mapping[paramKey as keyof GenerationParams];
    if (!capabilityKey) continue;
    if (capabilities[capabilityKey] === false) continue;
    (out as Record<string, unknown>)[paramKey] = value;
  }
  return out;
}
