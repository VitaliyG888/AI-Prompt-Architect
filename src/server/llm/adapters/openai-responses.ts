/**
 * Адаптер OpenAI Responses API (/responses).
 * Используется, когда пользователь явно выбрал этот протокол.
 */
import { httpJson } from '../../core/http.ts';
import { AppError } from '../../core/errors.ts';
import type { Adapter, Capabilities, LLMRequest, LLMResponse, ModelInfo, ProviderConnection } from '../types.ts';
import { BASE_CAPABILITIES, authHeaders, estimateUsage, splitSystem } from './shared.ts';

const capabilities: Capabilities = {
  ...BASE_CAPABILITIES,
  systemMessages: true,
  streaming: true,
  jsonMode: true,
  structuredOutput: true,
  tools: true,
  seed: true,
  modelListing: true,
};

interface ResponsesApiResponse {
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  status?: string;
  incomplete_details?: { reason?: string };
}

function extractText(data: ResponsesApiResponse): string {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

export const openaiResponsesAdapter: Adapter = {
  protocol: 'openai-responses',
  label: 'OpenAI Responses API',
  capabilities,
  async complete(connection: ProviderConnection, request: LLMRequest): Promise<LLMResponse> {
    const { system, rest } = splitSystem(request.messages);
    const input = rest.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
    }));

    const params = request.params ?? {};
    const body: Record<string, unknown> = {
      model: request.model,
      input,
    };
    if (system.length) body.instructions = system.join('\n\n');
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;
    const maxTokens = request.maxOutputTokens ?? params.maxOutputTokens;
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
    if (params.seed !== undefined) body.seed = params.seed;
    if (params.reasoningEffort) body.reasoning = { effort: params.reasoningEffort };
    if (request.json) body.text = { format: { type: 'json_object' } };

    const { data, durationMs } = await httpJson<ResponsesApiResponse>(`${connection.baseUrl}/responses`, {
      method: 'POST',
      headers: authHeaders(connection),
      body,
      timeoutMs: request.timeoutMs ?? connection.timeoutMs,
      signal: request.signal,
      label: 'OpenAI Responses',
    });

    const text = extractText(data);
    if (!text) throw new AppError('UPSTREAM_ERROR', 'Провайдер вернул пустой ответ');
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
      finishReason: data.status ?? 'completed',
      durationMs,
      raw: data,
    };
  },
  async listModels(connection: ProviderConnection, signal?: AbortSignal): Promise<ModelInfo[]> {
    const { data } = await httpJson<{ data?: Array<{ id?: string }> }>(`${connection.baseUrl}/models`, {
      method: 'GET',
      headers: authHeaders(connection),
      timeoutMs: Math.min(connection.timeoutMs, 30_000),
      signal,
      label: 'OpenAI Responses',
    });
    return (data.data ?? [])
      .filter((item): item is { id: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id }));
  },
};
