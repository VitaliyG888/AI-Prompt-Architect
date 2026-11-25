/**
 * Адаптер Anthropic Messages API.
 * System-сообщения передаются отдельным полем system; max_tokens обязателен.
 */
import { httpJson } from '../../core/http.ts';
import { AppError } from '../../core/errors.ts';
import type { Adapter, Capabilities, LLMRequest, LLMResponse, ModelInfo, ProviderConnection } from '../types.ts';
import { BASE_CAPABILITIES, authHeaders, estimateUsage, splitSystem } from './shared.ts';

const capabilities: Capabilities = {
  ...BASE_CAPABILITIES,
  systemMessages: true,
  streaming: true,
  tools: true,
  frequencyPenalty: false,
  presencePenalty: false,
  seed: false,
  modelListing: true,
};

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function buildAnthropicBody(request: LLMRequest) {
  const { system, rest } = splitSystem(request.messages);
  const params = request.params ?? {};
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? params.maxOutputTokens ?? 4096,
    messages: rest.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    })),
  };
  if (system.length) body.system = system.join('\n\n');
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.stop?.length) body.stop_sequences = params.stop;
  if (request.json) {
    // Безопасный способ получить JSON: явная инструкция + prefill не нужен.
    body.system = `${system.join('\n\n')}\n\nRespond with a single valid JSON value and nothing else.`;
  }
  return body;
}

export const anthropicAdapter: Adapter = {
  protocol: 'anthropic-messages',
  label: 'Anthropic Messages',
  capabilities,
  async complete(connection: ProviderConnection, request: LLMRequest): Promise<LLMResponse> {
    const base = connection.baseUrl.endsWith('/v1') ? connection.baseUrl : `${connection.baseUrl}/v1`;
    const { data, durationMs } = await httpJson<AnthropicResponse>(`${base}/messages`, {
      method: 'POST',
      headers: authHeaders(connection),
      body: buildAnthropicBody(request),
      timeoutMs: request.timeoutMs ?? connection.timeoutMs,
      signal: request.signal,
      label: 'Anthropic',
    });

    const text = (data.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
      .trim();
    if (!text) throw new AppError('UPSTREAM_ERROR', 'Anthropic вернул пустой ответ');

    const usage = data.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          estimated: false,
        }
      : estimateUsage(request.messages, text);

    return {
      text,
      model: data.model ?? request.model,
      usage,
      finishReason: data.stop_reason ?? 'end_turn',
      durationMs,
      raw: data,
    };
  },
  async listModels(connection: ProviderConnection, signal?: AbortSignal): Promise<ModelInfo[]> {
    const base = connection.baseUrl.endsWith('/v1') ? connection.baseUrl : `${connection.baseUrl}/v1`;
    const { data } = await httpJson<{ data?: Array<{ id?: string; display_name?: string }> }>(
      `${base}/models`,
      {
        method: 'GET',
        headers: authHeaders(connection),
        timeoutMs: Math.min(connection.timeoutMs, 30_000),
        signal,
        label: 'Anthropic',
      },
    );
    return (data.data ?? [])
      .filter((item): item is { id: string; display_name?: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, label: item.display_name }));
  },
};
