/**
 * Адаптер OpenAI Chat Completions API.
 * Покрывает OpenAI, OpenRouter, OmniRoute и любые совместимые шлюзы.
 */
import { httpJson } from '../../core/http.ts';
import { AppError } from '../../core/errors.ts';
import type {
  Adapter,
  Capabilities,
  LLMRequest,
  LLMResponse,
  ModelInfo,
  ProviderConnection,
} from '../types.ts';
import {
  BASE_CAPABILITIES,
  authHeaders,
  estimateUsage,
  pickSupported,
  splitSystem,
} from './shared.ts';

const capabilities: Capabilities = {
  ...BASE_CAPABILITIES,
  systemMessages: true,
  streaming: true,
  jsonMode: true,
  tools: true,
  seed: true,
  reasoningEffort: true,
  modelListing: true,
};

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function buildOpenAIChatBody(request: LLMRequest, capabilities: Capabilities) {
  const params = pickSupported(capabilities, request.params, {
    temperature: 'temperature',
    topP: 'topP',
    maxOutputTokens: 'maxOutputTokens',
    frequencyPenalty: 'frequencyPenalty',
    presencePenalty: 'presencePenalty',
    seed: 'seed',
    reasoningEffort: 'reasoningEffort',
    stop: 'text',
  });

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  };

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  const maxTokens = request.maxOutputTokens ?? params.maxOutputTokens;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.seed !== undefined) body.seed = params.seed;
  if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
  if (params.stop?.length) body.stop = params.stop;
  if (request.json) body.response_format = { type: 'json_object' };

  return body;
}

export function parseOpenAIChatResponse(
  data: ChatCompletionResponse,
  request: LLMRequest,
  durationMs: number,
): LLMResponse {
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content && !choice?.message?.reasoning_content) {
    throw new AppError('UPSTREAM_ERROR', 'Провайдер вернул пустой ответ');
  }
  const text = content || choice?.message?.reasoning_content || '';
  const usage = data.usage
    ? {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
        estimated: false,
      }
    : estimateUsage(request.messages, text);
  return {
    text,
    model: data.model ?? request.model,
    usage,
    finishReason: choice?.finish_reason ?? 'stop',
    durationMs,
    raw: data,
  };
}

export const openaiChatAdapter: Adapter = {
  protocol: 'openai-chat',
  label: 'OpenAI Chat Completions',
  capabilities,
  async complete(connection: ProviderConnection, request: LLMRequest): Promise<LLMResponse> {
    // Для совместимых шлюзов system-сообщения обычно поддерживаются, но
    // при явном отключении объединяем их с первым пользовательским.
    let messages = request.messages;
    if (connection.extra.mergeSystem === true) {
      const { system, rest } = splitSystem(messages);
      messages =
        system.length === 0
          ? rest
          : [{ role: 'user', content: system.join('\n\n') }, ...rest];
    }

    const { data, durationMs } = await httpJson<ChatCompletionResponse>(
      `${connection.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: authHeaders(connection),
        body: buildOpenAIChatBody({ ...request, messages }, capabilities),
        timeoutMs: request.timeoutMs ?? connection.timeoutMs,
        signal: request.signal,
        label: 'OpenAI-compatible',
      },
    );
    return parseOpenAIChatResponse(data, { ...request, messages }, durationMs);
  },
  async listModels(connection: ProviderConnection, signal?: AbortSignal): Promise<ModelInfo[]> {
    const { data } = await httpJson<{ data?: Array<{ id?: string; context_length?: number }> }>(
      `${connection.baseUrl}/models`,
      {
        method: 'GET',
        headers: authHeaders(connection),
        timeoutMs: Math.min(connection.timeoutMs, 30_000),
        signal,
        label: 'OpenAI-compatible',
      },
    );
    if (!Array.isArray(data.data)) {
      throw new AppError('UNSUPPORTED_FEATURE', 'Endpoint /models не вернул список моделей');
    }
    return data.data
      .filter((item): item is { id: string; context_length?: number } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, contextLength: item.context_length }));
  },
};
