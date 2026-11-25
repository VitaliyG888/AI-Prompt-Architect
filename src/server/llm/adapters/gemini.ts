/**
 * Адаптер Google Gemini API (generateContent).
 * Роли: user/model; system — через systemInstruction.
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
  frequencyPenalty: false,
  presencePenalty: false,
  seed: false,
  reasoningEffort: true,
  modelListing: true,
};

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

export function buildGeminiBody(request: LLMRequest) {
  const { system, rest } = splitSystem(request.messages);
  const params = request.params ?? {};
  const body: Record<string, unknown> = {
    contents: rest.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
  };

  if (system.length) {
    body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  }

  const generationConfig: Record<string, unknown> = {};
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
  if (params.topP !== undefined) generationConfig.topP = params.topP;
  const maxTokens = request.maxOutputTokens ?? params.maxOutputTokens;
  if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
  if (params.stop?.length) generationConfig.stopSequences = params.stop;
  if (request.json) generationConfig.responseMimeType = 'application/json';
  if (params.reasoningEffort) {
    generationConfig.thinkingConfig = {
      thinkingBudget: params.reasoningEffort === 'high' ? 8192 : params.reasoningEffort === 'low' ? 1024 : 4096,
    };
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  return body;
}

export const geminiAdapter: Adapter = {
  protocol: 'gemini',
  label: 'Google Gemini',
  capabilities,
  async complete(connection: ProviderConnection, request: LLMRequest): Promise<LLMResponse> {
    const base = connection.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const model = request.model.replace(/^models\//, '');
    const { data, durationMs } = await httpJson<GeminiResponse>(
      `${base}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: authHeaders(connection),
        body: buildGeminiBody(request),
        timeoutMs: request.timeoutMs ?? connection.timeoutMs,
        signal: request.signal,
        label: 'Gemini',
      },
    );

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) throw new AppError('UPSTREAM_ERROR', 'Gemini вернул пустой ответ');

    const usage = data.usageMetadata
      ? {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          estimated: false,
        }
      : estimateUsage(request.messages, text);

    return {
      text,
      model: data.modelVersion ?? request.model,
      usage,
      finishReason: candidate?.finishReason ?? 'STOP',
      durationMs,
      raw: data,
    };
  },
  async listModels(connection: ProviderConnection, signal?: AbortSignal): Promise<ModelInfo[]> {
    const base = connection.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const { data } = await httpJson<{
      models?: Array<{
        name?: string;
        displayName?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    }>(`${base}/models`, {
      method: 'GET',
      headers: authHeaders(connection),
      timeoutMs: Math.min(connection.timeoutMs, 30_000),
      signal,
      label: 'Gemini',
    });
    return (data.models ?? [])
      .filter((item): item is { name: string } => typeof item.name === 'string')
      .filter((item) => {
        const methods = (item as { supportedGenerationMethods?: string[] }).supportedGenerationMethods;
        return !methods || methods.includes('generateContent');
      })
      .map((item) => ({
        id: item.name.replace(/^models\//, ''),
        label: (item as { displayName?: string }).displayName,
        contextLength: (item as { inputTokenLimit?: number }).inputTokenLimit,
      }));
  },
};
