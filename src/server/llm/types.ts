/**
 * Контракты слоя LLM.
 *
 * Приложение работает только через LLMClient и этот интерфейс. Провайдеры
 * подключаются адаптерами, каждый адаптер явно описывает поддерживаемые
 * возможности, чтобы не отправлять неподдерживаемые параметры.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  reasoningEffort?: string;
  stop?: string[];
}

/** Возможности протокола/адаптера. */
export interface Capabilities {
  text: boolean;
  systemMessages: boolean;
  streaming: boolean;
  jsonMode: boolean;
  structuredOutput: boolean;
  tools: boolean;
  images: boolean;
  temperature: boolean;
  topP: boolean;
  frequencyPenalty: boolean;
  presencePenalty: boolean;
  seed: boolean;
  reasoningEffort: boolean;
  maxOutputTokens: boolean;
  usageReporting: boolean;
  modelListing: boolean;
}

export interface LLMRequest {
  messages: ChatMessage[];
  model: string;
  params?: GenerationParams;
  /** Просим вернуть строгий JSON. Адаптер применит лучший доступный способ. */
  json?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  operation?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** true — провайдер не сообщил usage, значения оценены. */
  estimated: boolean;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: TokenUsage;
  finishReason: string;
  durationMs: number;
  raw?: unknown;
}

export interface ProviderConnection {
  baseUrl: string;
  apiKey: string;
  protocol: string;
  customHeaders: Record<string, string>;
  organizationId: string;
  timeoutMs: number;
  extra: Record<string, unknown>;
}

export interface Adapter {
  readonly protocol: string;
  readonly label: string;
  readonly capabilities: Capabilities;
  complete(connection: ProviderConnection, request: LLMRequest): Promise<LLMResponse>;
  listModels?(connection: ProviderConnection, signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextLength?: number;
  /** Неизвестные возможности не предполагаются: остаются undefined. */
  supportsTools?: boolean;
  raw?: unknown;
}

export interface RouteResolution {
  operation: string;
  providerId: string;
  providerName: string;
  providerType: string;
  protocol: string;
  model: string;
  params: GenerationParams;
  fallback?: {
    providerId: string;
    providerName: string;
    protocol: string;
    model: string;
  };
}

export interface LLMCallResult extends LLMResponse {
  route: {
    providerId: string;
    providerName: string;
    model: string;
    fallbackUsed: boolean;
    retries: number;
  };
}
